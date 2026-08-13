# Task: DEMO-001 — Data Alpha

**Created:** 2026-08-14
**Size:** S

## Review Level: 1 (Light)

## Mission

在 lane worktree 的 `demo/` 目录下创建一个数据文件 `data-alpha.md`，验证 Buju 的
多步执行 + checkpoint 提交流程。本任务与 DEMO-002/DEMO-003 无依赖，运行在
Wave 1，与它们并行（各自独立 lane）。

## Dependencies

- **None**

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None

## File Scope

- `demo/data-alpha.md`

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder

### Step 1: Create Data File

- [ ] 创建 `demo/` 目录（如不存在）
- [ ] 创建 `demo/data-alpha.md`，包含：
  - 标题行 `# Data Alpha`
  - 一行 `Task: DEMO-001`
  - 一行今天的日期
  - 3 行数字数据（如 10/20/30）

### Step 2: Verify Content

- [ ] 用文件工具确认 `demo/data-alpha.md` 存在
- [ ] 确认包含标题、任务 ID、日期三行

### Step 3: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `demo/data-alpha.md` 存在，包含标题、`Task: DEMO-001`、今天日期、3 行数字

## Git Commit Convention

- **Implementation:** `feat(DEMO-001): data-alpha`
- **Checkpoints:** `checkpoint: DEMO-001 description`

## Do NOT

- 修改 `demo/data-beta.md` 或 `demo/data-gamma.md`（那是其他 lane 的产物）
- 创建 `demo/` 目录之外的文件

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
