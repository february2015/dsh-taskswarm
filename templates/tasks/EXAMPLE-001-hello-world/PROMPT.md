# Task: EXAMPLE-001 — Hello World

**Created:** {{date}}
**Size:** S

## Review Level: 0 (None)

## Mission

Create a simple `hello-buju.md` file in the project root to verify that Buju
task execution is working correctly. This is a smoke test — if the worker can
read this prompt, create the file, checkpoint progress, and mark the task done,
the installation is healthy.

## Expected File Content

`hello-buju.md` should include:

- A title line (for example: `# Hello from Buju`)
- A line containing the task ID: `EXAMPLE-001`
- A line containing today's date

## Dependencies

- **None**

## Environment

- **Workspace:** Project root (the lane worktree)
- **Services required:** None

## File Scope

- `hello-buju.md`

## Steps

### Step 0: Preflight

- [ ] Verify this PROMPT.md is readable
- [ ] Verify STATUS.md exists in the same folder

### Step 1: Create Hello File

- [ ] Create `hello-buju.md` in the worktree root
- [ ] Add a title plus lines containing today's date and task ID `EXAMPLE-001`

### Step 2: Verification

- [ ] Verify `hello-buju.md` exists and matches the expected content

### Step 3: Delivery

- [ ] Mark the task done with task_runner

## Completion Criteria

- [ ] `hello-buju.md` exists in the worktree root
- [ ] `hello-buju.md` includes a title, task ID (`EXAMPLE-001`), and current date

## Git Commit Convention

- **Implementation:** `feat(EXAMPLE-001): description`
- **Checkpoints:** `checkpoint: EXAMPLE-001 description`

## Do NOT

- Modify any existing project files
- Create files outside the worktree root
- Over-engineer this — it's a smoke test

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
