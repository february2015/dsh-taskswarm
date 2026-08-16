# Changelog

All notable changes to **dsh-taskswarm** (TaskSwarm 蜂群) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project uses
[Semantic Versioning](https://semver.org/). 中文版见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## [0.2.32] - 2026-08-16

### Changed

- **Every supervisor notification now ends with an explicit no-restate instruction** — previously
  the "don't translate / don't restate, only judge anomalies" rule lived only in the system prompt;
  now each wake message (started / wave complete / lane failed / periodic report / stalled / batch
  complete) also carries a one-line reminder (bilingual), so the model never re-explains the
  status back to the user even if the system prompt gets diluted by long context.

## [0.2.31] - 2026-08-16

### Fixed

- **Wave plan is now fixed at batch start and never recomputed mid-flight** — previously,
  pause/resume and crash recovery re-ran `buildWaves` on the remaining (not-yet-done) tasks, so a
  batch originally planned as 3 waves could silently shrink to 2 after a pause (completed wave's
  tasks dropped out of the recompute). The wave structure is now persisted in
  `BatchState.wavePlan` at start and reused verbatim on resume/recovery; completed lanes are
  skipped by the existing "merged" logic, remaining tasks keep their original wave numbers.
  Effects:
  - pause → resume keeps the original wave count and per-lane wave numbers;
  - crash recovery (fresh engine) resumes within the original wave layout;
  - `lane.wave` stays consistent, so dsh-dingo's wave-segmented background counts stay correct.
- `runLane` now carries the original `wave` number onto resumed lanes (it was dropped when the
  lane object was rebuilt).
- Dashboard adapter prefers the persisted `state.wavePlan` (falls back to recompute for old batch
  files).

### Changed

- README: documented the fixed-wave-plan behavior (bilingual).

### Tests

- New regression tests: pause→resume keeps 3 waves; abort→immediate-start runs cleanly; crash
  recovery from a disk state resumes with the original wave plan. Full suite: 47/47.

## [0.2.30] - 2026-08-16

### Changed

- **All TaskSwarm agent sessions are now tagged `taskswarmWorker: true` in their session meta** —
  worker (in-process + headless), reviewer, and merger sessions all carry the explicit marker.
  This lets plugins like dsh-dingo identify TaskSwarm-internal agents precisely (it already
  filtered on `origin === 'subagent'` and the `.taskswarm/worktrees/` cwd; the explicit flag makes
  the filter robust even if those signals change). No behavior change for TaskSwarm itself.
- Regression guard: the spawner audit test now also requires `taskswarmWorker: true` in all four
  agent-creation files.

## [0.2.29] - 2026-08-16

### Added

- **`/tswarm-switch-model <taskId> <model>`** (alias `/orch-switch-model`) — switch one lane to a
  different model with a single command. Internally it performs the three-step SOP:
  1. record the per-lane model override (takes effect on the lane's next worker spawn);
  2. stop the current worker (kill + preserve worktree/checkpoints);
  3. auto-rerun the lane — `createLaneWorktree` attaches the old branch and STATUS.md carries the
     step memory, so the new-model worker continues **from the next step**, losing nothing.
  Sibling lanes are unaffected; the batch keeps running. Model priority per lane:
  `/tswarm-switch-model` override > plugin `workerModel` > parent-session default.
- Tests: switch records the override, stops the lane, and the rerun spawns with the new model
  (verified by a model-recording host); switching with no running batch is refused cleanly.

## [0.2.28] - 2026-08-16

### Changed

- **Notifications are now complete, localized messages — and the supervisor never re-translates
  them** (token-efficiency redesign). Instead of terse English tags that the model must translate
  and restate (which costs tokens on the model side), every notification is written in full,
  readable language (Chinese or English per locale) with all the context (batch, wave, per-lane
  status/steps/executed count, ETA, disk usage). The supervisor system prompt now explicitly says:
  *notifications are already complete and readable — do NOT translate or repeat them; judge only
  whether there is an anomaly or an action needed; if none, stay quiet or acknowledge in one short
  line.* Principle: don't shrink the message, eliminate the re-explanation — the message is
  written once by the engine, and the model spends no tokens restating it.
- README: new "Notifications & Token Efficiency" section documenting this design (bilingual).

## [0.2.27] - 2026-08-16

### Fixed

- **Reviewer sessions now get full access + approvals off** — the reviewer spawner's `setup`
  missed `grantWorkerFullAccess()`, so reviewer agents ran under the default `workspace-write` +
  `ask` policy and triggered approval prompts (observed on jm batch: a reviewer asked for
  workspace-write permission). It now injects `sandbox/mode: danger-full-access` +
  `approval/policy: never`, matching workers and mergers.
- **Headless workers (runner) also grant full access** — the headless worker path only mounted
  tools without the permission injection; it now matches the in-process worker.
- **Regression guard** — a new test audits all four agent spawners
  (`in-process-host` / `reviewer` / `merger` / `runner`) to require `grantWorkerFullAccess` in
  their `setup`, so this class of bug cannot silently return.

## [0.2.26] - 2026-08-16

### Changed

- **Notifications are English-terse regardless of locale (saves tokens)** — the Chinese locale
  dictionary now produces the same terse `[TS ...]` English messages as English (short batch id,
  `L<n>`, `steps X/Y · N`, `W1/2`). The supervisor system prompt instructs the agent to relay
  these notifications to the operator **in the current conversation language** — e.g. the user
  writes Chinese, the agent gets a terse English `[TS wave 1/2 done] 2 merged · 1 failed` line
  and explains it in Chinese. Locale still controls the supervisor prompt language.

## [0.2.25] - 2026-08-16

### Changed

- **Supervisor messages are now terse English with type tags** — every notification starts with a
  bracket label so you always know what kind it is and (for periodic reports) the interval:
  - `[TS report · every 5m]` — periodic report (label includes the interval)
  - `[TS wave 1/2 done] 2 merged · 1 failed` — wave completion
  - `[TS lane failed] L2 JM-403` — lane failure
  - `[TS batch complete] 3/4 merged · 1 failed` — batch completion
  - `[TS paused]`, `[TS stalled]`, `[TS 🐢 progress]`, `[TS aborted]` — the rest
- **Status body simplified** — `compactBatchStatus` now renders:
  ```
  b-msvinu6n — W1/2 · 0/4 done
    L1 [run] JM-402 · steps 5/8 · 81
    L2 [run] JM-403 · steps 1/11 · 117
  ```
  (short batch id, `L<n>` instead of `lane <n>`, `run` instead of `running`, trailing `· N` =
  steps executed; the English locale templates were shortened accordingly).

## [0.2.24] - 2026-08-16

### Added

- **`/tswarm-stop-lane <taskId>`** (alias `/orch-stop-lane`) — actively stop one lane immediately:
  kill its worker (no waiting for the watchdog), mark it failed, preserve the worktree/checkpoints
  for salvage. Sibling lanes in the same wave are unaffected; if `pauseOnLaneFailure` is on
  (default), the batch auto-pauses after the wave for disposition.
- **`pauseOnLaneFailure` config (default `true`)** — a failed lane now auto-pauses the batch after
  its wave instead of rolling straight into the next one, so the supervisor can dispose of it
  (rerun / drop / continue). On `resume`, failed lanes are **skipped** (failed work is dropped);
  rerun a failed task separately with `/tswarm <taskId>`. This is distinct from crash-recovery
  resumes, where failed lanes are rerun to continue their checkpoints (KI-007).

### Fixed

- Stop-lane race: a lane stopped via `/tswarm-stop-lane` stayed `failed` even if its worker later
  returned normally (previously the normal completion path could resurrect it to `merged`).
- `pauseOnLaneFailure` resume no longer loops: resuming a failure-paused batch drops the failed
  lanes instead of re-running them into another failure → another pause.

## [0.2.23] - 2026-08-16

### Added

- **Per-lane step counter on the Web dashboard** — each running lane's card now shows a
  `⚙ N steps` badge: the worker's cumulative executed steps since task start (session event
  `step` field — every tool call / reply increments it), so a complex task grinding away in the
  background is visibly "still running" from the rising number. Data comes from the newly
  implemented `runtimeLaneSnapshots` (worker.stepCount), read from the worker's session log
  (`~/.dsh/sessions/--<worktree>--/session.jsonl[.zstd]`).
- **Step counts in worker→supervisor messages** — `notify_supervisor` / `escalate_to_supervisor`
  now append the worker's current `steps X/Y` (checkboxes) and `N steps executed` (session steps)
  to the message, and the supervisor's periodic/status reports show both on each lane line
  (e.g. `lane 1 [running] JM-401 steps 0/11 · 179 steps executed`).

### Fixed

- **Total step count falls back to PROMPT.md** (`laneProgress`): if STATUS.md lacks a
  `### Step N:` section (created by hand / another AI writing only the Status header +
  Execution Log), the total now comes from the task packet's checkboxes — so even before the
  first step completes you see `0/N` and know how many steps the task has.
- **Every STATUS.md write path now guarantees the Step structure first** — new
  `ensureTaskDirStructure()` is called at the entry of all persisted-state writers
  (`setTaskStatus`, `markTaskDone`, `markTaskRunning`, `advanceStep`, `appendExecutionLog`,
  `updateStatusField`, `appendStepStatus`): task creation / updates / success / failure /
  status transitions can never land on a STATUS.md that lacks the Step sections the engine
  relies on. `ensureStatusStructure` now **injects** the Step block (preserving existing
  Execution Log rows) instead of rewriting the file.
- Plugin test suite fixed for the new `ctx.provide('taskswarm', …)` service (b83e4bf): the mock
  context now provides a no-op `provide`.

## [0.2.22] - 2026-08-15

### Added

- **Per-task step progress in status reports (KI-008)** — `parseStatusFile` now returns
  `checked`/`total` checkbox counts, and `/tswarm-status` / supervisor status lines show
  `checked/total` per lane (e.g. `lane 1 [running] T-8 2/7`), so you can see how many steps a task
  has and which one it is on at a glance.

### Changed

- **README gains the "TaskSwarm vs DSH native subagents" comparison** — the comparison table
  (task shape / parallelism / isolation / quality gate / resumability / observability) moved from
  the community post into the README, where it answers the most common first question.
- **Community posts removed** (`docs/community-post*.md`) — their only unique content (the
  comparison table) now lives in the README; the rest duplicated it.
- **Known-issues tidied** — KI-005/KI-006 (both long fixed) moved from OPEN to RESOLVED in the
  English doc (the Chinese doc already had them there); KI-008 moved to RESOLVED with its fix
  note. OPEN sections are now empty in both languages.

## [0.2.21] - 2026-08-15

Removed the bug-handoff document (`docs/bug-交接清单.zh-CN.md`) — all four tracked bugs (B1 abort
bookkeeping, B2 progress reporting, B3 merge-conflict handling, B4 Current Step display) are now
fixed (v0.2.18–v0.2.20) and their root-cause analyses live in known-issues.

## [0.2.20] - 2026-08-15

### Fixed

- **Lane no longer shows "Not Started" while actually running (B4)** — `runLane` now calls
  `markTaskRunning()` at lane start: besides `**Status:** 🟢`, it sets `**Current Step:**` to the
  first step's title and flips that step's status to In Progress, so STATUS.md is internally
  consistent from the moment the lane starts (previously "🟢 In Progress" sat next to
  "**Current Step:** Not Started" until the worker's first `advance`). Dashboard fallback: a
  running/review/conflict lane whose current step is still the initial "Not Started" renders as
  "In Progress" instead of surfacing the raw initial value.

### Changed

- **Stall / progress-stall threshold raised 4 → 7 minutes** (`supervisorStalledMs` default
  240000 → 420000): workers often spend several minutes on research before their first `advance`;
  4 minutes produced noisy 🐢 progress-stall reminders; 7 minutes is more tolerant while still
  catching real batching.
- **README slimmed down** — removed the "Project Status" section (version number + test count +
  capability list that duplicated Features and inevitably went stale); the two capabilities not
  already in Features (orch-based lane baselines, task-packet validation, LLM merge agent) were
  merged into Features. Version history lives in CHANGELOG only. The stale "local link install"
  TODO was dropped and the remaining TODO (per-task step progress in supervisor reports) moved to
  known-issues as KI-008 (bilingual).

## [0.2.19] - 2026-08-15

### Changed

- **Worker mission now enforces incremental `advance` (B2)** — the mission text gained hard rules:
  `advance` immediately after EACH completed checkbox, never batch checkboxes to the end, `done`
  only when ALL completion criteria are met, and never hand-edit STATUS.md. Fixes progress display
  lagging at low percentages then jumping 0→100%, and crash recovery depending on the last commit.
- **Progress-stall supervision (B2)** — the periodic supervisor now tracks each running lane's
  STATUS.md mtime; a lane whose session is active but whose STATUS has not advanced for the stall
  threshold gets a one-time `progressStalled` reminder (bilingual), flagging workers that batch
  their checkpoints.

### Added

- **`conflict` lane phase + auto-pause on unresolved merge conflicts (B3#3)** — when the merger
  agent cannot resolve a merge conflict (or no merger is available), the lane lands in a new
  `conflict` phase (scene fully preserved: lane worktree, branch, orch conflict state) and the
  batch **auto-pauses at the wave boundary** instead of silently continuing. The supervisor is
  woken via the wave-complete event (with `conflict` count) and can fix the merge manually then
  `resume`, or decide to rerun the lane — no more racing between manual intervention and a
  background merger/retry (the double-notification root cause).
- Merger mission now explicitly forbids re-running `git merge <laneBranch>` and forbids aborting
  the in-progress merge (B3#2) — the agent works only on the preserved conflict scene.

### Fixed

- `estimateEta`, supervisor stall detection, active-lane listing, and the dashboard adapter now
  account for the `conflict` phase (it counts as remaining, not done).

## [0.2.18] - 2026-08-15

Standard MIT LICENSE template (GitHub now detects `MIT` instead of `NOASSERTION/Other`); added
`homepage` / `repository` / `bugs` to package.json for the npm page.

## [0.2.17] - 2026-08-15

Removed the resolved bug-handoff document; changelog references updated.

## [0.2.16] - 2026-08-15

### Fixed

- **`abort` then immediate `start` no longer corrupts batch bookkeeping** (seen on
  dsh-localvoice): an abort mid-wave left the old
  batch's in-flight lanes running; they re-created deleted worktrees, spawned new workers, and
  wrote their completion into the **already-aborted old batch file** — while the new batch's file
  stayed at zero progress. Four fixes:
  - `abort()` now resolves a per-batch abort waiter; `runLaneWorker` races the in-flight worker
    await against it, so abort genuinely stops in-flight work instead of only flagging it.
  - `runLane` checks `aborted` before creating a worktree and before spawning a worker.
  - `updateLane` refuses to write lanes into terminal batches (`aborted`/`complete`).
  - `execute()`'s wave-boundary write respects the on-disk terminal phase instead of overwriting
    it with the in-memory stale `running` (which was resurrecting aborted files).
  - `run()` rejects starting a new batch while another (non-aborted) batch is still active.
- Regression test: abort mid-wave → immediate start → old file never re-written, new batch
  progresses to complete.

## [0.2.15] - 2026-08-15

### Added

- **LLM merger agent (P1)** — when a lane's `git merge` into `taskswarm/orch` fails (conflict), a
  merger agent (spawned like the reviewer, `src/worker/merger.ts`) resolves the conflict
  semantically inside the orch worktree: reads both sides' intent, edits files, completes the
  merge commit. Adapted from TaskPlane's LLM-powered merge agent. Config: `mergerModel`.
- **Merge verification (P2)** — optional commands run after a successful merge
  (`mergeVerifyCommands`, e.g. `["npm test"]`), passed into the merger agent's mission.
- **Merge watchdog (P3)** — a stuck merger agent times out (`mergerTimeoutMinutes`, default 10)
  and preserves the scene, without blocking later merges in the serialized queue.

### Fixed

- **Merge failure no longer destroys the scene (P0)** — `mergeLane` previously ran
  `git branch -D` on the lane branch when the merge failed, contradicting its own comment and
  deleting the worker's work; it now preserves the lane worktree, branch, and orch conflict state
  for inspection / merger-agent resolution / manual intervention.
- **Concurrent merges into the orch worktree are serialized** — parallel lanes finishing in the
  same wave previously ran `git merge` on the same orch worktree concurrently, which git rejects
  with a lock error (empty stderr, lane silently failed); merges now go through a promise-chain
  mutex.

## [0.2.14] - 2026-08-15

### Fixed

- Release guide: package name corrected to `dsh-taskswarm` in all three places (`dsh plugin add`,
  `npm view`, npm Granular Access Token scope) — the `buju`→`dsh-taskswarm` rename had left the
  docs pointing at a package that does not exist.

## [0.2.13] - 2026-08-15

### Fixed

- **Lane worktrees now baseline on `taskswarm/orch` HEAD, not the working branch** — root cause of
  the dsh-localvoice T-5 rpc.ts incident: `createLaneWorktree` ran
  `git worktree add -b <branch> <dir>` with no commit-ish, so every lane started from the working
  branch (master) and never saw previously merged tasks' output. Lanes relied on each worker
  *self-merging* `taskswarm/orch`; a worker that missed the dependency produced incomplete or
  duplicated implementations that conflicted at merge-back.
  - New lanes: `worktree add -b <branch> <dir> taskswarm/orch` — inherit all merged output from
    the start.
  - Retried lanes: attach the old branch, then auto `git merge taskswarm/orch` (conflict → abort,
    worker resolves itself).
  - Worker mission now states the lane is based on `taskswarm/orch` and to reuse merged output.
  - runbook documents the lane baseline mechanics; new tests cover both new-lane baseline and
    retry-preserves-checkpoints.

### Changed

- Release guide: mandatory **publish-to-npm-before-push-to-GitHub** ordering — GitHub-channel
  installs depend on the version already being on npm, and each version can only be published
  once, so the order cannot be fixed later.

## [0.2.12] - 2026-08-15

### Added

- **Malformed task packets are now surfaced instead of silently skipped** — a `PROMPT.md` that
  fails machine parsing (e.g. a `T1`-style ID without the required hyphen, or the legacy
  human-readable format) was previously dropped by `scanTasks` without a trace; it is now reported
  with actionable causes.
- **`/tswarm-check` command** — validates task packet quality (missing steps / acceptance criteria /
  file scope) directly from the session.
- **`npm run check:tasks`** — standalone packet validator script (`scripts/check-tasks.mjs`) for
  CI / pre-flight use without starting DSH.
- `scanTaskFailures` / `explainParseFailure` — programmatic API for parse-failure diagnostics.

### Changed

- `plan` / `start` now append parse-failure warnings to their output, so a bad packet can no longer
  silently vanish from a wave plan.
- `docs/runbook.md` §4.2 rewritten as a strict machine-format spec for task packets, with a
  pitfall table and a self-check list.

## [0.2.11] - 2026-08-14

Version bump only (package metadata). Released to npm as the baseline carrying the 0.2.9/0.2.10
documentation and packaging fixes.

## [0.2.10] - 2026-08-14

### Added

- README: upgrade instructions — pinning an explicit version for upgrades
  (`dsh plugin add dsh-taskswarm@<version>`), since a lockfile-satisfied install reports
  "Already up to date".
- Release guide: documented the npm 2FA **Granular Access Token with bypass** requirement (classic
  tokens are rejected with `E403` when 2FA is enabled).

## [0.2.9] - 2026-08-14

### Changed

- **`prepare` script** — `npm run build` runs on install, so GitHub-direct installs
  (`dsh plugin add https://github.com/february2015/dsh-taskswarm.git`) build without manual steps.
- **Patch id unified with plugin name** — the bundle patch id is now `tswarm-orchestrator`,
  consistent with the package name.
- README: documented Hot Reload / HMR behavior (config hot-reload caveat, source HMR requires
  rebuild + dsh web restart, batch recovery after restart).
- Cleanup of legacy `buju` naming (LICENSE attribution, `.gitignore` state dir).

## [0.2.8] - 2026-08-14

### Added

- Dashboard auto-opens the browser on start (`--no-open` to disable); an already-running instance
  is reused without spawning a second one.

## [0.2.7] - 2026-08-14

### Fixed

- Dashboard progress-bar segment widths now distribute by task count — a pending wave with no
  `STATUS.md` no longer collapses to zero width (restores TaskPlane-style multi-segment display).
- Dashboard logo `viewBox` widened to fit the "TaskSwarm" wordmark (previously clipped at 300px
  width, showing only "skswa"), including the theme-switch logo variants.

## [0.2.x early / 0.2.6 and below]

The 0.2.x line was cut from the 0.1.x codebase in a rapid release sprint (2026-08-14). Notable
changes before 0.2.7 include:

- **Rename `buju` → `dsh-taskswarm` (TaskSwarm 蜂群)** — repository, package name, and command
  prefix unified (`/orch-*` kept as compatible aliases).
- **Conversational supervisor** — shares the operator session, reports wave completion / lane
  failures / batch completion, takes verbal commands, bilingual (中文 / English) with language
  auto-detection, persisted to `.taskswarm/config.json`.
- **Web Dashboard** — zero-dependency `node:http` + SSE, multi-instance with automatic port
  negotiation, auto-start on batch with one-instance-per-workspace guarantee.
- **Crash recovery** — durable disk state + checkpoints + retained lane branches; `resume`
  recovers pending batches after an engine restart (skips only merged lanes, failed lanes rerun).
- **Lane watchdog** — `laneTimeoutMinutes` default raised 90 → 180 (parallel big tasks were being
  cut off at 90 minutes); watchdog checks disk before timeout so manually-finished lanes are not
  mis-flagged `failed`.
- **Supervisor cleanup helper** — reminds to clean worker session history after a successful batch,
  reports disk usage in notifications.

## [0.1.1] - 2026-08-14

First tagged release. Bilingual docs (release guide, runbook, known-issues), README rewrite,
`tasks` runtime data removed from the repo, npm packaging fixes.

## [0.1.0] - 2026-08-14

Initial port of [TaskPlane](https://github.com/HenryLach/taskplane) to DeepSeek Harness:

- **Waves / lanes parallel orchestration** — tasks layered by dependency DAG into waves; tasks in a
  wave run concurrently.
- **Git worktree isolation** — each lane works in its own worktree, results merged into the
  `taskswarm/orch` integration branch.
- **Task packets** — `PROMPT.md` (mission / steps / constraints) + `STATUS.md` (progress) per task;
  checkpoint commits at step boundaries.
- **Cross-model review** — independent reviewer scores each task per Review Level; PASS merges,
  REVISE sends it back.
- **File mailbox** — worker ↔ supervisor async messaging (notify / escalate / request).
- Verified inside a real DSH process: real LLM workers in parallel (deepseek-v4-flash), checkpoint
  commits, merge into `taskswarm/orch`.

[0.2.32]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.31...v0.2.32
[0.2.31]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.30...v0.2.31
[0.2.30]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.29...v0.2.30
[0.2.29]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.28...v0.2.29
[0.2.28]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.27...v0.2.28
[0.2.27]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.26...v0.2.27
[0.2.26]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.25...v0.2.26
[0.2.25]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.24...v0.2.25
[0.2.24]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.23...v0.2.24
[0.2.23]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.22...v0.2.23
[0.2.22]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.21...v0.2.22
[0.2.21]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.20...v0.2.21
[0.2.20]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.19...v0.2.20
[0.2.19]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.18...v0.2.19
[0.2.18]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.14
[0.2.13]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.13
[0.2.12]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.11
[0.2.10]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.10
