# Review 1 — code step 2

**Verdict:** PASS

# Review: DEMO-005 Step 2 (Code)

## What was checked

- `git diff HEAD~1 HEAD` — single commit `f69598b feat(DEMO-005): summary-ac`, touching only `demo/summary-ac.md` (+8 lines).
- Content vs PROMPT.md Step 2 / Completion Criteria, and data accuracy vs actual upstream objects (`b45e0fd:demo/data-alpha.md`, `d2f4b21:demo/data-gamma.md`).

## Verdict: PASS

**Findings summary:**

1. **Scope compliant** — the only change is `demo/summary-ac.md`; no upstream files touched, nothing outside `demo/`. Commit message matches convention `feat(DEMO-005): summary-ac`.

2. **Content complete (Step 2 / completion criteria)** — file has `# Summary A+C`, the `Tasks: DEMO-001 + DEMO-003` line, title references to both upstream files (with paths + commit refs), and a total line.

3. **Data is accurate** — verified against the real objects: alpha `10+20+30=60` (b45e0fd), gamma `7+14+21=42` (d2f4b21), total `102` — all correct.

4. **Upstream caveat (not DEMO-005's fault, flag for merge):** the mission's Step 1 precondition ("上游 lane 已 merge 回 orch") was only partially true. `demo/data-gamma.md` is merged into `buju/orch`, but `demo/data-alpha.md` exists only as a **dangling commit** `b45e0fd` (DEMO-001 lane never merged; the worktree/`orch`/any branch has no `data-alpha.md`, and `buju/demo-005` is based on `master`, not `orch`). The worker handled this gracefully by citing the exact commit/content, and the math is right — but when `buju/demo-005` is merged back into `orch`, the `demo/data-alpha.md` reference will dangle unless DEMO-001's output is also brought in.

5. **Step 3 pending** — STATUS.md shows Verify + `task_runner` done-marking not yet performed; expected to follow this review gate, not a code defect.
