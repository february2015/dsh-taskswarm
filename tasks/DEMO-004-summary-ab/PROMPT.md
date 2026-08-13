# Task: DEMO-004 — Summary A+B

**Created:** 2026-08-14
**Size:** S

## Review Level: 1 (Light)

## Mission

读取 Wave 1 两个 lane 的产物（`demo/data-alpha.md`、`demo/data-beta.md`），
汇总生成 `demo/summary-ab.md`。本任务运行在 Wave 2，依赖 DEMO-001 与 DEMO-002
——验证依赖波次：只有两个上游任务完成后本任务才会启动。

## Dependencies

- DEMO-001
- DEMO-002

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None

## File Scope

- `demo/summary-ab.md`

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder

### Step 1: Read Upstream Outputs

- [ ] 确认 `demo/data-alpha.md` 与 `demo/data-beta.md` 存在（上游 lane 已 merge 回 orch）
- [ ] 读取两个文件的标题行与数据行

### Step 2: Write Summary

- [ ] 创建 `demo/summary-ab.md`，包含：
  - 标题 `# Summary A+B`
  - 一行 `Tasks: DEMO-001 + DEMO-002`
  - alpha 与 beta 各自的标题引用
  - 一行数据合计（alpha 数字之和 + beta 数字之和）

### Step 3: Verify + Delivery

- [ ] 确认 `demo/summary-ab.md` 存在且内容完整
- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `demo/summary-ab.md` 存在，引用两个上游文件并给出数据合计

## Git Commit Convention

- **Implementation:** `feat(DEMO-004): summary-ab`
- **Checkpoints:** `checkpoint: DEMO-004 description`

## Do NOT

- 修改 `demo/data-alpha.md` / `demo/data-beta.md`（上游产物只读）
- 创建 `demo/` 目录之外的文件

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
