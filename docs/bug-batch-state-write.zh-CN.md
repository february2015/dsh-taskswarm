# Bug 报告：abort 后批次状态写入错乱（旧批次文件被续写、新批次显示永远 0）

> 日期：2026-08-15 ｜ 仓库：`dsh-taskswarm`（本仓库）｜ 严重度：高（显示/簿记错乱，实际产物安全）
> 现场证据位于：`/Users/robin/myProject/dsh-localvoice/.taskswarm/batches/`（dsh-localvoice 项目批次现场）
> 本文件为**独立交接文档**——供另一位开发者（全新对话，无本会话上下文）直接接手修复。
> **状态：✅ 已修复（2026-08-15，commit `92cf912`）——本文件存档备查；修复含 abortWaiter 中断在途 worker、run() 并发保护、runLane 查 abort、updateLane 终态防御、execute 波次写回尊重磁盘终态，`0.2.18` 发布。**


---

## 1. 症状（用户可感知）

对同一仓库执行 **`abort` 后立刻 `start` 新批次**，随后：

1. **新批次的状态文件不再更新**：`b-msu3g6en-4c5aec.json` 自创建后 mtime 不再变化，lane 永远停在
   `running ['starting T-x']`，`/tswarm-status` 与 dashboard 永远显示 **"0 lanes done"**；
2. **旧（已 abort）批次的状态文件被续写**：`b-msu0oo9b-dc565b.json`（phase=aborted）在 abort 之后
   很久又被写入 lane 完成状态（本次：abort 于 ~16:02，旧文件 mtime 变为 16:30，新增
   `T-7 merged ['starting T-7','worker exited 0','lane merged']`）；
3. worker 实际照常干活、产物照常 merge 进 `taskswarm/orch`（本次 T-7 的 commit `2cb9eef` 真实落地），
   **交付不受影响**，但进度显示/状态簿记完全不可信；
4. 附带现象：每个 lane 的 worker 会话目录下出现多个 session（主 worker + 多个 reviewer / 疑似重复 spawn）；
   abort 后 supervisor 仍陆续收到旧批次的 wave 事件（如 "Wave 3/5 完成：1 成功 / 1 失败"）。

## 2. 现场证据（本机实测）

```
$ ls -la /Users/robin/myProject/dsh-localvoice/.taskswarm/batches/
b-msu0oo9b-dc565b.json   16:30   ← 旧批次（aborted），abort 后 28 分钟被更新
b-msu3g6en-4c5aec.json   16:08   ← 新批次（running），创建后从未再更新
```

旧批次文件（abort 后仍被写入）：
```json
"id": "b-msu0oo9b-dc565b", "phase": "aborted",
lanes: [ T-1 merged, T-2 merged, T-3 merged, T-5 failed,
         T-4 running ['starting T-4'],
         T-6 running ['starting T-6'],
         T-7 merged ['starting T-7','worker exited 0','lane merged'],   ← 属于新批次的完成，写进了旧文件
         T-8 pending ]
```

新批次文件（永远 0 进度）：
```json
"id": "b-msu3g6en-4c5aec", "phase": "running",
lanes: [ T-4 running ['starting T-4'], T-6 running ['starting T-6'],
         T-7 running ['starting T-7'], T-8 pending ]
```

`taskswarm/orch` 真实接收了 T-7 产物：`2cb9eef taskswarm: T7 done — T-7 全局插播通知完成…`

## 3. 根因分析（代码级，按可能性排序）

### 3.1 `abort()` 不终止当前波次的在途 lane 执行（主因）

`src/orchestrator/engine.ts`：

- `execute()`（约 L201）只在**波次边界**检查 `ctx.aborted`（L214-219）：
  ```ts
  while (ctx.paused && !ctx.aborted) await sleep(250)
  if (ctx.aborted) { state.phase = 'aborted'; writeBatchState(state); return }
  const lanes = await Promise.all(wave.map((task) => this.runLane(ctx, state, task)))  // ← 在途 lane 不取消
  ```
  abort 发生时若 `Promise.all(...)` 已在途，**这些 runLane 不会停**。
- `runLane()`（约 L257）全程**不检查 `ctx.aborted`**：即使 abort 已把 worktree 删了
  （`removeAllLaneWorktrees`），runLane 仍会 `createLaneWorktree` **重新创建 worktree**（L279）并
  spawn 新 worker，最终跑完 → `updateLane(state.stateRoot, batchId, lane)`（L288/292）用**旧 batchId**
  把完成状态写进**旧批次文件**。
- `abort()`（约 L510）只做三件事：置 `ctx.aborted=true`、写磁盘 phase=aborted、`host.abort(-1)` 杀
  worker、删 worktree——**不取消在途 execute() promise 链**。`host.abort` 对 InProcess 宿主疑似无法
  终止"回合中"的 agent（本次旧 T-7 lane 事后拿到 `worker exited 0` 即旁证）。

