# Task: WEB-006 — CLI 命令与真机验证

**Created:** 2026-08-14
**Size:** M

## Review Level: 2 (Standard)

## Mission

把 dashboard 变成 dsh-buju 的一等公民：`package.json` 加 `bin`/npm script 提供
`buju-dashboard`（对标上游 `taskplane dashboard`），orchestrator 插件注册
`/buju-dashboard` 命令（针对会话仓库启动服务并返回 URL），最后跑一轮真机验证：
真实 dsh web 会话里 `/buju-init` → `/orch` 跑批次，浏览器里看 dashboard 实时变化。

## Dependencies

- WEB-005 (前端联调完成，server 可用)

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** dsh CLI（`dsh --version` 可用）、本地浏览器

## File Scope

- `package.json` (修改：`bin` + `scripts.dashboard`)
- `src/orchestrator/index.ts` (修改：注册 `/buju-dashboard` 命令)
- `dashboard/server.mjs` (修改：入口文件头部 shebang，支持 bin 直跑)
- `README.md` (修改：Dashboard 使用小节)

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder
- [ ] 通读上游 package.json 里 dashboard 的注册方式（`bin/` 或 CLI 子命令）与 `src/orchestrator/index.ts` 的命令注册模式

### Step 1: CLI 入口

- [ ] `package.json` 加 `"bin": {"buju-dashboard": "dashboard/server.mjs"}`（server.mjs 头部加 `#!/usr/bin/env node`）
- [ ] 加 `"scripts": {"dashboard": "node dashboard/server.mjs"}`，`files` 数组加 `dashboard`
- [ ] `npm link` 或 `node dashboard/server.mjs --help` 验证 CLI 可用

### Step 2: /buju-dashboard 命令

- [ ] orchestrator/index.ts 注册 `buju-dashboard` 命令：用会话 cwd（与 ensureEngine 同一逻辑）解析 repoRoot，`spawn` 子进程 `node dashboard/server.mjs --root <repo> --no-open`，返回 `Buju Dashboard → http://localhost:<port>`
- [ ] 命令可重复调用：重复时提示已有实例或复用端口（简单起见：检测端口占用并提示 URL）
- [ ] 命令与 `/orch` 家族一样走 `withEngine` 错误包装

### Step 3: 真机验证（核心）

- [ ] `npm run build && npm test` 全绿
- [ ] 启动 dashboard：`npm run dashboard -- --root <demo-repo>`
- [ ] dsh web（localhost:3080）新会话：`/buju-init` → `/orch-plan all` → `/orch all`
- [ ] 浏览器打开 dashboard URL：批次出现 → lanes 从 pending→running→review→merged 实时变化 → 进度条/百分比推进 → 任务 STATUS.md 可点开
- [ ] `/orch-status` 与 dashboard 显示一致（同一数据源交叉验证）
- [ ] 截图存档（页面 + 一个实时变化前后的对比）

### Step 4: 文档

- [ ] README.md 加「Web Dashboard」小节：启动方式、端口、CLI 参数、与 /orch 的配合
- [ ] README 状态表更新 dashboard 一行

### Step 5: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `buju-dashboard` bin 与 `/buju-dashboard` 命令可用（本地验证）
- [ ] 真机验证通过：真实 batch 全程在 dashboard 实时可见，SSE 无断流
- [ ] README 更新；截图存档

## Git Commit Convention

- **Implementation:** `feat(WEB-006): dashboard CLI + /buju-dashboard command`
- **Checkpoints:** `checkpoint: WEB-006 description`

## Do NOT

- 把 dashboard 进程常驻进 dsh web——保持上游「独立本地服务」模型
- 引入任何前端构建链（Vite/webpack）——上游就是纯静态 + 零依赖 server
- 跳过真机验证——这是本任务与纯代码任务的区别

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
