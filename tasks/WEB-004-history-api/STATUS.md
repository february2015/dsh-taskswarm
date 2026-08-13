# WEB-004: 历史批次 / STATUS.md / 偏好 API — Status
**Status:** ✅ Complete
**Current Step:** 测试
**Last Updated:** 2026-08-13T17:37:42.925Z
**Iteration:** 0
**Size:** S

---

### Step 0: Preflight
**Status:** 🟢 In Progress

- [x] Verify this PROMPT.md is readable
- [x] Verify STATUS.md exists in the same folder
- [x] 通读上游 `serveHistory()` / `serveHistoryEntry()` / `serveStatusMd()` / `handleGetPreferences()` / `handlePostPreferences()`

---

### Step 1: 批次历史（从 .buju/batches/ 推导）
**Status:** 🟢 In Progress

- [x] `history.mjs` 的 `listHistory(stateRoot)`：扫 `batches/*.json`，输出紧凑列表 `[{batchId, status, startedAt, endedAt, durationMs, totalWaves, totalTasks, succeededTasks, failedTasks, tokens:0}]`
- [x] `getHistoryEntry(stateRoot, batchId)`：完整 BatchState JSON
- [x] 排序：按 startedAt 倒序；文件损坏跳过不炸

---

### Step 2: STATUS.md 原文
**Status:** 🟢 In Progress

- [x] `GET /api/status-md/:taskId`：从 `state.lanes` 找到 taskId → 优先读 lane.worktree 下的 `STATUS.md`，其次读 `<tasksRoot>/<taskId>-*/STATUS.md`；404 兜底
- [x] taskId 校验 `/^[\w-]+$/`，防路径穿越

---

### Step 3: 偏好与降级路由（registerExtra 注册）
**Status:** 🟢 In Progress

- [x] `registerExtra(router, ctx)` 注册：`GET/POST /api/preferences` → `<stateRoot>/dashboard-preferences.json`，默认 `{theme:"dark"}`，POST 合并写回
- [x] 注册 `GET /api/conversation/:prefix` → 200 空 `application/x-ndjson`
- [x] 注册 `GET /api/agent-events/:agentId` → 200 `[]`
- [x] ctx 里带 `stateRoot`/`tasksRoot`/`loadBatch` 等依赖（由 main 组装时传入），本模块不自己解析 CLI

---

### Step 4: 测试
**Status:** 🟢 In Progress

- [x] `history.spec.mjs`：临时 stateRoot 写 2 个 batch 文件，断言列表字段、排序、损坏文件跳过
- [x] server.spec.mjs 追加：`/api/history` 200、`/api/status-md` 对已知任务返回原文、未知任务 404、preferences POST→GET 回读一致

---

### Step 5: Delivery
**Status:** ⬜ Not Started

- [ ] Mark the task done with task_runner

---

## Execution Log

| Timestamp | Action | Outcome |
|---|---|---|
| 2026-08-13T17:55:47.285Z | Lane started | lane 4 |
| 2026-08-13T17:55:50.774Z | advance step 0 | no changes |
| 2026-08-13T17:55:50.784Z | worker | Preflight: reading packet; now exploring worktree layout and upstream dashboard sources. |
| 2026-08-13T17:55:52.006Z | worker | Exploring worktree: dashboard/ directory, WEB-002 adapters, WEB-003 router contract. |
| 2026-08-13T17:55:53.978Z | worker | Exploring worktree layout: dashboard/, adapters.mjs, upstream sources. |
| 2026-08-13T17:56:05.129Z | worker | Checking available file-system tooling in harness before proceeding. |
| 2026-08-13T17:56:11.660Z | worker | Probing harness for file tooling (read/list) — needed to inspect upstream dashboard sources and worktree layout. |
| 2026-08-13T18:59:00.238Z | Lane started | lane 2 |
| 2026-08-13T19:08:20.893Z | review_step code 4 | PASS |
| 2026-08-13T19:08:27.601Z | advance step 0 | buju/web-004 d32cd65 |
| 2026-08-13T19:08:29.983Z | advance step 0 | no changes |
| 2026-08-13T19:08:31.884Z | advance step 1 | no changes |
| 2026-08-13T19:08:33.300Z | advance step 1 | no changes |
| 2026-08-13T19:08:34.593Z | advance step 1 | no changes |
| 2026-08-13T19:08:36.288Z | advance step 2 | no changes |
| 2026-08-13T19:08:37.791Z | advance step 2 | no changes |
| 2026-08-13T19:08:39.146Z | advance step 3 | no changes |
| 2026-08-13T19:08:40.620Z | advance step 3 | no changes |
| 2026-08-13T19:08:42.232Z | advance step 3 | no changes |
| 2026-08-13T19:08:44.188Z | advance step 3 | no changes |
| 2026-08-13T19:08:45.724Z | advance step 4 | no changes |
| 2026-08-13T19:08:47.807Z | advance step 4 | no changes |
| 2026-08-13T19:09:03.509Z | done | no changes |
