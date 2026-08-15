# TaskSwarm Runbook (Ops)

> This manual is the standard operating procedure (SOP) for **supervisors / AI agents / human operators** operating TaskSwarm batches.
> Goal: anyone (or any AI) who installs this tool can, when encountering the scenarios below, diagnose, handle, and recover step by step without losing work.
>
> It covers three major categories:
>
> - **Daily operations** (Part A): installation/build/activation, task package operations, execution-time monitoring
> - **Exception handling** (Part B): leftover cleanup, error recovery, work salvage
> - **Reference** (Part C): action classification, wave dependency semantics, known-issues links
>
> All commands use the repo root as cwd (e.g. `~/myProject/tswarm`). Action classification (diagnostic /
> tier0_known / destructive) matches the supervisor autonomy rules, see §9.

---

# Part A Daily Operations

## 1. State Model Overview (Understand the State First, Then Act)

TaskSwarm's **single authoritative state** is the on-disk `.taskswarm/`, not memory. After a process restart, the
engine's in-memory state is cleared, leaving only the disk state — so all recovery starts by reading `.taskswarm/`.

```
<repo>/
├── .taskswarm/
│   ├── batches/<batchId>.json   # batch's single authoritative state (phase + lanes[])
│   ├── mailbox/<batchId>/       # async messages between agents (supervisor/inbox, <lane>/outbox, broadcast)
│   └── worktrees/
│       ├── _orch/               # resident worktree of the taskswarm/orch integration branch (engine infrastructure, do not delete)
│       └── <taskId>/            # isolated worktree for each lane
├── tasks/<ID>-<slug>/
│   ├── PROMPT.md                # task mission/steps (above the separator line is immutable)
│   ├── STATUS.md                # owned by worker: **Status:** status line + Execution Log
│   ├── .DONE                    # created by the engine when merged (its presence = task completed, not scanned by default)
│   └── .reviews/                # reviewer conclusion files (content includes PASS / REVISE)
└── .git/                        # lock files such as index.lock
```

**Batch phase**: `planning → running → paused → aborted | complete`
**Lane phase**: `pending → running → review (REVISE) → merged | failed` (also `skipped`, `conflict`)
`conflict` (since 2026-08-15): a merge conflict that the LLM merger agent could not resolve puts the
lane in this phase; the batch **auto-pauses at the wave boundary** (phase=paused) awaiting the
supervisor — fix the merge manually in the `_orch` worktree then `resume`, or decide to rerun the
lane (see §7.1). The scene (lane worktree / branch / orch conflict state) is fully preserved.

**git branch conventions**:

| Branch              | Role                                               | Lifecycle                                    |
| --------------- | ------------------------------------------------ | ------------------------------------------ |
| `taskswarm/orch`     | Integration branch; all lane outputs are aggregated here | Resident, auto-created by the engine, **do not delete** |
| `taskswarm/<taskId>` | Working branch of a single lane (checkpoint commits live here) | Deleted after a successful merge; **leftover** after failure/abort/crash |

**Key mechanisms** (code basis `src/core/worktree.ts`, `src/orchestrator/engine.ts`):

- **Checkpoint discipline**: the worker performs checkpoint commits to `taskswarm/<taskId>` at step boundaries
  and on exit. A process crash does not lose already-committed outputs — this is the foundation of salvage.
- **Automatic resumption on rerun**: if `createLaneWorktree` finds that the `taskswarm/<taskId>` branch already
  exists, it runs `git worktree add <branch> <dir>` to **attach the existing branch** instead of creating
  a new one (KI-004 fix). So rerunning a failed task = continuing from old checkpoints, not from scratch.
- **abort semantics**: cooperative, takes effect at wave boundaries; kills running lanes and `worktree remove`s
  all lane worktrees, but **`taskswarm/<taskId>` branches are kept** (for troubleshooting/salvage).
- **Process crash/restart**: the engine's `active` in-memory table is cleared → `pause / resume / abort` all
  become no-ops ("No running batch"); the disk state stays as it was right before the crash (possibly
  phase=running but no engine running).

