# 未解决问题 / Known Issues

> 本文件记录 dsh-buju 已知但尚未修复的问题。每条含现象、根因、相关代码位置与候选修复方案。
> 规则：修复后把条目移到 `RESOLVED` 区并注明修复版本/commit。

## OPEN

（当前无 OPEN 条目——截至 2026-08-14 已记录的已知问题全部修复，见下方 RESOLVED 区。
新增问题请按上述格式追加到本区。）

---

## RESOLVED

<!-- 修复后把条目移到这里，注明修复版本/commit。 -->

### KI-007: 引擎按 wave 推进且内存状态不重读——lane 全 merged 后后续 wave 不调度，只能重启引擎

- **状态:** ✅ 已修复（v0.1.1 工作区，重启生效；2026-08-14 批次 `b-mss7l7sm-4217b2` 实测）
- **发现日期:** 2026-08-14
- **现象:** 批次 wave 1 全部 lane merged（含手动标记的失联 lane）后，wave 2 及后续 lane
  长时间 `pending`、无 worker 启动、并行度空转；`plan` 已正确重排剩余任务（引擎读到了新
  状态），但就是不调度；改 `.buju/batches/*.json` 的 lane phase 不生效；`start` 因批次
  phase=running 拒绝开新批次。唯一恢复手段是重启 DSH 引擎（新开会话）。
- **根因（代码级确认）:** `engine.ts` `execute()` 顺序遍历 wave，wave 内
  `Promise.all(wave.map(runLane))` 并行；`runLane()` 第 270 行 `await config.host.spawn(spec)`
  **无超时**——worker 失联/事件丢失时该 await 永不返回 → execute 卡死在当前 wave →
  后续 wave 永不启动（不是"wave 判定不读盘"，而是 execute 的 await 挂起）。
- **修复说明（方案 B 看门狗超时）:**
  - `engine.ts` 新增 `runLaneWorker()`：对 `host.spawn()` 包 `Promise.race` 超时
    （`laneTimeoutMinutes`，默认 90 分钟，可配置；0 = 禁用）。超时先 `host.abort(lane)`
    杀掉僵尸 worker，再返回 `{ exitCode: 1, error: 'lane timeout...' }` → runLane 正常收尾
    （phase=failed，worktree/分支保留供排查）→ execute 继续下一 wave。**不再需要重启引擎。**
  - `index.ts` `Config` 新增 `laneTimeoutMinutes`（默认 90）并传入 `EngineConfig`。
  - **方案 A（reconcile）经分析由 B 覆盖**：execute 顺序执行 wave、无"判定"步骤，卡点是
    spawn await 无超时；超时解决后手动标记的 lane 会在下一 wave 推进时被天然跳过
    （`select()` 默认排除已 done 任务，`.DONE` 标记即续跑依据）。不再单独实现 A。
  - **方案 C（lane 级状态修正工具）未做**（可选）：`buju_supervisor_control` 的 `abort`
    工具已加**批次级防误伤提示**（scope 非空时明确"abort 是批次级、scope 不生效"并拒绝，
    防止误 abort 整批），单 lane 释放走 runbook §7.6 手动收尾 + 重启（有 B 后无需重启）。
- **临时 workaround（修复前）:** runbook §7.6（手动收尾保住代码 → 标记 merged → 重启引擎）。
- **配置：** `.buju/config.json` 或插件 Config 设 `laneTimeoutMinutes`（分钟）。

---

### KI-005: worker 直写任务包文件触发沙箱审批

- **状态:** ✅ 已修复（worker 级权限注入，v0.1.1 工作区，重启生效）
- **发现日期:** 2026-08-14（批次 `b-msrtvf7c-cea399` 运行中）
- **现象:** worker 用 fs 工具直接写主仓库 `tasks/*/STATUS.md`（任务包在 lane worktree
  之外）时，沙箱拦截并弹「等待审批」。
- **根因:** worker 会话沙箱工作区 = lane worktree；任务包在主仓库。task_runner
  走进程内 node:fs 不受限（所以 advance 正常），fs 工具走沙箱被拦。
- **修复说明:** `src/worker/worker-tools.ts` 新增 `grantWorkerFullAccess()`——在
  worker/reviewer 的 `agents.create` setup 里往**worker 自己的会话**追加
  `sandbox/mode`（danger-full-access）+ `approval/policy`（never）事件（DSH 子代理
  delegation 机制，与 `dsh-subagent` 的 `appendDelegatedPolicyOverrides` 同源）。
  效果：worker 单独 full access + 免审批；GUI 会话与全局 profile 配置完全不动，
  不依赖 `DSH_PERMISSION_MODE` 环境变量。已实测：
  `sandbox overrideOf(worker)="danger-full-access"`、`approval effective="never"`。
