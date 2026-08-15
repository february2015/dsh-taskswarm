# Bug 报告：worker 不推进 STATUS/检查点 → 进度显示滞后（百分比 0→100% 跳变）

> 日期：2026-08-15 ｜ 仓库：`dsh-taskswarm`（本仓库）｜ 严重度：中（显示误导，不影响交付）
> 现场证据：dsh-localvoice 项目批次 b-msu3g6en（T-4/T-6/T-7 三 lane 并行期）
> 本文件为**独立交接文档**——供另一位开发者（全新对话，无本会话上下文）直接接手修复。

---

## 1. 症状（用户可感知）

dashboard / `/tswarm-status` 的**每个 lane 的百分比进度**（= `tasks/<ID>/STATUS.md` 里
`- [ ]` checkbox 勾选数 ÷ 总数）与实际代码进度严重脱节：

1. **运行中百分比长时间停在低值**：T-6 实际代码早已全部写完（一次提交 `581867d` 覆盖
   FR-4.1~4.9，17 个文件），STATUS.md 却只勾了 1/7（14%），直到收尾时才批量补勾跳到 100%；
2. **0 → 100% 跳变**：T-7 全程不调用 `task_runner advance`，一口气写完（256 测试通过）再
   直接 `done`——进度显示没有任何中间值；
3. **worker 直接改写 STATUS.md 绕过 advance 工具**：T-7 worker 会话日志显示它认为
   "task_runner says task has no steps"（误读格式），改为**手写** STATUS.md 为 ✅；
4. **无增量检查点提交**：T-6/T-7 的 lane worktree 在完成前**没有 commit**（全部改动攒到最后
   一次提交）——崩溃/中断时进度与产物只能靠最后一次提交抢救。

## 2. 现场证据（本机实测）

```
# T-6：worker 已提交全部 FR-4 代码，但 STATUS 仍显示 1/7（仅 Step 1 勾选）
$ git -C .taskswarm/worktrees/t-6 log --oneline -1
581867d T-6: 打断与语速控制 — barge-in + FR-4 控制命令 + 语速双通道（FR-4.1~4.9）
$ grep -c '^- \[x\]' tasks/T6/STATUS.md      # → 1（Step 2/3 全未勾）
$ grep -c '^- \[ \]' tasks/T6/STATUS.md      # → 6

# T-7 worker 会话：绕过 advance，手写 STATUS
"task_runner says 'task has no steps' for advance — the STATUS.md is a flat markdown checklist…"
→ 直接 write STATUS.md（**Status:** ✅ Complete）+ task_runner done
```

## 3. 根因分析

1. **worker mission 不强制"逐步 advance"**：`src/worker/lane-tools.ts` 的 `buildWorkerMission`
   只说 "Drive the task with the task_runner tool: advance … done"，没有**硬性要求每完成一个
   checkbox 就 advance（并触发检查点 commit）**。worker（LLM）倾向于攒批处理。
2. **无"长时间无 advance"的检测**：引擎的看门狗（`laneTimeoutMinutes`）只防"完全失联"，
   不防"一直在干活但不推进 STATUS"——所以这种滞后不报错、不提醒。
3. **STATUS.md 可被 worker 直接写**：`tasks/<ID>/STATUS.md` 是普通文件，worker 可绕过
   `task_runner` 手改；引擎只按最终 STATUS 判定 done，不校验变更来源。
4. **进度显示只读 STATUS checkbox**：dashboard 的百分比没有备用数据源（如按检查点 commit 数），
   worker 不勾就永远显示低值/0。

## 4. 修复建议（按性价比排序）

1. **worker mission 强化**（`src/worker/lane-tools.ts` `buildWorkerMission`）：明确硬性规则——
   "每完成一个 checkbox 立即 `task_runner advance`（该调用会自动做检查点 commit）；禁止攒批到
   最后统一勾选；`done` 只允许在全部 Completion Criteria 满足后调用"。措辞用祈使句 + 禁止项。
2. **看门狗补充"advance 停滞"检测**：`runLaneWorker` 的看门狗除总超时外，增加"距上次
   `advance`（STATUS.md checkbox 变化 / 检查点 commit）超过 N 分钟仍在 running"的提醒/告警
   （可复用 supervisor 的 stalled 检测，把"STATUS 无变化"纳入指纹）。
3. **STATUS 变更来源校验（可选，较严）**：引擎在 lane 结束时对比 `tasks/<ID>/STATUS.md` 与
   `Execution Log`（advance 记录）——若 STATUS 有勾选但无对应 advance log，记 warning 供
   supervisor 检查（不做硬失败，避免误伤）。
4. **进度显示加兜底数据源（可选）**：dashboard 的百分比在 STATUS 停滞时可叠加
   "检查点 commit 数 / 总步数" 作为参考进度。

## 5. 复现步骤

1. 任一仓库放一个 **Size L** 任务包（多个 Step，每 Step 多个 checkbox）；
2. `start` 该任务；观察 dashboard 的 lane 百分比；
3. worker 大概率在 10~30 分钟内把代码全写完但 STATUS 只勾 1~2 项（百分比低）；
4. 收尾时（或从不）批量勾选 → 百分比突然跳到 100%。

## 6. 相关代码位置索引

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/worker/lane-tools.ts` | `buildWorkerMission` | worker 任务书（缺逐步 advance 硬性要求） |
| `src/worker/lane-tools.ts` | `task_runner`（advance/done） | 勾选工具本身工作正常，问题在"不调用" |
| `src/core/task.ts` | `advanceStep` / `markTaskDone` | 勾选/完成标记（工具侧无需改） |
| `src/orchestrator/engine.ts` | `runLaneWorker` 看门狗 | 只有总超时，无 advance 停滞检测 |
| `src/orchestrator/supervisor.ts` | stalled 检测 | 现用 `taskId:phase` 指纹，可加 STATUS 变化 |
| dashboard | 每 lane 百分比 | 只读 STATUS checkbox |