---

## 2. Daily Operations Quick Reference

| Scenario                      | How to determine                             | Classification | Standard action                              |
| ----------------------- | ---------------------------------------- | ----------- | ------------------------------------------ |
| Check batch status            | `/tswarm-status` or read `.taskswarm/batches/*.json` | diagnostic  | Verify directly, no confirmation needed      |
| View wave plan / dependency graph | `/tswarm-plan [scope]`, `/tswarm-deps`        | diagnostic  | Read-only, just do it                       |
| List active lanes and worktrees | `/tswarm-sessions`                         | diagnostic  | Read-only, just do it                       |
| View worker session logs / mailbox | `~/.dsh/sessions/…`, `.taskswarm/mailbox/…`    | diagnostic  | §5.3 / §5.4                                |
| Enable/disable periodic reports | "Report every X minutes"                    | tier0_known | `tswarm_supervisor_report_interval <N>` (0=off) |
| pause / resume               | phase=paused or running                     | tier0_known | `tswarm_supervisor_control pause/resume`     |
| Clear `.git/index.lock`     | `ls .git/index.lock` (confirm no git process) | tier0_known | `rm .git/index.lock`                       |
| Retry a failed merge         | lane error="merge failed: ..."              | tier0_known | Resolve conflicts, then retry               |
| GUI not effective after src changes | behavior is still the old one               | —           | `npm run build` + restart dsh web (§3.2)    |
| Create a new task package    | task missing under tasks/                   | —           | `/tswarm-init` or hand-write per §4.1         |
| Manually change task status / delete .DONE | status doesn't match reality               | destructive | Confirm, then per §4.4                      |
| Delete leftover lane branches | `git branch` shows `taskswarm/<id>`              | destructive | Verify merged into orch first, then `git branch -D` (§6.2) |
| Delete leftover worktree     | `git worktree list`                         | destructive | Salvage uncommitted content first, then `worktree remove --force` (§6.3) |
| Delete mailbox / batch records | `ls .taskswarm/mailbox`, `.taskswarm/batches`       | destructive | `rm -rf` (tradeoffs in §6.4/§6.5)           |
| abort batch                  | phase=running                               | destructive | `tswarm_supervisor_control abort`             |
| integrate to working branch  | after the batch completes                   | destructive | `tswarm_supervisor_control integrate`         |
| Modify STATUS/.DONE/batch state | —                                        | destructive | Ask the operator to confirm first           |
| Recovery after process crash/restart | phase stuck at running, abort reports no-op | destructive | Follow the six steps in §7.4                |

> Autonomy rules (default supervised): diagnostic / tier0_known run automatically; destructive actions ask
> for one line of confirmation first. In autonomous mode everything is autonomous; in interactive mode,
> everything non-diagnostic must be asked.

---

## 3. Installation / Build / Activation / Configuration

### 3.1 Installing into DSH

```bash
cd ~/myProject/tswarm && npm run build
dsh plugin --profile web add ~/myProject/tswarm   # append the taskswarm bundle to the web profile
# after restarting dsh web, in-session: /tswarm-init → /tswarm all → /tswarm-status
```

Uninstall: `dsh plugin --profile web remove taskswarm` (a restart is also required for it to take effect).

> Publishing to npm / version management (maintainers): see `docs/release.md`.

### 3.2 Rules for Changes to Take Effect (Common Misconceptions)

- `src/` code changes (including supervisor prompts, tool behavior) → require `npm run build` + **restarting
  the dsh web process** to take effect; the bundle compiled by `tsc` lives inside the process, no hot reload.
- `docs/`, `README.md` and other pure documentation changes → no build needed.
- `tasks/` task package changes → take effect immediately (visible at the next scan/planning).

### 3.3 Configuration Quick Reference (`src/orchestrator/index.ts` Config)