- **备注:** 曾尝试 env（`DSH_PERMISSION_MODE=danger-full-access`）与 profile 全局
  覆盖（`~/.dsh/profiles/web/cordis.patch.yml`）两条路，均会改动全局行为，已放弃
  并还原配置；worker 级注入为最终方案。

---

### KI-006: 缺少 supervisor 通知——worker 完成不会自动出现在聊天会话

- **状态:** ✅ 核心闭环已实现（对话式 supervisor，TaskPlane 移植）；审计/CI 部分延后
- **发现日期:** 2026-08-14（批次 `b-msrtvf7c-cea399` 跑通后与用户讨论）
- **差距（原）:** TaskPlane 有对话式 supervisor agent 与 operator 共享聊天会话，
  实时汇报 worker 进度并请求确认；Buju 移植时只移植了 mailbox 存储，
  `engine.ts` 收尾仅 `drainInbox` 丢弃消息——用户只能靠 `/orch-status` 手动查。
- **实现（v0.1.1 工作区，重启生效）:** `src/orchestrator/supervisor.ts`（TaskPlane
  supervisor.ts 移植，DSH 化）：
  - `requiresConfirmation()` 与 `ACTION_CLASSIFICATION_EXAMPLES` 原样移植；
    动作分三类 diagnostic / tier0_known / destructive，按自主度
    （interactive / supervised / autonomous）决定是否先征求 operator 确认
  - 会话 agent 即 supervisor：注入 supervisor 系统提示 + 两个工具
    （`buju_supervisor_status` 诊断、`buju_supervisor_control` 控制）
  - 引擎发出结构化事件（batch-started / lane-failed / lane-revise /
    batch-complete / batch-aborted）；决策类事件**唤醒**会话 agent
    （`followup`），agent 查证 → 分类动作 → 执行或先问 operator
  - 配置：插件 `supervisorMode`（默认 supervised）
- **延后（TaskPlane 全量 4.7k 行的其余部分）:** 审计轨迹 JSONL
  （actions.jsonl/events.jsonl）、分支保护检测、CI/PR 生命周期、批次摘要
  markdown 模板。事件契约已就位，可在此基础上增量补齐。

---

### KI-004: 进程被杀/abort 后残留 lane worktree 与分支，阻塞下一次 batch

- **状态:** ✅ 已修复（源码；`src/core/worktree.ts` `createLaneWorktree`）
- **发现日期:** 2026-08-14（新 batch `b-msrtspik-47088e` 全部 lane `could not create lane worktree`）
- **现象:** 旧 batch 的进程被 kill 后，`buju/<taskId>` 分支与 lane worktree 目录残留；
  新 batch 的 `git worktree add -b buju/<taskId>` 因分支已存在而失败，所有 lane 秒败。
- **修复说明:** `createLaneWorktree` 现在先移除残留 worktree 目录（失败则 `prune`），
  且当 `buju/<taskId>` 分支已存在时改用 `git worktree add <branch> <dir>`（附着既有分支）
  而非 `-b`（新建）。下次 dsh web 重启后生效。
- **备注:** 失败 lane 的 worktree/分支仍保留供排查（引擎既有设计），但不再阻塞后续 batch。

---

### KI-001: worker/reviewer 会话出现在 GUI 侧边栏「未分组」里

- **状态:** ✅ 已修复（v0.1.1 工作区，重启生效）
- **修复版本:** v0.1.1（未发版，工作区修复）
- **修复说明:** ① worker/reviewer 的
  `agents.create()` 加 `meta.origin: 'subagent'`（侧边栏自动隐藏内部会话）；
  ② 完成后 `dispose()` 会话（不再残留内存与 `~/.dsh/sessions/`）。
- **发现日期:** 2026-08-14
- **发现方式:** 在 dsh web（GUI）会话里跑 `/orch all` 后，侧边栏「未分组」出现 3 个会话（lane worker + reviewer），与本会话混在一起。
- **触发批次:** `b-msrszf33-d79cf6`（2026-08-14 01:39，6 lane / 4 wave）

#### 现象

- `/orch` 启动 batch 后，in-process worker / reviewer 会话出现在 GUI 侧边栏的「未分组」（Ungrouped）分组下。
- 会话无标题（`session-<uuid>`），看不出属于哪个 lane / 任务 / 批次。
- 侧边栏被内部会话污染；用户自己的会话与 worker 会话混杂。

#### 根因（代码级）

1. GUI 侧边栏按 **Host Workspace** 分组（`@deepseek-ai/dsh-client-ui-workspace`）：会话归属由其 header 的 `cwd` 决定（`dsh-workspace` 的 `sessionIds` = `host.sessionPath(id) === record.path`）。
2. Buju worker 会话的 `cwd` 是 lane worktree（`.buju/worktrees/<taskId>`），这是瞬态 git worktree，没有对应 workspace 记录 → 所有 worker 会话落入「未分组」兜底桶（`groupByWorkspace` 的 `stray`）。
3. DSH 内置 **subagent 会话自动隐藏**：侧边栏 `sessionVisible()` 过滤 `session.origin !== 'subagent'`。Buju 创建 agent 时未传 `meta.origin: 'subagent'`，导致这些内部会话暴露在列表里。

