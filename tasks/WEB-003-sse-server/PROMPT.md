# Task: WEB-003 — HTTP/SSE 服务移植

**Created:** 2026-08-14
**Size:** M

## Review Level: 2 (Standard)

## Mission

移植 TaskPlane `dashboard/server.cjs`（1737 行）的 HTTP 骨架与 SSE 实时推送，
数据装载换成 WEB-002 的 `adapters.mjs`。保留上游的全部优点：node:http 零依赖、
SSE 初始状态 + 2s 轮询 + `fs.watch` 即时推送、`--port/--root/--no-open` CLI、
自动开浏览器、优雅退出。产出 `dashboard/server.mjs`，可 `node dashboard/server.mjs`
独立启动。

**路由组合设计（重要）**：server 采用「路由注册器」模式，让 WEB-004 的历史/
偏好路由与 WEB-003 的 SSE/核心路由**并行开发、零文件冲突**。契约如下（WEB-004
的 PROMPT 引用同一契约）：

- `createRouter()` → `{ on(method, path, handler), handle(req, res) }`（内部是
  method+pathname → handler 的 Map，handler 签名 `(req, res, ctx) => void`）
- `registerCore(router, ctx)` — 本任务实现：`/api/stream`、`/api/state`、
  `/api/health`、静态服务、CORS 预检
- `registerExtra(router, ctx)` — WEB-004 实现，本任务只留 TODO 占位注释
- `createServer(router)` → http server（404 兜底、JSON 错误、静态 404）
- `main()` — CLI 入口，组装 `registerCore + registerExtra` 后启动

## Dependencies

- WEB-002 (adapters.mjs)

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None（node:http + node:fs + node:child_process）

## File Scope

- `dashboard/server.mjs` (new — 含 createRouter/registerCore/createServer/main)
- `dashboard/server.spec.mjs` (new，node:test)

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder
- [ ] 通读上游 `server.cjs` 的 `createServer()`、`handleSSE()`、`broadcastState()`、`serveStatic()`、`main()`

### Step 1: 路由注册器与核心路由

- [ ] `createRouter()`：method+pathname → handler 的注册表，`handle(req,res)` 按 `new URL(req.url).pathname` 精确匹配，未命中返回 404
- [ ] `registerCore(router, ctx)` 注册：`GET /api/stream`、`GET /api/state`、`GET /api/health`，其余 JSON 路由留给 WEB-004 的 `registerExtra`（本任务在 main 里留 TODO 组装注释）
- [ ] `serveStatic()`：从 `dashboard/public/` 提供静态文件，带 MIME 表与路径穿越防护，`Cache-Control: no-cache`
- [ ] CORS `OPTIONS` 预检 + `Access-Control-Allow-Origin: *`
- [ ] 统一 JSON 错误：404/500（由 `createServer` 兜底）

### Step 2: 移植 SSE

- [ ] `GET /api/stream`：立即推送一次 `buildState()`（即 adapters 输出），`Content-Type: text/event-stream`
- [ ] `setInterval(broadcastState, 2000)` 轮询
- [ ] `fs.watch` 监听 `<stateRoot>/batches/`（注意 dsh-buju 是 `batches/` 目录，不是上游的单个 `batch-state.json`），200ms debounce 后广播
- [ ] 连接断开时从 `sseClients` 清理；心跳或注释说明（上游无心跳，保持一致即可）

### Step 3: 移植 CLI 与生命周期

- [ ] `parseArgs()`：`--port`（默认 8100）、`--root`、`--no-open`、`-h`
- [ ] `findPort()`：EADDRINUSE 自动 +1 试端口（最多 20 次），显式 `--port` 时直接报错退出
- [ ] `openBrowser()`：darwin 用 `open`，win32 用 `start`，其他 `xdg-open`
- [ ] SIGINT/SIGTERM：清 timer、断 SSE、关 server
- [ ] 启动日志：`Buju Dashboard → http://localhost:<port>`

### Step 4: 测试

- [ ] `server.spec.mjs`：临时目录起服务（ephemeral port），断言 `/api/health` 200、`/api/state` JSON 且 `batch:null` 或正确、静态 `/index.html` 200 且含 `Buju Dashboard`、未知路由 404
- [ ] `router.spec`：`createRouter()` 未注册路径 404；`on('GET','/x')` 后命中；`registerExtra` 缺省时 main 启动不报错（TODO 占位）
- [ ] SSE 冒烟：curl `-N /api/stream` 收到初始 data 帧；touch `.buju/batches/` 下文件后收到新帧

### Step 5: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `createRouter`/`registerCore`/`createServer`/`main` 四个导出按契约可用，`main()` 组装 `registerCore + registerExtra`（registerExtra 为 TODO 占位也不报错）
- [ ] `node dashboard/server.mjs --root <repo> --no-open` 独立启动成功，核心路由可用
- [ ] SSE 初始推送 + 文件变更即时推送（curl 验证）
- [ ] `server.spec.mjs` 通过；零外部依赖

## Git Commit Convention

- **Implementation:** `feat(WEB-003): port dashboard HTTP/SSE server`
- **Checkpoints:** `checkpoint: WEB-003 description`

## Do NOT

- 引入 express/ws 等依赖
- 在 server 里直接解析 `.buju` 文件——一律走 adapters.mjs
- 实现 /api/history、/api/status-md、/api/preferences（WEB-004 的活）

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