### 3.2 `start()`/`run()` 不阻止与"未收尾的 aborted 上下文"并发（次因）

- 引擎实例按 repoRoot 单例缓存（`src/orchestrator/index.ts` `engines` Map，`if (cached) return cached`），
  新旧批次跑在**同一个 TaskSwarmEngine 实例**。
- `run()`（engine.ts L162）不检查 `this.active` 是否仍有活着的上下文；磁盘 phase=aborted 是终态，
  start 保护放行 → 新 execute() 与旧 execute() **并发运行**，共用同一 repoRoot 的 worktree 路径与
  task 目录，互相覆盖（会话/STATUS/worktree 均受影响）。

### 3.3 `updateLane` 不校验批次终态（放大因素）

`src/core/status.ts` L65：
```ts
export function updateLane(stateRoot, batchId, lane) {
  const state = readBatchState(stateRoot, batchId)   // 不检查 state.phase 是否 terminal
  ...writeBatchState(state)
}
```
aborted/complete 批次仍可被写入 lane 状态——所以"已 abort 的批次文件"能被事后续写。

### 3.4 `latestBatch()` 按文件名字典序取最后（显示层）

`src/core/status.ts` L76：`readdirSync(...).sort()` 取最后一个。`b-msu0oo9b…` < `b-msu3g6en…`，
返回新批次 → supervisor/dashboard 读新批次文件 → 永远 0/4。**注意**：这本身不算 bug（语义就是"最新
批次"），真正的问题是 3.1/3.2 导致新批次文件从不更新、旧文件被续写。

## 4. 修复建议

1. **让 abort 真正终止在途工作**：给 `execute()`/`runLane()` 注入 `AbortSignal`（或每批次 AbortController）；
   - `runLane` 在 `createLaneWorktree` **之前**与 spawn **之前**检查 abort，abort 后不再建 worktree/不再
     spawn，直接标记 lane failed/skipped 并收尾；
   - `host.abort()` 必须真正终止"回合中"的 agent 会话（InProcessHost 检查 abort 实现）；
   - `abort()` 同时 cancel signal，让 `Promise.all` 快速失败。
2. **`run()` 增加并发保护**：启动新批次前检查 `this.active` 是否仍有未收尾上下文（旧 execute() 的
   `.finally` 未跑完），有则拒绝/排队/先等它 settle；或要求 abort 后等旧上下文彻底结束。
3. **`updateLane` 防御**：读取到的批次 `phase ∈ {aborted, complete}` 时拒绝写入 lane 状态（防止复活
   终态批次文件）。
4. **验证方式**：复现步骤见 §5；修复后 abort→立刻 start，应满足：新批次文件随 lane 进度正常更新、
   旧批次文件 mtime 不再变化、`/tswarm-status` 不再卡 0、无重复 spawn（每 lane 仅 1 个主 worker 会话）。

## 5. 复现步骤

1. 任一 git 仓库，放 tasks/T-1、T-2 两个任务包（T-2 依赖 T-1，使存在多波次）；
2. `start all` → 等 wave 1（T-1）跑到一半 → `abort`；
3. 立刻 `start all`（或指定 scope）；
4. 观察：旧批次文件被续写 / 新批次文件 mtime 不动 / status 卡 0 / 会话重复。

## 6. 次要观察（可一并处理，非本 bug 必需）

- **检查点纪律**：worker 全程不调用 `task_runner advance`（T-7 一口气干完直接 `done`），导致
  STATUS.md 步骤不勾、进度显示 0 直接跳 100%。可在 worker mission 强化"每完成一个 Step 的 checkbox
  就 advance"，或 watchdog 对长时间无 advance 的 lane 提示。
- worker 会直接改写 `tasks/T*/STATUS.md`（绕过 advance 工具），引擎以 STATUS 判定 done，可接受但
  与 4.1 的"任务包格式"校验精神不一致，可考虑校验 STATUS 变更来源。

## 7. 相关代码位置索引

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/orchestrator/engine.ts` | L162 `run()` | 无 active 上下文并发保护 |
| `src/orchestrator/engine.ts` | L201-245 `execute()` | abort 只在波次边界检查，在途 lane 不取消 |
| `src/orchestrator/engine.ts` | L257-300 `runLane()` | 全程不查 abort；abort 后仍建 worktree/spawn |
| `src/orchestrator/engine.ts` | L510 `abort()` | 只置标志+杀 worker+删 worktree，不取消 promise 链 |
| `src/orchestrator/engine.ts` | L408-445 `runLaneWorker()` | 看门狗与 host.abort 调用 |
| `src/core/status.ts` | L65 `updateLane()` | 不校验批次终态 |
| `src/core/status.ts` | L76 `latestBatch()` | 字典序取最新（显示层来源） |
| `src/orchestrator/index.ts` | L159/207/302 | engines 单例缓存 |