#### 相关代码位置

- `src/orchestrator/in-process-host.ts` — `spawn()` 里 `agents.create({ sessionId, meta: { cwd: spec.worktree }, ... })`（**缺 `origin: 'subagent'`**）
- `src/worker/reviewer.ts` — `createReviewerSpawner` 里同样缺 `origin`
- DSH 侧证据：
  - `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` `sessionVisible`: `session.origin !== "subagent" && !archived.has(...)`
  - `@deepseek-ai/dsh-agent` `CreateAgentOptions.meta.origin?: 'subagent'`
  - `@deepseek-ai/dsh-session` `CreateSessionOptions.meta.origin?: 'subagent'`
  - `@deepseek-ai/dsh-workspace` workspace = 规范化目录路径，会话按 header.cwd 归属

#### 候选修复方案

- **方案 A（推荐）:** `InProcessWorkerHost.spawn()` 与 `reviewer.ts` 的 `agents.create()` 增加 `meta: { origin: 'subagent', cwd: worktree, ... }`。效果：worker/reviewer 会话从侧边栏自动隐藏（符合"内部执行者"定位）；进度观察走 `/orch-status` 或未来 dashboard。
  - 代价：worker 会话在 GUI 不可见/不可点击（无法从侧边栏围观 worker），但进程内日志与 `.buju` 状态仍在。
  - 生效条件：`npm run build` + 重启 dsh web 进程；会中断进行中的 batch（in-process host 依赖 web 进程存活）。
- **方案 B（保持现状）:** 不隐藏，接受「未分组」；适合需要从 GUI 点进 worker 会话看过程调试的场景。
- **方案 C（增强，可与 A 叠加）:** 给 worker 会话设置可识别标题（`dsh-session-title` 服务或 meta），即使保留可见也能一眼认出 `lane N · <taskId>`。

#### 复现步骤

1. `cd ~/myProject/dsh-buju && npm run build`
2. dsh web 会话里：`/buju-init` → `/orch all`
3. 观察侧边栏：「未分组」下出现 `session-<uuid>` 会话（数量 = 活跃 worker + reviewer）

#### 备注

- 该问题不影响 batch 执行正确性（`b-msrszf33-d79cf6` 执行正常，lane 状态写入 `.buju/batches/`），纯 UX 问题。
- 与 WEB-005/WEB-006 的 dashboard 规划相关：dashboard 上线后 worker 进度有正式可视化入口，方案 A 的隐藏代价更低。

---

### KI-002: web profile 下 in-process worker 没有 shell/文件工具，任务零产出

- **修复版本:** v0.1.1（未发版，工作区修复）
- **修复说明:** 新增 `src/worker/worker-tools.ts` 的 `mountStandardTools()`，在
  `InProcessWorkerHost.spawn()` 与 reviewer 的 `agents.create()` setup 里，当作用域
  不含 `bash` 工具时把 `dsh-tool-bash` / `dsh-tool-fs` / `dsh-tool-fs-search` /
  `dsh-tool-str-replace-editor` 挂到 agent 作用域（web profile 根层禁用工具行的
  应对；dsh-base profile 下自动跳过，避免重复注册）。已在 web 模拟 profile
  （根层禁用工具行）实测：worker 工具集从「仅 lane 工具」变为含
  `bash/edit/read/write/str_replace_editor`。`npm test` 9/9 通过。
- **触发批次:** `b-msrszf33-d79cf6`（2026-08-14 01:39，6 lane / 4 wave）

#### 现象

- `/orch` 后 wave-1 两个 worker（WEB-001/WEB-002）都无法执行：escalate 消息原文
  「Missing shell/file tooling: I cannot execute commands or modify files to perform the WEB-001 port」，
  lane-2 连续 notify「probing for a shell/filesystem tool to read upstream server.cjs and src/core」。
- 两个 lane worktree（web-001/web-002）自 batch 开始后 **git 状态干净、零 commit、零产物文件**（无 `dashboard/`）。
- 主仓库 STATUS.md 停在「Current Step: Preflight / Not Started」，最后一条 worker 消息后 6 分钟无任何进展。
- 对比：README 记录的 `dsh --profile buju-verify` 沙箱验证中，in-process worker 可正常建文件（该 profile 下 worker 有工具）。

#### 根因

- `registerLaneTools()`（`src/worker/lane-tools.ts`）只注册 4 个桥接工具
  （task_runner / notify_supervisor / escalate_to_supervisor / review_step 等），**不含 shell / 文件系统工具**。
