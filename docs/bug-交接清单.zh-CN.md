# TaskSwarm 引擎 Bug 交接清单（2026-08-15）

> 仓库：`dsh-taskswarm`（本仓库）｜ 本文件为**唯一交接文档**——供另一位开发者（全新对话，无本会话上下文）
> 直接接手修复。现场证据位于 `/Users/robin/myProject/dsh-localvoice/.taskswarm/` 与
> `~/.dsh/sessions/--Users-robin-myProject-dsh-localvoice-*/`（dsh-localvoice 项目批次现场，2026-08-15）。

---

## 总览

| # | Bug | 严重度 | 状态 |
|---|---|---|---|
| B1 | abort 后立刻 start 的批次簿记错乱（状态写错文件、显示永远 0） | 高 | ✅ 已修复（`92cf912`，v0.2.18） |
| B2 | worker 不推进 STATUS/检查点 → 进度滞后、0→100% 跳变 | 中 | ✅ 已修复（`b1371eb`，v0.2.19：worker 强制逐步 advance + progressStalled 监督） |
| B3 | merge 冲突处理缺陷：失败即删分支 + merger 竞态 + 无暂停等 supervisor | 中 | ✅ 已修复（`b1371eb`，v0.2.19：merger 禁止重 merge + conflict 态自动暂停） |
| **B4** | **lane 运行中但界面显示 "Not Started"（Current Step 字段滞后）** | 低 | ❌ **未修复（本节新增）** |

---

# §1-3. B1/B2/B3（已修复·存档）

- **B1**（`92cf912`，v0.2.18）：abortWaiter 中断在途 worker、run() 并发保护、runLane 查 abort、
  updateLane 终态防御、execute 波次写回尊重磁盘终态。
- **B2**（`b1371eb`，v0.2.19）：worker mission 强制"每完成一个 checkbox 即 task_runner advance"；
  新增 `progressStalled` 监督（会话活跃但 STATUS 长时间无 advance → 🐢 提醒 supervisor）。
- **B3**（`b1371eb`，v0.2.19）：merge 失败保留分支、merger 禁止对 laneBranch 重 merge、冲突进入
  待处理态自动暂停等 supervisor。

> 生效前提：重启 dsh web 加载新引擎（当前运行环境已确认 v0.2.19）。

---

# §4. B4（未修复）lane 运行中但界面显示 "Not Started"

## 症状（2026-08-15 实测，v0.2.19 运行环境）

批次 `b-msu5mdk6-0973e3` 的 T-8 lane：**引擎/批次层面已 running**（`tswarm_supervisor_status` 显示
`lane 1 [running] T-8`，worker 会话日志实时增长、已完成大量真实工作），但 **dashboard 每 lane 卡片仍显示
`Not Started`、0% 0/7**，且 STATUS.md 文件内部自相矛盾：

```
# T-8: 打磨与发布 — Status
**Status:** 🟢 In Progress      ← 引擎启动 lane 时已更新（正确）
**Current Step:** Not Started   ← 停在初始值（问题所在）
### Step 1: 播报与音频打磨
**Status:** ⬜ Not Started       ← 也停在初始值
```

观察时长：T-8 启动后 **3m42s~4min+** 一直显示 Not Started（worker 在前几分钟做代码调研，
尚未完成第一个 checkbox，故未触发 advance；按 B2 修复后的纪律，worker 会在勾第一项时 advance，
但"启动到首次 advance 之间"以及"worker 仍在调研时"，显示始终是 Not Started）。

## 根因（代码级）

1. **引擎启动 lane 时不更新 Current Step / Step 状态**：
   - `src/orchestrator/engine.ts` runLane（约 L339）只调用 `setTaskStatus(task.folder, 'running')`；
   - `src/core/task.ts` `setTaskStatus` 只改 `**Status:**` 行（`updateStatusField('Status', …)`），
     **不碰 `**Current Step:**`，也不把第一个 Step 的状态标 🟢**；
   - `**Current Step:**` 与各 Step 的 `**Status:**` 初始值由 `ensureStatusFile`（task.ts L244）写为
     "Not Started"，此后**只有 worker 调用 `task_runner advance`（→ `advanceStep`）才会更新**。
2. **dashboard 直接展示 STATUS.md 的原始 Current Step**：`dashboard/adapters.mjs`（约 L223）
   `currentStep: info.currentStep || 'Unknown'`——lane 已 running 时不加任何兜底，把初始值
   "Not Started" 原样显示给用户。
3. 底层诱因仍是 B2 的行为面（worker 到首个 advance 之前不做任何 STATUS 更新），但 **B2 修复后
   本问题仍存在**：即使 worker 严格逐项 advance，"lane 启动 → 首次 advance" 之间的窗口，
   以及 STATUS.md 自身 Status 行与 Current Step 行的不一致，都是引擎侧缺口，不是 worker 纪律问题。

## 修复建议（按性价比排序）

1. **引擎侧（推荐，根治）**：`runLane` 在 `setTaskStatus('running')` 后，顺带把
   `**Current Step:**` 置为第一个 Step 的标题（或统一语义值 "Running"），并把 Step 1 的
   `**Status:**` 标 🟢——保证 STATUS.md 自身自洽，dashboard 显示即为"运行中/第一步"。
   （改 `src/core/task.ts` 新增 `markFirstStepInProgress(taskDir)` 或扩展 `setTaskStatus`；engine.ts
   runLane 调用。）
2. **显示层兜底（轻量）**：dashboard/adapters 在 lane phase=running 且 currentStep 为初始
   "Not Started" 时，显示为"运行中"（或第一步标题），不把原始初始值暴露给用户。
3. 可选：STATUS.md 模板的初始 Current Step 从 "Not Started" 改为 "-"（空态语义更清晰），
   避免被误读为"任务没开始"。

## 复现步骤

1. 任一仓库放一个 Size L 任务包（多 Step）；`start` 该任务；
2. 观察 dashboard：lane 卡片在 worker 首次 `advance` 之前（哪怕 worker 已在做大量调研/写码）
   一直显示 `Not Started`、0%；
3. 同时 `cat tasks/<ID>/STATUS.md`：`**Status:** 🟢 In Progress` 与 `**Current Step:** Not Started`
   并存——文件内部不一致。

## 相关代码位置索引

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/orchestrator/engine.ts` | runLane 约 L339 | `setTaskStatus('running')` 不更新 Current Step |
| `src/core/task.ts` | `setTaskStatus` | 只改 Status 行 |
| `src/core/task.ts` | `ensureStatusFile` 约 L244 | Current Step 初始值 "Not Started" |
| `src/core/task.ts` | `advanceStep` | Current Step 唯一更新入口（worker advance 时） |
| `dashboard/adapters.mjs` | 约 L223 | 直接展示原始 currentStep，无 running 兜底 |

---

## 附：本清单由来与现场速查

- 批次：dsh-localvoice `b-msu5mdk6-0973e3`（T-8，v0.2.19 新引擎）与前批次 `b-msu3g6en-4c5aec`（已 abort）。
- 关键证据：`tasks/T8/STATUS.md`（Status 🟢 与 Current Step Not Started 并存）、dashboard 卡片截图描述、
  `~/.dsh/sessions/--Users-robin-myProject-dsh-localvoice-.taskswarm-worktrees-t-8--/`（worker 会话实时活跃）。
- 已落地的同类改进（预防性，非 bug）：lane 基线改为 `taskswarm/orch` HEAD（`44c5b88`）、
  `/tswarm-check` 任务包校验（`9894f52`）。
