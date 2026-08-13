# Task: DEMO-005 — Summary A+C

**Created:** 2026-08-14
**Size:** S

## Review Level: 1 (Light)

## Mission

读取 Wave 1 两个 lane 的产物（`demo/data-alpha.md`、`demo/data-gamma.md`），
汇总生成 `demo/summary-ac.md`。本任务运行在 Wave 2，与 DEMO-004 **并行**
（各自独立 lane），依赖 DEMO-001 与 DEMO-003——同时验证依赖波次与波内并发。

## Dependencies

- DEMO-001
- DEMO-003

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None

## File Scope

- `demo/summary-ac.md`

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder

### Step 1: Read Upstream Outputs

- [ ] 确认 `demo/data-alpha.md` 与 `demo/data-gamma.md` 存在（上游 lane 已 merge 回 orch）
- [ ] 读取两个文件的标题行与数据行

### Step 2: Write Summary

- [ ] 创建 `demo/summary-ac.md`，包含：
  - 标题 `# Summary A+C`
  - 一行 `Tasks: DEMO-001 + DEMO-003`
  - alpha 与 gamma 各自的标题引用
  - 一行数据合计（alpha 数字之和 + gamma 数字之和）

### Step 3: Verify + Delivery

- [ ] 确认 `demo/summary-ac.md` 存在且内容完整
- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `demo/summary-ac.md` 存在，引用两个上游文件并给出数据合计

## Git Commit Convention

- **Implementation:** `feat(DEMO-005): summary-ac`
- **Checkpoints:** `checkpoint: DEMO-005 description`

## Do NOT

- 修改 `demo/data-alpha.md` / `demo/data-gamma.md`（上游产物只读）
- 创建 `demo/` 目录之外的文件

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