| Config                                   | Default                                     | Description                                             |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `repoRoot` / `tasksRoot` / `stateRoot` | session cwd / `<repo>/tasks` / `<repo>/.taskswarm` | the three root paths for repo, task packages, and state |
| `host`                                 | `in-process`                             | `headless` runs via the `dsh --profile taskswarm-worker` subprocess |
| `workerModel` / `reviewerModel`        | session default                          | worker / reviewer model overrides                      |
| `includeDoneTasks`                     | false                                     | when true, tasks with `.DONE` are also scanned (rerun completed tasks) |
| `supervisorMode`                       | `supervised`                             | `off` / `interactive` / `supervised` / `autonomous` (autonomy level) |
| `supervisorCheckIntervalMs`            | 60000                                    | periodic check interval (1 minute, read-only, zero cost) |
| `supervisorStalledMs`                  | 420000                                   | stalled detection threshold (7 minutes without lane changes) |
| `locale`                               | `auto`                                   | supervisor notification/prompt language: `auto` (detect from session) / `zh-CN` / `en`. Switchable at runtime by text, persisted to `.taskswarm/config.json` (see §3.5) |

### 3.5 Repository-level Config File (`.taskswarm/config.json`)

Runtime settings set by text persist in `<repo>/.taskswarm/config.json` and **survive restarts**.
Precedence: **config.json (runtime, latest intent) > plugin `Config` (installer default) > built-in default**.

| Key | Value | How to set (by text) |
|---|---|---|
| `locale` | `zh-CN` / `en` (`auto` is expressed by removing the key) | "use English" / "use Chinese" / "restore auto" → `tswarm_supervisor_locale` tool |
| `reportIntervalMinutes` | integer ≥ 0 (0 = off) | "report every 15 minutes" → `tswarm_supervisor_report_interval` tool |

Candidate future keys (design slots, read at engine creation): `supervisorMode`,
`workerModel`, `reviewerModel`, `includeDoneTasks`, `mergerModel`, `mergerTimeoutMinutes`,
`mergeVerifyCommands`. The file is merge-written JSON,
so new keys never break older readers.

Language auto-detection: in `auto` mode the supervisor samples the batch-owner
session's recent user messages and uses a CJK-ratio heuristic (Chinese session →
zh-CN, otherwise → en; no signal falls back to zh-CN).

### 3.4 Multiple Repos / Multiple Workspaces

- Each repo (repoRoot) gets an independent engine instance + independent dashboard instance; ports auto-avoid
  (starting at 8100, +1 if occupied, up to 20 probes).
- Events are only sent back to the session that launched the batch (batch owner); no cross-session message leakage.

---

## 4. Task Package Operations (Create / Format / Manual Fixes)

### 4.1 Creation

- Quick example: `/tswarm-init` (scaffolds `EXAMPLE-001-hello-world`, `EXAMPLE-002-parallel-smoke`;
  passing a prefix like `/tswarm-init WEB` generates WEB-001/WEB-002).
- In an empty project, `start all` also auto-initializes example tasks (`autoInitIfEmpty`).
- Hand-written: create a `<ID>-<slug>/` directory under `tasks/`, and put `PROMPT.md` + `STATUS.md` in it.

### 4.2 PROMPT.md Format Spec (`src/core/task.ts` parsing rules)

```
# Task: <ID> — <Name>          ← required; ID of the form [A-Z]+-\d+ (inferred from the directory name when absent)
**Size:** S | M | L | XL
## Review Level: 2              ← optional
## Dependencies                 ← dependencies: `- <ID>` or `**Requires:** <ID>` (multiple allowed)
## Mission
### Step 1: <Title>
- [ ] <todo item>                  ← checklist item for the step
## Completion Criteria
- [ ] <acceptance item>
## File Scope                   ← optional; declares the affected files
```

- Dependencies determine the wave DAG; unknown dependency IDs do not block (§10.2).
- Amendments added during execution: write them under `## Amendments (Added During Execution)` below the
  separator line `---`.

### 4.3 STATUS.md Fields (owned by worker, read by engine/tools)

