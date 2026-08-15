# Changelog

All notable changes to **dsh-taskswarm** (TaskSwarm 蜂群) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project uses
[Semantic Versioning](https://semver.org/). 中文版见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## [Unreleased]

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

[Unreleased]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.11...HEAD
[0.2.11]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.11
[0.2.10]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.10