- `InProcessWorkerHost.spawn()`（`src/orchestrator/in-process-host.ts:38-45`）的 `setup` 只调
  `registerLaneTools(agentCtx, lane)`，没有往 worker 作用域挂载 bash/file 工具插件。
- DSH agent 作用域的工具继承在 web profile 与 buju-verify 沙箱 profile 间行为不同：
  沙箱 profile 下 worker 拿到了工具，web profile 下没有（agent 作用域不继承 GUI 会话的每会话工具装配）。

#### 相关代码位置

- `src/worker/lane-tools.ts` — `registerLaneTools()`（仅桥接工具）
- `src/orchestrator/in-process-host.ts` — `spawn()` 的 `setup`（未挂载工具插件）
- `src/worker/runner.ts` — headless worker bundle 的工具组合（对照参考：headless 模式工具全）
- DSH 侧：`@deepseek-ai/dsh-bash-local` 等工具插件；agent 作用域继承规则

#### 候选修复方案

- **方案 A（推荐）:** `InProcessWorkerHost.spawn()` 的 `setup` 里，在 `registerLaneTools` 之外挂载
  bash / filesystem 等标准工具插件（参照 `src/worker/runner.ts` 的 headless 组合方式），保证
  in-process 与 headless 工具集一致。
- **方案 B:** 默认 `host: headless`（`dsh --profile buju-worker` 子进程，自带完整工具）。
- **方案 C:** 查证 web profile 下 agent 作用域工具继承机制，从 DSH 侧解决（若为框架行为差异）。

#### 复现步骤

1. web profile（GUI）会话里 `/buju-init` → `/orch all`
2. 观察 mailbox（`.buju/mailbox/<batch>/supervisor/inbox/`）：worker escalate「Missing shell/file tooling」
3. 检查 lane worktree：无任何产物

#### 备注

- 不影响规划/命令层（plan/status 正常），仅 worker 执行能力问题。
- 与 headless 验证成功（README）不矛盾——工具装配差异仅在特定 profile 组合下暴露。

---

### KI-003: 并发 runLane 的 writeBatchState 覆盖兄弟 lane 状态（状态显示错误）

- **修复版本:** v0.1.1（未发版，工作区修复）
- **修复说明:** 删除 `engine.ts` runLane 里对共享内存陈旧 `state` 的全量
  `writeBatchState(state)`（该写入会覆盖并发兄弟 lane 的 `updateLane` 落盘结果）；
  lane 持久化统一走单 lane 定向的 `updateLane`，天然免竞态。

#### 现象

- 2-lane 并发（wave-1）时，磁盘 `.buju/batches/*.json` 里 lane 1（WEB-001）显示
  `pending` 且无 worktree，但实际其 worktree `web-001` 已创建、worker 会话活着。
- `/orch-status` / dashboard 会因此显示错误的 lane 状态。

#### 根因

- `engine.ts` `runLane()` 第 162 行 `writeBatchState(state)` 把**共享内存中的陈旧 state 对象**整体写盘：
  新 lane 对象（`const lane = {...}`）从未插入 `state.lanes`，该写入实际回退了兄弟 lane 已通过
  `updateLane()` 落盘的进度。
- 并发时序：lane1 `updateLane`（running/web-001）→ lane2 `writeBatchState(state)`（陈旧全 pending）→
  覆盖 → lane2 `updateLane`（running/web-002）。最终 disk = lane1 pending + lane2 running。

#### 相关代码位置

- `src/orchestrator/engine.ts:162` — `writeBatchState(state)`（runLane 早期，写陈旧共享状态）
- `src/orchestrator/engine.ts:176` — `updateLane(...)`（正确写法，但被上面覆盖）
- `src/core/status.ts` — `updateLane` / `writeBatchState` 语义

#### 候选修复方案

- **方案 A（推荐）:** 删除 runLane 中第 162 行的 `writeBatchState(state)`（lane 持久化统一走
  `updateLane`，一次性写入自己的 lane 记录，天然免竞态）。
- **方案 B:** 在 writeBatchState 前先把新 lane 塞进 `state.lanes`（`state.lanes.push(lane)`），使内存
  状态与磁盘一致；但并发写同一文件仍有 last-write-wins 语义，不如方案 A。
- **方案 C:** 全量状态写入改单一写者/串行队列（工程化，后续可做）。

#### 复现步骤

1. 两个任务、无依赖（wave-1 双 lane）
2. `/orch all`
3. 读 `.buju/batches/*.json`：先启动的 lane 可能显示 pending/无 worktree，尽管 worktree 已存在

#### 备注

- 纯状态显示问题，不影响 worker 实际执行；但会影响 /orch-status 与未来 dashboard 的正确性。

---