| Field                | Values                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `**Status:**`       | 🔵 Ready / 🟢 In Progress / 🟡 In Review / ✅ Complete / ❌ Blocked |
| `**Current Step:**` | name of the current step                                          |
| `**Blocker:**`      | optional; fill in the blocking reason when ❌                     |
| `**Iteration:**`    | iteration count                                                   |
| Execution Log table | `                                                                |

When a lane finishes, the engine determines: STATUS being ✅ or ❌ (or `.DONE` existing) counts as "done";
otherwise the lane is judged failed (`task not marked done`). `.DONE` is created by the engine on merge.

### 4.4 Manual Fixes (destructive, requires confirmation)

- **Task actually done but not marked**: change the STATUS status line to ✅ (or manually create `.DONE`),
  then re-run the judgment.
- **Marked done by mistake, want to rerun**: delete `tasks/<ID>/.DONE` **and change the STATUS status line
  back to non-✅** (deleting only `.DONE` is not enough — ✅ also counts as done when parsed).
- **Skip a task entirely**: hand-editing phase is not recommended; better to abort and run only the needed
  tasks by scope.

---

## 5. Execution-Time Monitoring and Troubleshooting

### 5.1 Stalled Detection (Enabled by Default, Zero Cost)

- Reads state every 60s (`checkIntervalMs`); if a lane's `taskId:phase` fingerprint shows **no change for
  7 minutes** (`stalledMs`) **and** the worker session logs of all running lanes are also past their timeout
  → fire one "possibly stalled" reminder.
- Session log still being written = the worker is working (lane phase doesn't change while writing large
  code blocks), so no false positives.
- After receiving the reminder: diagnostic-verify the lane logs → decide to keep waiting / pause / abort.

### 5.2 Periodic Reports

- Off by default; enabled when the operator says "report every X minutes" (`tswarm_supervisor_report_interval`).
- 0 = off; after setting, the report fires at the first complete interval, not immediately.
- The interval persists to `.taskswarm/config.json` (`reportIntervalMinutes`) and **survives restarts**;
  the copy follows the current language (`locale`), bilingual.

### 5.3 Worker Session Logs (the Scene for Troubleshooting Failures/Stalls)

Worker session directories are named by escaping the lane worktree absolute path:

```bash
ls ~/.dsh/sessions/--<worktree path with / replaced by - >--/
# example: --Users-robin-myProject-taskswarm-.taskswarm-worktrees-demo-006--
# under it, session-*/session.jsonl(.zstd) hold the full conversation/tool-call records
```

### 5.4 mailbox Troubleshooting (What the Worker Is Saying)

```bash
ls .taskswarm/mailbox/<batchId>/supervisor/inbox/      # unprocessed messages
ls .taskswarm/mailbox/<batchId>/supervisor/ack/        # acked messages
# each file is json: { from, type, payload }; type ∈ notify/escalate/request/broadcast/reply
```

- `escalate` = worker asking for help (historical case: worker escalating for missing tools, see KI-002 symptom).
- When the engine ends a batch it drains the supervisor inbox; crash leftovers are kept as-is and can serve
  as a troubleshooting scene.

---

# Part B Exception Handling

## 6. Leftover Cleanup

### 6.1 Inventory of Leftovers

```bash
git worktree list                        # all worktrees (<taskId> ones other than _orch are lane leftovers)
git branch | grep -E 'taskswarm/'             # lane branches (taskswarm/orch is resident — don't touch it)
ls .taskswarm/batches/ 2>/dev/null            # historical/leftover batch records
ls .taskswarm/mailbox/ 2>/dev/null            # historical/leftover mailbox
ls .taskswarm/worktrees/                      # everything other than _orch is lane worktree leftover
```

### 6.2 Deleting Leftover Lane Branches (Safe Precondition: Already Merged into taskswarm/orch)

`git branch -d` only recognizes "merged into the current branch (master)"; lane branches were only merged
into `taskswarm/orch`, so `-d` refuses. **Verify each one is merged into orch first, then use `-D`**:

```bash
# verify (do for every branch; delete only when it prints MERGED)
git merge-base --is-ancestor taskswarm/<taskId> taskswarm/orch && echo "MERGED: <taskId>"
# delete (only after verified safe)
git branch -D taskswarm/<taskId>
```

> Why it's safe: `merge-base --is-ancestor` returning true = all commits of that branch are already on
> `taskswarm/orch`, so nothing is lost. Before batch-deleting, list the verification results for the operator.

### 6.3 Deleting Leftover Worktrees

```bash
# first check for uncommitted/not-yet-committed work (salvage first, see §8.2)
git -C .taskswarm/worktrees/<taskId> status --short
# delete only after confirming no valuable content
git worktree remove --force .taskswarm/worktrees/<taskId>
git worktree prune          # clean orphan entries from the registry
```

> Crash-leftover worktree directories may lack corresponding registry entries; `prune` covers that.
> **Never hand-delete the directory without going through `git worktree remove`**, otherwise registry
> leftovers will cause later `worktree add` conflicts (KI-004 lesson).

### 6.4 Clearing the mailbox

```bash
rm -rf .taskswarm/mailbox/<batchId>
```

The mailbox is just inter-agent message files; deleting has no side effects (the engine drains it when
ending; crash leftovers can be deleted directly).

### 6.5 Clearing Batch Records (Tradeoffs)

```bash
rm .taskswarm/batches/<batchId>.json
```

- After deletion, `/tswarm-status` returns to "No TaskSwarm batch yet", and you can cleanly start a new batch.
- **Tradeoff**: the dashboard's data source is `.taskswarm/batches/*.json` — deleting it makes the batch disappear
  from dashboard history. If you want to keep audit history, keep the file (changing phase to `aborted` is
  more honest, see §7.4 step 2).

### 6.6 Things You Must Not Touch

- The `taskswarm/orch` branch and `.taskswarm/worktrees/_orch/` — engine infrastructure; if deleted the engine
  auto-recreates them, but there's no need.
- The `.DONE` / `STATUS.md` artifacts of already-merged task directories, and uncommitted `src/` changes —
  these are not "leftovers".

---

## 7. Post-Error Cleanup and Recovery

### 7.1 Lane Failure (phase=failed)

Determination: in the batch json, `lane.error` + `log` give the reason. Three common forms:

| error shape                      | meaning                           | handling                          |
| ----------------------------- | ----------------------------- | --------------------------- |
| `worker exited 1` (exitCode≠0) | worker process exited abnormally | read the worker session log for the reason (§5.3), fix, then rerun |
| `task not marked done`        | worker exited normally but STATUS.md is not ✅/❌ | judge whether the work is done; rerun, or mark and rerun (§4.4) |
| `merge failed: ...`           | conflict merging into orch      | the engine first tries the LLM merger agent (below); if it still fails, investigate and resolve in the `_orch` worktree |

**LLM merger agent (introduced 2026-08-15, v0.2.15)**: when a lane's `git merge` into
`taskswarm/orch` fails (conflict), the engine spawns an independent merger agent inside the
`_orch` worktree to **resolve the conflict semantically** (read both sides' intent → edit files →
finish the merge commit) — "two workers editing the same file" conflicts no longer need manual
intervention. Mechanics:

- The failure scene is **fully preserved**: lane worktree, `taskswarm/<taskId>` branch, and the
  orch conflict state are never cleaned up, so a human can step in anytime (no more `branch -D`
  destroying the scene).
- Lane merges within a wave run **serially** (concurrent `git merge` is rejected by git's lock).
- A stuck merger has a watchdog (`mergerTimeoutMinutes`, default 10 min): on timeout it preserves
  the scene and returns unresolved without blocking later merges in the queue.
- After resolving, optional verification commands run (`mergeVerifyCommands`, e.g. `["npm test"]`).
- Config: `mergerModel`, `mergerTimeoutMinutes`, `mergeVerifyCommands`.

Rerunning a failed lane (not-done tasks are re-scanned by default):

```
/tswarm <taskId>       # or tswarm_supervisor_control start scope=<taskId>
```

Because the `taskswarm/<taskId>` branch still exists, the new worktree **attaches the old branch** — continuing
from old checkpoints rather than from scratch.

### 7.2 REVISE (phase=review)

When the reviewer's conclusion is REVISE, the lane enters `review` and the task is not marked done. Handling:

1. Read `tasks/<ID>/STATUS.md` and the latest conclusion under `.reviews/` to see what the reviewer wants changed;
2. After revising, rerun the task (same as §7.1); the reviewer writes a new verdict file, and the engine only
   recognizes the latest one.

### 7.3 After abort

- Batch phase=`aborted`; lane worktrees have been removed by the engine; **`taskswarm/<taskId>` branches remain**.
- Handling: verify each is merged then delete the branch per §6.2; delete the mailbox per §6.4; keep the batch
  record (history) or delete it.
- Want to continue: abort is a terminal state, **resuming is not supported** — salvage the outputs (§8), then
  start a new batch per §7.4.

### 7.4 After a Process Crash / Restart (the Most Important Recovery Scenario)

Symptoms: after restart, `/tswarm-status` shows the batch phase stuck at `running` (or planning/paused), but
`abort`/`resume`/`pause` all report "No running batch" (engine memory is empty), and the supervisor's
`start` rejects a new batch due to the phase=running/planning protection.

**Six recovery steps** (a complete, tested flow):

```bash
# ① take stock of the scene: batch state + leftovers
cat .taskswarm/batches/<batchId>.json        # see which lanes are merged / failed / running
git worktree list
git branch | grep -E 'taskswarm/'

# ② change the stuck batch's phase to aborted (or delete the record file) — unlock the start protection
#    change "phase": "aborted" in the json (terminal semantics; dashboard history is also kept)

# ③ salvage valuable outputs (§8) — checkpoints of failed/running lanes are on the taskswarm/<taskId> branch

# ④ clean up leftovers: after verifying merge, delete lane branches (§6.2), leftover worktrees (§6.3), and the mailbox (§6.4)

# ⑤ re-plan the remaining work
/tswarm-plan all            # see which tasks remain (failed/pending get re-scanned)

# ⑥ start a new batch (scope the remaining tasks to avoid re-running already-merged ones)
/tswarm <remaining task IDs...> or tswarm_supervisor_control start scope=<taskId>
```

Key point: crash recovery = **salvage first, then clean up, then rerun** — don't reverse the order
(deleting first forfeits the salvage opportunity).

### 7.5 Other Common Failures

- **`.git/index.lock`**: leftover from a killed git process. Confirm no git is running → `rm .git/index.lock`
  (tier0_known, do it automatically).
- **`could not create lane worktree`**: old leftovers blocking. The engine has built-in cleanup (KI-004 fix);
  if it still fails, manually `git worktree prune` + clean same-named branches/directories per §6.2/§6.3, then retry.
- **dashboard fails to start**: `tswarm_dashboard` reports outputs not merged → run `integrate` first;
  port occupied → the engine auto-avoids, or specify manually with `--port`.
- **worker has no tools / sandbox approval popups**: fixed (KI-002/KI-005); worker sessions carry
  full-access + no approval by default; GUI sessions and global configuration are unaffected. If it still
  occurs, check the worker tool assembly.

---

## 8. Work Salvage

"Salvage" = retrieving the **work already produced** from failed lanes / crashed processes and landing it.
Project precedent: WEB-006 (cli-integration) salvaged the dashboard server during the batch;
`/tswarm-dashboard` in `src/orchestrator/index.ts` is "ported from WEB-006's salvage implementation".

### 8.1 Where the Salvageable Artifacts Are

| Artifact location                              | When it exists                 | How to retrieve                                                     |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| checkpoint commits on the `taskswarm/<taskId>` branch | committed before worker exit/crash | `git log --oneline taskswarm/<taskId>`; the content is on the branch |
| uncommitted files in the lane worktree          | not committed before the crash | `git -C .taskswarm/worktrees/<taskId> status` → commit/stash first, then clean up |
| lane outputs already merged on `taskswarm/orch`      | the parts merged successfully within waves | final unified `integrate`                              |

### 8.2 Salvage Steps

```bash
# ① list the checkpoints on the failed lane's branch
git log --oneline taskswarm/<taskId>

# ② inspect the artifacts (diff against master, or check out to a temporary location)
git diff master taskswarm/<taskId> --stat

# ③ choose a way to land them:
#   a) manually merge into orch (lands together with the later integrate)
#      git -C .taskswarm/worktrees/_orch merge --no-edit taskswarm/<taskId>
#   b) cherry-pick key commits onto the current branch
#      git cherry-pick <commit>
#   c) simply rerun the task to continue (checkpoints carried over automatically, §7.1)
```

### 8.3 Formal Landing: integrate

After the batch completes (or after salvaged outputs are merged into orch), merge `taskswarm/orch` into the
working branch:

```
/tswarm-integrate        # = git merge --no-edit taskswarm/orch
```

This is the **only official entry point** for lane outputs (including salvaged ones) to reach the working
tree. Classified destructive; in supervised mode, ask for confirmation first.

---

# Part C Reference

## 9. Action Classification and Autonomy (Supervisor's Perspective)

Source: `ACTION_CLASSIFICATION_EXAMPLES` in `src/orchestrator/supervisor.ts`.
The AI uses this to decide which actions can be done automatically and which must be asked first.

| Classification               | Actions included                                                                                              | Autonomy rule                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **diagnostic** (always allowed) | read `.taskswarm/batches/*.json`, `tasks/*/STATUS.md`, lane logs; `git status/log/diff/worktree list`; run tests; `tswarm_supervisor_status` | just do it at all levels |
| **tier0_known** (known recovery) | retry failed merges; resume / pause; clear `.git/index.lock`; clean stale worktrees before retrying                        | automatic in supervised |
| **destructive** (needs confirmation) | abort; integrate; `git reset / checkout -B / branch -D`; `git worktree remove`; modify STATUS/.DONE/batch state files; skip tasks/waves | ask for one line of confirmation in supervised |

## 10. Wave Dependencies and Boundary Behavior (Understand the Engine, Avoid Misjudgment)

1. **Failed lanes do not block later waves**: the engine advances wave by wave; if wave 1 has a lane failure,
   wave 2 still runs — but downstream tasks may fail for lack of upstream outputs. When planning/rerunning,
   fix upstream first, then run the tasks that depend on it.
2. **Unknown dependency IDs**: treated as satisfied, and shown in `Unresolved dependency references`;
   they do not block planning (`buildWaves`).
3. **Dependency cycles**: when layering is impossible, force waves in the remaining order (shown as the same
   wave); the task package needs manual fixing.
4. **start protection**: the supervisor's start refuses to open a new batch while phase=running/planning;
   the `/tswarm` command itself has no protection — running `/tswarm` directly after a crash opens a new batch
   that collides with leftovers; recover per §7.4 first.
5. **Empty project**: `start all` / `/tswarm all` auto-scaffold example tasks (EXAMPLE-001/002).
6. **scope syntax**: `all` | task IDs (e.g. `DEMO-004`) | paths (absolute/relative), space-separated
   multiple tokens; matches task IDs or directory names.
7. **Rerunning completed tasks**: tasks with `.DONE` are scanned only when configured with
   `includeDoneTasks: true`; otherwise reset a single task manually per §4.4.

## 11. Relationship to known-issues

- **KI-004** (leftovers after a kill block new batches) fixed: `createLaneWorktree` auto-cleans leftover
  directories and attaches the existing branch. §6/§7.4 of this manual are the post-fix "manual fallback" path.
- **KI-003** (concurrent batch-state writes overwrite each other) fixed: lane persistence goes through the
  single-lane targeted `updateLane`. If you see state not matching reality, suspect old engine artifacts
  first; clean up per §6 and rerun.
- **KI-002 / KI-005** (missing worker tools / sandbox approval) fixed: worker sessions carry the standard
  tool set + full-access + no approval; `escalate` messages are the troubleshooting lead for these two
  problems (§5.4).
- **KI-001** (worker sessions polluting the sidebar) fixed: internal sessions are auto-hidden.
- Known issues not covered by this manual: see `docs/known-issues.md`.
