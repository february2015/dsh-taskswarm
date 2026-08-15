# Changelog

All notable changes to **dsh-taskswarm** (TaskSwarm 蜂群) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project uses
[Semantic Versioning](https://semver.org/). 中文版见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

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

[0.2.16]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.14
[0.2.13]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.13
[0.2.12]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.11
[0.2.10]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.10
