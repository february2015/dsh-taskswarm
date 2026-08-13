# WEB-003: HTTP/SSE 服务移植 — Status
**Status:** ✅ Complete
**Current Step:** 测试
**Last Updated:** 2026-08-13T17:37:42.925Z
**Iteration:** 0
**Size:** M

---

### Step 0: Preflight
**Status:** ✅ Complete

- [x] Verify this PROMPT.md is readable
- [x] Verify STATUS.md exists in the same folder
- [x] 通读上游 `server.cjs` 的 `createServer()`、`handleSSE()`、`broadcastState()`、`serveStatic()`、`main()`

---

### Step 1: 路由注册器与核心路由
**Status:** 🟢 In Progress

- [x] `createRouter()`：method+pathname → handler 的注册表，`handle(req,res)` 按 `new URL(req.url).pathname` 精确匹配，未命中返回 404
- [x] `registerCore(router, ctx)` 注册：`GET /api/stream`、`GET /api/state`、`GET /api/health`，其余 JSON 路由留给 WEB-004 的 `registerExtra`（本任务在 main 里留 TODO 组装注释）
- [x] `serveStatic()`：从 `dashboard/public/` 提供静态文件，带 MIME 表与路径穿越防护，`Cache-Control: no-cache`
- [x] CORS `OPTIONS` 预检 + `Access-Control-Allow-Origin: *`
- [x] 统一 JSON 错误：404/500（由 `createServer` 兜底）

---

### Step 2: 移植 SSE
**Status:** 🟢 In Progress

- [x] `GET /api/stream`：立即推送一次 `buildState()`（即 adapters 输出），`Content-Type: text/event-stream`
- [x] `setInterval(broadcastState, 2000)` 轮询
- [x] `fs.watch` 监听 `<stateRoot>/batches/`（注意 dsh-buju 是 `batches/` 目录，不是上游的单个 `batch-state.json`），200ms debounce 后广播
- [x] 连接断开时从 `sseClients` 清理；心跳或注释说明（上游无心跳，保持一致即可）

---

### Step 3: 移植 CLI 与生命周期
**Status:** 🟢 In Progress

- [x] `parseArgs()`：`--port`（默认 8100）、`--root`、`--no-open`、`-h`
- [x] `findPort()`：EADDRINUSE 自动 +1 试端口（最多 20 次），显式 `--port` 时直接报错退出
- [x] `openBrowser()`：darwin 用 `open`，win32 用 `start`，其他 `xdg-open`
- [x] SIGINT/SIGTERM：清 timer、断 SSE、关 server
- [x] 启动日志：`Buju Dashboard → http://localhost:<port>`

---

### Step 4: 测试
**Status:** 🟢 In Progress

- [x] `server.spec.mjs`：临时目录起服务（ephemeral port），断言 `/api/health` 200、`/api/state` JSON 且 `batch:null` 或正确、静态 `/index.html` 200 且含 `Buju Dashboard`、未知路由 404
- [x] `router.spec`：`createRouter()` 未注册路径 404；`on('GET','/x')` 后命中；`registerExtra` 缺省时 main 启动不报错（TODO 占位）
- [x] SSE 冒烟：curl `-N /api/stream` 收到初始 data 帧；touch `.buju/batches/` 下文件后收到新帧

---

### Step 5: Delivery
**Status:** ⬜ Not Started

- [ ] Mark the task done with task_runner

---

## Execution Log

| Timestamp | Action | Outcome |
|---|---|---|
| 2026-08-13T17:55:47.235Z | Lane started | lane 3 |
| 2026-08-13T17:55:50.530Z | worker | Starting WEB-003 preflight: inspect worktree, locate upstream server.cjs and WEB-002 adapters.mjs |
| 2026-08-13T17:55:50.576Z | advance step 0 | no changes |
| 2026-08-13T17:55:51.824Z | worker | Preflight: inspecting worktree structure and locating upstream sources |
| 2026-08-13T17:55:51.855Z | advance step 0 | no changes |
| 2026-08-13T17:55:53.444Z | worker | Preflight: listing worktree root and locating upstream server.cjs |
| 2026-08-13T17:55:53.472Z | advance step 0 | no changes |
| 2026-08-13T17:55:55.293Z | worker | Step 0 complete; exploring workspace for upstream server.cjs and WEB-002 adapters.mjs |
| 2026-08-13T18:59:00.184Z | Lane started | lane 1 |
| 2026-08-13T19:10:51.543Z | advance step 0 | no changes |
| 2026-08-13T19:11:02.542Z | advance step 0 | no changes |
| 2026-08-13T19:11:02.569Z | advance step 0 | no changes |
| 2026-08-13T19:11:02.598Z | advance step 0 | no changes |
| 2026-08-13T19:11:02.626Z | advance step 0 | no changes |
| 2026-08-13T19:11:02.652Z | advance step 0 | no changes |
| 2026-08-13T19:11:09.291Z | advance step 1 | no changes |
| 2026-08-13T19:11:12.583Z | advance step 1 | no changes |
| 2026-08-13T19:11:12.623Z | advance step 1 | no changes |
| 2026-08-13T19:11:12.651Z | advance step 1 | no changes |
| 2026-08-13T19:11:12.677Z | advance step 1 | no changes |
| 2026-08-13T19:11:15.655Z | advance step 2 | no changes |
| 2026-08-13T19:11:15.693Z | advance step 2 | no changes |
| 2026-08-13T19:11:15.725Z | advance step 2 | no changes |
| 2026-08-13T19:11:15.754Z | advance step 2 | no changes |
| 2026-08-13T19:11:19.538Z | advance step 3 | no changes |
| 2026-08-13T19:11:19.574Z | advance step 3 | no changes |
| 2026-08-13T19:11:19.602Z | advance step 3 | no changes |
| 2026-08-13T19:11:19.626Z | advance step 3 | no changes |
| 2026-08-13T19:11:19.649Z | advance step 3 | no changes |
| 2026-08-13T19:11:23.180Z | advance step 4 | no changes |
| 2026-08-13T19:11:23.218Z | advance step 4 | no changes |
| 2026-08-13T19:11:23.251Z | advance step 4 | no changes |
| 2026-08-13T19:13:09.079Z | review_step code 4 | PASS |
| 2026-08-13T19:13:12.057Z | done | no changes |
