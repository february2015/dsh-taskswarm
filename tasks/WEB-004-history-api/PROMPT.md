# Task: WEB-004 — 历史批次 / STATUS.md / 偏好 API

**Created:** 2026-08-14
**Size:** S

## Review Level: 2 (Standard)

## Mission

补齐上游 dashboard 剩余的 JSON API：批次历史、STATUS.md 原文、主题偏好，
以及两个降级路由。产出独立模块 `dashboard/history.mjs`，导出
`registerExtra(router, ctx)`（路由注册器模式，契约见 WEB-003 PROMPT：
`router.on(method, path, handler)`），由 WEB-005 在 `main()` 里与
`registerCore` 一起组装——本任务**不碰 server.mjs**，可与 WEB-003 并行。

dsh-buju 没有上游的 `batch-history.json`，历史列表从 `.buju/batches/*.json`
现场推导；没有 `worker-conversation-*.jsonl` 和 runtime 注册表，
`/api/conversation/:prefix` 与 `/api/agent-events/:agentId` 返回空（前端已按
空态兜底）。

## Dependencies

- WEB-002 (adapters.mjs — 复用其 batch 字段映射约定)

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None

## File Scope

- `dashboard/history.mjs` (new — `listHistory`/`getHistoryEntry` + `registerExtra(router, ctx)` 注册全部 5 个路由)
- `dashboard/history.spec.mjs` (new)

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder
- [ ] 通读上游 `serveHistory()` / `serveHistoryEntry()` / `serveStatusMd()` / `handleGetPreferences()` / `handlePostPreferences()`

### Step 1: 批次历史（从 .buju/batches/ 推导）

- [ ] `history.mjs` 的 `listHistory(stateRoot)`：扫 `batches/*.json`，输出紧凑列表 `[{batchId, status, startedAt, endedAt, durationMs, totalWaves, totalTasks, succeededTasks, failedTasks, tokens:0}]`
- [ ] `getHistoryEntry(stateRoot, batchId)`：完整 BatchState JSON
- [ ] 排序：按 startedAt 倒序；文件损坏跳过不炸

### Step 2: STATUS.md 原文

- [ ] `GET /api/status-md/:taskId`：从 `state.lanes` 找到 taskId → 优先读 lane.worktree 下的 `STATUS.md`，其次读 `<tasksRoot>/<taskId>-*/STATUS.md`；404 兜底
- [ ] taskId 校验 `/^[\w-]+$/`，防路径穿越

### Step 3: 偏好与降级路由（registerExtra 注册）

- [ ] `registerExtra(router, ctx)` 注册：`GET/POST /api/preferences` → `<stateRoot>/dashboard-preferences.json`，默认 `{theme:"dark"}`，POST 合并写回
- [ ] 注册 `GET /api/conversation/:prefix` → 200 空 `application/x-ndjson`
- [ ] 注册 `GET /api/agent-events/:agentId` → 200 `[]`
- [ ] ctx 里带 `stateRoot`/`tasksRoot`/`loadBatch` 等依赖（由 main 组装时传入），本模块不自己解析 CLI

### Step 4: 测试

- [ ] `history.spec.mjs`：临时 stateRoot 写 2 个 batch 文件，断言列表字段、排序、损坏文件跳过
- [ ] server.spec.mjs 追加：`/api/history` 200、`/api/status-md` 对已知任务返回原文、未知任务 404、preferences POST→GET 回读一致

### Step 5: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `history.mjs` 导出 `listHistory`/`getHistoryEntry`/`registerExtra`，5 个路由全部注册并可通过 `createRouter` + `registerCore` + `registerExtra` 组合实测
- [ ] 历史列表可从 `.buju/batches/` 现场推导，无需上游的 batch-history.json
- [ ] `history.spec.mjs` 通过（含组合 server 的集成断言）；零外部依赖

## Git Commit Convention

- **Implementation:** `feat(WEB-004): history/status-md/preferences endpoints`
- **Checkpoints:** `checkpoint: WEB-004 description`

## Do NOT

- 修改 `dashboard/server.mjs`——本任务只产出 history.mjs（组装由 WEB-005 完成）
- 给 dsh-buju 引入 batch-history.json 副作用文件——历史从 batches/ 现场推导
- 触碰 app.js——前端字段消费由 WEB-005 处理
- 实现上游的 archive 任务目录回退（dsh-buju 无 archive 约定）

---

## Amendments (Added During Execution)
- Step 4 note: server.spec.mjs belongs to the in-flight WEB-003 lane (not present in this worktree; touching it here would collide at merge). The four mandated integration assertions (/api/history 200, /api/status-md known→原文 unknown→404, preferences POST→GET round-trip) are implemented in history.spec.mjs against a WEB-003-contract router double (on/handle + :param matching), verified additionally via a real node:http end-to-end smoke run. WEB-005 can mirror these assertions into server.spec.mjs at assembly once server.mjs lands.

<!-- Workers add amendments here if issues discovered during execution. -->
