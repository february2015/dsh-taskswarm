# Task: WEB-005 — 前端联调与字段修复

**Created:** 2026-08-14
**Size:** M

## Review Level: 2 (Standard)

## Mission

把 WEB-001 搬来的前端和 WEB-003/WEB-004 的后端接起来，让每个面板在 dsh-buju
真实数据下渲染正确。本任务是**集成波**：组装路由（`registerCore` + WEB-004 的
`registerExtra` 在 `main()` 里接线）、用**真实/合成的 dsh-buju 批次**逐面板
验证、修 app.js 里与 dsh-buju 字段不一致的地方（phase 标签、wavePlan 段、
进度条、viewer 兜底），并确认缺失功能（supervisor/merge/agents/telemetry）
走空态不报错。

## Dependencies

- WEB-001 (前端资源)
- WEB-003 (HTTP/SSE 服务)
- WEB-004 (历史/STATUS.md API)

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** 本地浏览器（手动验证），node:test（自动化断言）

## File Scope

- `dashboard/server.mjs` (修改：`main()` 组装 `registerCore(router, ctx) + registerExtra(router, ctx)`，ctx 注入 stateRoot/tasksRoot/loadBatch)
- `dashboard/public/app.js` (修改：仅必要的字段适配)
- `dashboard/public/style.css` (按需微调)
- `tests/dashboard-e2e.spec.mjs` (new：起 server + 抓 /api/state 断言契约)

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder
- [ ] 确认 WEB-001~004 已合并；`node dashboard/server.mjs --root <repo>` 启动后 `/api/health` 通
- [ ] 构造验证数据：`.buju/batches/` 写一个覆盖 pending/running/review/merged/failed 的合成批次

### Step 1: 路由组装

- [ ] `main()`：`createRouter()` → `registerCore(router, ctx)` → `registerExtra(router, ctx)` → `createServer(router)`
- [ ] ctx 传参核对：stateRoot/tasksRoot 来自 `--root` 推导（默认 tasksRoot=`<root>/tasks`、stateRoot=`<root>/.buju`），`loadBatch` 用 WEB-002 的 adapter
- [ ] 全部路由实测可达：/api/stream、/api/state、/api/history、/api/status-md/:id、/api/preferences

### Step 2: 面板逐项验证（对合成批次）

- [ ] header：batch id、phase 徽章、history 下拉、theme 切换、SSE 连接点变绿
- [ ] summary bar：wavePlan 分段进度条 + 百分比 + 完成计数
- [ ] Lanes & Tasks：lane 卡、状态 chip、任务标题、进度、点击展开 STATUS.md viewer
- [ ] Messages 面板：mailbox 消息渲染（若无消息显示空态）
- [ ] supervisor/merge/agents 面板：确认空态文案而非 JS 报错
- [ ] Errors 面板：lane.error 汇总展示
- [ ] history 面板：切历史批次显示 summary

### Step 3: 字段适配（app.js 最小改动）

- [ ] 对照 dsh phase 与前端期望，修 phase→文案映射（merged/failed/skipped 等上游没有的取值）
- [ ] `currentWaveIndex`/`wavePlan` 字段若与 adapter 输出不一致，在 app.js 取用处做兼容（或在 adapter 侧修，二选一，保持单一数据源）
- [ ] `laneSessionId` 缺省时 viewer/conversation 入口优雅降级（不弹错误框）
- [ ] `batch.tasks[].statusData` 为 null 的任务卡渲染兜底

### Step 4: 实时性验证

- [ ] SSE 开着时改 `.buju/batches/` 文件，确认页面 ≤2s 自动刷新且无全页重载
- [ ] 断开 server 再起，前端自动重连（EventSource 默认行为）不白屏

### Step 5: 自动化回归

- [ ] `dashboard-e2e.spec.mjs`：起 server → 断言 `/api/state` 的 batch.lanes/batch.tasks/wavePlan 与合成批次一致 → 关 server
- [ ] `npm run build && node --test tests/*.spec.mjs dashboard/*.spec.mjs` 全绿

### Step 6: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] 全部面板对合成批次渲染正确，无 console 报错
- [ ] app.js 改动被 git diff 审计，仅限字段适配（不重构 UI）
- [ ] e2e 测试通过；SSE 实时刷新实测通过

## Git Commit Convention

- **Implementation:** `fix(WEB-005): wire dashboard frontend to dsh-buju data`
- **Checkpoints:** `checkpoint: WEB-005 description`

## Do NOT

- 重构 app.js 的渲染结构或重写样式主题
- 给后端加接口来解决前端字段问题——优先在 adapter 侧统一契约
- 删除 supervisor/merge/agents 面板——保留空态

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
