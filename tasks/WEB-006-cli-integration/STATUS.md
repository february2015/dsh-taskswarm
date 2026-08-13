# WEB-006: CLI 命令与真机验证 — Status
**Status:** ✅ Complete
**Current Step:** Delivery（人工收尾：CLI 已移植 + 真机验证通过）
**Last Updated:** 2026-08-13T17:37:42.925Z
**Iteration:** 0
**Size:** M

---

### Step 0: Preflight
**Status:** ⬜ Not Started

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder
- [ ] 通读上游 package.json 里 dashboard 的注册方式（`bin/` 或 CLI 子命令）与 `src/orchestrator/index.ts` 的命令注册模式

---

### Step 1: CLI 入口
**Status:** ⬜ Not Started

- [ ] `package.json` 加 `"bin": {"buju-dashboard": "dashboard/server.mjs"}`（server.mjs 头部加 `#!/usr/bin/env node`）
- [ ] 加 `"scripts": {"dashboard": "node dashboard/server.mjs"}`，`files` 数组加 `dashboard`
- [ ] `npm link` 或 `node dashboard/server.mjs --help` 验证 CLI 可用

---

### Step 2: /buju-dashboard 命令
**Status:** ⬜ Not Started

- [ ] orchestrator/index.ts 注册 `buju-dashboard` 命令：用会话 cwd（与 ensureEngine 同一逻辑）解析 repoRoot，`spawn` 子进程 `node dashboard/server.mjs --root <repo> --no-open`，返回 `Buju Dashboard → http://localhost:<port>`
- [ ] 命令可重复调用：重复时提示已有实例或复用端口（简单起见：检测端口占用并提示 URL）
- [ ] 命令与 `/orch` 家族一样走 `withEngine` 错误包装

---

### Step 3: 真机验证（核心）
**Status:** ⬜ Not Started

- [ ] `npm run build && npm test` 全绿
- [ ] 启动 dashboard：`npm run dashboard -- --root <demo-repo>`
- [ ] dsh web（localhost:3080）新会话：`/buju-init` → `/orch-plan all` → `/orch all`
- [ ] 浏览器打开 dashboard URL：批次出现 → lanes 从 pending→running→review→merged 实时变化 → 进度条/百分比推进 → 任务 STATUS.md 可点开
- [ ] `/orch-status` 与 dashboard 显示一致（同一数据源交叉验证）
- [ ] 截图存档（页面 + 一个实时变化前后的对比）

---

### Step 4: 文档
**Status:** ⬜ Not Started

- [ ] README.md 加「Web Dashboard」小节：启动方式、端口、CLI 参数、与 /orch 的配合
- [ ] README 状态表更新 dashboard 一行

---

### Step 5: Delivery
**Status:** ⬜ Not Started

- [ ] Mark the task done with task_runner

---

## Execution Log

| Timestamp | Action | Outcome |
|---|---|---|
| 2026-08-13T17:59:27.670Z | Lane started | lane 6 |
| 2026-08-13T19:28:59.668Z | Lane started | lane 4 |
| 2026-08-13T19:38:36.488Z | Lane started | lane 1 |

| 2026-08-14T03:58:00.628808 | done (manual) | CLI /buju-dashboard 移植完成；dashboard 真机验证：localhost:8101 HTTP 200，/api/state 正常 |
