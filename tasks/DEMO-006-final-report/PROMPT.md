# Task: DEMO-006 — Final Report

**Created:** 2026-08-14
**Size:** S

## Review Level: 1 (Light)

## Mission

读取 Wave 2 两个 lane 的汇总产物（`demo/summary-ab.md`、`demo/summary-ac.md`），
生成最终报告 `demo/final-report.md`。本任务运行在 Wave 3（依赖链末端）——
验证完整的 3 波次依赖 DAG 收口。

## Dependencies

- DEMO-004
- DEMO-005

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None

## File Scope

- `demo/final-report.md`

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder

### Step 1: Read Summaries

- [ ] 确认 `demo/summary-ab.md` 与 `demo/summary-ac.md` 存在
- [ ] 读取两份汇总的合计数字

### Step 2: Write Final Report

- [ ] 创建 `demo/final-report.md`，包含：
  - 标题 `# Buju Concurrency Report`
  - 一行 `Tasks: DEMO-001..DEMO-006`
  - 三个原始数据文件（alpha/beta/gamma）的标题引用
  - 两份汇总各自的合计行
  - 最终合计（两份汇总之和）
  - 一行结论：`Concurrency verified: N lanes in M waves`

### Step 3: Verify + Delivery

- [ ] 确认 `demo/final-report.md` 存在且数字正确
- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `demo/final-report.md` 存在，引用全部上游文件并给出最终合计与结论行

## Git Commit Convention

- **Implementation:** `feat(DEMO-006): final-report`
- **Checkpoints:** `checkpoint: DEMO-006 description`

## Do NOT

- 修改任何上游产物文件（只读）
- 创建 `demo/` 目录之外的文件

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
