# Task: WEB-001 — 前端资源移植（TaskPlane dashboard → Buju）

**Created:** 2026-08-14
**Size:** S

## Review Level: 2 (Standard)

## Mission

把 TaskPlane 的 dashboard 前端资源原样搬进 dsh-buju 并做品牌替换。TaskPlane 的
`dashboard/public/` 由 4 个文件组成（`index.html` 139 行、`app.js` 2799 行、
`style.css` 1988 行、2 个 svg logo），前端通过固定 DOM id 与后端 JSON 契约
耦合——本任务只负责**搬运 + 换皮**，不改任何结构，保证后续 WEB-005 联调时
app.js 的 `$("id")` 全部找得到元素。

## Dependencies

- **None**

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None

## File Scope

- `dashboard/public/index.html` (copy + rebrand)
- `dashboard/public/app.js` (copy, 本任务不改逻辑)
- `dashboard/public/style.css` (copy)
- `dashboard/public/buju-word.svg` (new, 替换 taskplane-word-white.svg)
- `dashboard/public/taskplane-word-color.svg` → 删除或保留为占位

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder
- [ ] 确认上游源码可读：`/tmp/taskplane/dashboard/public/` 或重新 `git clone --depth 1 https://github.com/HenryLach/taskplane`
- [ ] 记录上游 commit hash 到 STATUS.md（溯源用）

### Step 1: 搬运前端文件

- [ ] 复制 `index.html`、`app.js`、`style.css` 到 `dashboard/public/`
- [ ] 复制 svg logo，新建 `buju-word.svg`（白色文字版，Buju 字样）
- [ ] 确认 `dashboard/public/` 目录结构与上游一致

### Step 2: 品牌替换（只动 index.html）

- [ ] `<title>Taskplane Dashboard</title>` → `<title>Buju Dashboard</title>`
- [ ] header logo `taskplane-word-white.svg` → `buju-word.svg`
- [ ] footer「Orchestrator Web Dashboard」→「Buju Dashboard」
- [ ] 其余 DOM id/class/结构一行不改

### Step 3: 结构一致性检查

- [ ] 用 `grep -c 'id="' app.js` 与 index.html 中出现的 id 交叉核对，列出 app.js 引用的所有 id 在 index.html 都存在
- [ ] 确认 app.js 未引用任何被删除的元素（如 supervisor/agents/messages 面板的 id 必须保留）

### Step 4: 冒烟

- [ ] `node -e "require('./dashboard/public/app.js')"` 语法检查通过（或用 `node --check`）
- [ ] 本地起一个临时静态服务打开 index.html，确认无 404（未连后端，允许 JS 报 fetch 错误）

### Step 5: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `dashboard/public/` 下 4+ 个文件就位，`index.html` 标题/logo/footer 已换为 Buju
- [ ] app.js 引用的全部 DOM id 在 index.html 中存在
- [ ] app.js / style.css 与上游字节级一致（或仅注释级差异，git diff 可审计）

## Git Commit Convention

- **Implementation:** `feat(WEB-001): port TaskPlane dashboard frontend`
- **Checkpoints:** `checkpoint: WEB-001 description`

## Do NOT

- 修改 app.js / style.css 的任何逻辑（那是 WEB-005 的事）
- 删除 supervisor/agents/messages/terminal 面板的 DOM 结构——它们靠空态兜底
- 引入任何 npm 依赖或构建步骤

---

## Amendments (Added During Execution)

- **WEB-001-A1 (2026-08-14):** `app.js` swaps the header logo at runtime via `applyTheme()`:
  `DARK_LOGO = "taskplane-word-white.svg"` (applied on every load, incl. dark fallback) and
  `LIGHT_LOGO = "taskplane-word-color.svg"` (light-mode toggle). Both files must therefore exist in
  `dashboard/public/` or the logo 404s. They are kept as **Buju-branded placeholder SVGs** (white and
  blue `#0969da` wordmarks) rather than byte-identical TaskPlane copies — this deviation is allowed by
  the file scope ("taskplane-word-color.svg → 删除或保留为占位") and keeps app.js untouched. WEB-005
  must keep these two filenames present.

