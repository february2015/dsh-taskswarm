# Task: WEB-002 — 数据适配层（dsh-buju 状态 → dashboard JSON）

**Created:** 2026-08-14
**Size:** M

## Review Level: 2 (Standard)

## Mission

写 `dashboard/adapters.mjs`：把 dsh-buju 的持久化数据翻译成 TaskPlane 前端
（WEB-001 搬来的 app.js）期望的 JSON 契约。前端契约以 TaskPlane
`dashboard/server.cjs` 的 `buildDashboardState()` 返回值为准：`batch`、
`laneStates`、`telemetry`、`supervisor`、`runtimeRegistry`、
`runtimeLaneSnapshots`、`runtimeMergeSnapshots`、`mailbox`、`sessions`。

dsh-buju 的数据源：`.buju/batches/<batchId>.json`（BatchState）、
`<tasksRoot>/<ID>-<slug>/PROMPT.md|STATUS.md`、`.buju/mailbox/<batchId>/...`。
本模块优先复用 `lib/core/` 已测试代码（`status.js`/`discover.js`/`task.js`/
`mailbox.js`），不重复实现解析。

## Dependencies

- **None**（契约已从上游 server.cjs 固定，不依赖 WEB-001 完成）

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None（纯函数 + fs 读取）

## File Scope

- `dashboard/adapters.mjs` (new)
- `dashboard/adapters.spec.mjs` (new，node:test)

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder
- [ ] 通读上游 `server.cjs` 的 `buildDashboardState()` 与 `loadBatchState()`，把返回 JSON 的每个字段抄成注释契约
- [ ] 通读 dsh-buju `src/core/status.ts`（BatchState/LaneState 字段）与 `src/core/mailbox.ts`（目录布局）

### Step 1: batch 字段映射

- [ ] `batch.batchId` ← BatchState.id；`batch.phase`/`startedAt`/`updatedAt` 直映
- [ ] `batch.totalWaves` ← BatchState.waves；`batch.currentWaveIndex` 由 lane 阶段推导（首个存在非 pending lane 的波）
- [ ] `batch.wavePlan` ← `scanTasks(tasksRoot)` + `buildWaves()` 重算（BatchState 不存 wave→task 映射），格式 `[{ wave: n, tasks: [{taskId}] }]`
- [ ] `batch.lanes` ← lanes 映射为 `{laneNumber, taskId, laneSessionId(由 worktree 目录名推导), worktreePath, phase}`，dsh phase (pending/running/review/merged/failed/skipped) 原样透传
- [ ] `batch.tasks` ← 每个 lane 的任务包：`{taskId, taskFolder, laneNumber, statusData, taskTitle, doneFileFound}`；`statusData` 用 `parseStatusFile` + STATUS.md 正则（currentStep/checked/total/progress）
- [ ] `batch.errors/lastError` ← 从 `lane.error` 汇总；`mergeResults`/`segments`/`mode` 给默认空值

### Step 2: 缺失功能降级

- [ ] `laneStates: {}`、`telemetry: {}`、`batchTotalCost: 0`、`supervisor: null`、`runtimeRegistry: null`、`runtimeLaneSnapshots: {}`、`runtimeMergeSnapshots: {}`、`sessions: []`
- [ ] 无批次时返回 `{batch: null, ...}` 默认对象（与上游一致）

### Step 3: mailbox 适配

- [ ] 扫描 `.buju/mailbox/<batchId>/<session>/{inbox,ack,outbox}` 与 `broadcast`，输出 `{messages: [{from,to,type,timestamp,subject,body,_status,_agentDir}], agentIds, auditEvents: []}`
- [ ] 消息按 timestamp 排序；`_status` 映射 inbox→pending / ack→delivered / outbox→reply

### Step 4: 单元测试

- [ ] `adapters.spec.mjs`：构造临时 repo（tasks/ 放 2 个模板任务 + `.buju/batches/` 写一个 2-lane 的 BatchState + mailbox 写一条消息）
- [ ] 断言：batchId/totalWaves/wavePlan 正确；lane phase 透传；task.statusData.progress 正确；mailbox.messages 排序正确；空状态返回 `{batch:null}`
- [ ] 全部字段 JSON 序列化无异常

### Step 5: Verification

- [ ] `npm run build && node --test dashboard/adapters.spec.mjs` 通过
- [ ] 手动冒烟：对 dsh-buju 真实 `.buju` 目录跑一次 adapter，输出与契约字段一一核对

### Step 6: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `adapters.mjs` 输出对象与 TaskPlane `buildDashboardState()` 契约字段对齐（缺失功能走空态默认值）
- [ ] wavePlan 由 tasksRoot 重算，与 BatchState.lanes 的 taskId 能对上
- [ ] `adapters.spec.mjs` 通过；零外部依赖

## Git Commit Convention

- **Implementation:** `feat(WEB-002): dashboard data adapter for dsh-buju state`
- **Checkpoints:** `checkpoint: WEB-002 description`

## Do NOT

- 修改 `src/core/*`——只 import，不重写解析逻辑
- 引入 express/fastify 等依赖
- 在 adapter 里做 HTTP/SSE（那是 WEB-003）

---

## Amendments (Added During Execution)
- wavePlan 格式修正：Step 1 文案写的 `[{wave, tasks:[{taskId}]}]` 与上游契约不符 — TaskPlane engine.ts 持久化 `wavePlan: string[][]`（每波一个 taskId 数组），app.js 以 `wavePlan.forEach((taskIds,i))` / `wavePlan[mr.waveIndex]` 消费。adapter 按上游契约输出 `string[][]`（测试断言 `[['ALPHA-001'],['BETA-002']]`）。同理 `batch.lanes` 额外输出 `taskIds: [taskId]`（app.js 用 `lane.taskIds` 解析任务行）与 task `status`（app.js 用 `task.status` 判断 succeeded/running/pending），均为对前端契约的忠实补充。

<!-- Workers add amendments here if issues discovered during execution. -->
