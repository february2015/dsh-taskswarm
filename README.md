# TaskSwarm（蜂群）

**Multi-agent task orchestration for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai).**

TaskSwarm arranges a batch of tasks into dependency-ordered **waves**, runs multiple AI workers in **parallel lanes** isolated by git worktrees, then automatically reviews and merges their output.

> 蜂群 (fēngqún) is a swarm of bees: the queen directs, the workers each buzz on their own task in parallel — exactly what this project does: **the supervisor plans the waves, then every worker advances in its own lane**.

- **License:** MIT
- **Upstream:** [TaskPlane](https://github.com/HenryLach/taskplane)（Pi ecosystem multi-agent orchestration）— this project is a native port
- **中文文档:** [README.zh-CN.md](README.zh-CN.md)

## Features

- **Waves / Lanes parallel orchestration** — tasks are topologically layered by their dependency DAG into waves; tasks within a wave run concurrently
- **Git worktree isolation** — every task (lane) works in its own worktree; results are merged into the `taskswarm/orch` integration branch
- **Task packets** — each task is a `PROMPT.md` (mission / steps / constraints) + `STATUS.md` (progress), giving workers durable memory across context resets
- **Checkpoint discipline** — automatic git commits at step boundaries; a crashed worker never loses committed work
- **Cross-model review** — an independent reviewer scores each task per its `Review Level`; PASS merges, REVISE sends it back for revision
- **File mailbox** — workers and supervisor communicate asynchronously (notify / escalate / request) without shared context
- **Conversational supervisor** — shares your session: reports wave completion, lane failures, batch completion; takes verbal commands (start / pause / abort / integrate / open dashboard); notifications and the prompt are **bilingual (中文 / English)** — say "use English" to switch, auto-detected from your session language, persisted to `.taskswarm/config.json` across restarts
- **Web Dashboard** — local realtime dashboard, zero-dependency node:http + SSE, multiple instances with automatic port negotiation. **Auto-starts when a batch starts and prints the link in chat** — one dashboard per workspace, ever (an already-running instance is reused, never duplicated)
- **Crash-recoverable** — durable disk state + checkpoints + retained lane branches; after a kill/restart you can salvage work, clean up residue, and re-run

## Quick Start

### 1. Install (pick one)

```bash
# npm registry
dsh plugin --profile web add dsh-taskswarm

# GitHub
dsh plugin --profile web add https://github.com/february2015/dsh-taskswarm.git

# Local directory (development / offline)
git clone https://github.com/february2015/dsh-taskswarm.git && cd dsh-taskswarm
npm install && npm run build
dsh plugin --profile web add $(pwd)
```

**Restart dsh web** after installing — the plugin takes effect on boot.

### 2. Scaffold example tasks

```
/tswarm-init        # creates two example task packets (EXAMPLE-001 / EXAMPLE-002)
```

### 3. Preview the wave plan (no execution)

```
/tswarm-plan all    # shows tasks grouped into waves by dependency
```

### 4. Start a batch

```
/tswarm all         # run all tasks in parallel; or target one: /tswarm EXAMPLE-002
/tswarm-status      # watch progress anytime
```

### 5. Open the Dashboard

Starting a batch (`/tswarm`) **auto-starts the dashboard and prints its link** in the
session, so you can watch progress while waves run. Manual control is still available:

```bash
# from a DSH session (supervisor command)
/tswarm-dashboard

# or standalone CLI — after installing the plugin, the bin is on PATH:
npx taskswarm-dashboard --root <repo>

# or without installing anything, fetched on the fly (after npm publish):
npx --package dsh-taskswarm taskswarm-dashboard --root <repo> [--port 8100] [--no-open]
```

> One dashboard per workspace: if one is already running for the same repo
> (started manually or left over from an earlier session), it is detected and
> reused — a second instance is never spawned.

## How It Works

Four roles are orchestrated:

| Role           | Responsibility                                                                              |
| -------------- | ------------------------------------------------------------------------------------------- |
| **Supervisor** | Plans waves, schedules lanes, handles events, talks to you (the session that ran `/tswarm`) |
| **Worker**     | One DSH agent per task, advancing its task packet step by step in an isolated lane worktree |
| **Reviewer**   | Independent agent reviewing worker output, emitting PASS / REVISE                           |
| **Merger**     | Merges finished lane output into the `taskswarm/orch` integration branch                    |

**Git model:**

```
taskswarm/orch            ← integration branch: all lane output lands here (persistent — don't delete)
taskswarm/<taskId>        ← per-lane working branch (holds step checkpoints; removed after merge)
```

**Durable state** (`<repo>/.taskswarm/`):

```
.taskswarm/batches/<batchId>.json   # single source of truth for a batch (phase + lanes)
.taskswarm/mailbox/<batchId>/       # agent-to-agent messages
.taskswarm/worktrees/_orch/         # integration worktree
.taskswarm/worktrees/<taskId>/      # per-lane isolated worktrees
```

## Command Reference

| Command                            | Action                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| `/tswarm [scope]`                  | Start a batch (scope: `all` / task id / path)          |
| `/tswarm-plan [scope]`             | Preview wave plan and dependency graph (no execution)  |
| `/tswarm-status`                   | Show current batch / lane progress                     |
| `/tswarm-pause` / `/tswarm-resume` | Pause after the current wave / resume                  |
| `/tswarm-abort`                    | Abort after the current wave (kills running lanes)     |
| `/tswarm-deps [scope]`             | Show the dependency graph                              |
| `/tswarm-sessions`                 | List active lanes and their worktrees                  |
| `/tswarm-integrate`                | Merge `taskswarm/orch` into the current working branch |
| `/tswarm-dashboard`                | Start the Web Dashboard                                |
| `/tswarm-init [ID]`                | Scaffold example task packets                          |

> Compatible aliases: `/orch`, `/orch-status` and other `/orch-*` commands are equivalent.

## Project Status

**In development (v0.1)** — the core engine and command layer are implemented and tested (`npm install && npm run build && npm test`, 9/9), and verified inside a real DSH process:

- ✅ core unit tests + engine integration tests (parallel waves + worktree isolation + orch merge)
- ✅ real LLM workers running in parallel (deepseek-v4-flash), checkpoint commits + merge into `taskswarm/orch`
- ✅ conversational supervisor: event wake-ups + periodic stall detection + verbal command control
- ✅ Web Dashboard verified live (multiple instances, automatic port negotiation)

## Hot Reload / HMR Behavior

- **Config hot-reload**: TaskSwarm is a standard DSH bundle — config overrides layered in the profile's `cordis.patch.yml` are hot-reloaded by DSH without a restart. **Caveat**: reloading the orchestrator plugin (e.g. editing its config row) aborts all running batches via its unload cleanup — do not touch orchestrator config while a batch is running.
- **Source HMR**: DSH does not enable plugin source HMR on the web profile (`cordis-plugin-hmr` is disabled by default); source changes require `npm run build` followed by a **dsh web restart**.
- **Batch recovery**: even after a restart, `.taskswarm/` disk state + checkpoints + lane branches persist; check `/orch-status` afterwards and resume/rerun failed lanes through the supervisor without losing completed work.

## Docs

- **[Runbook (ops)](docs/runbook.md)** — standard operating procedures for cleanup, error recovery, and work salvage (required reading for supervisors / AI agents)
- **[Release Guide](docs/release.md)** — publishing to npm, version bumps, and the 2FA/bypass-token gotcha (for maintainers)
- **[Known Issues](docs/known-issues.md)** — root-cause analyses and fixes for resolved issues

## License & Credits

- **MIT License** — free to use, modify, and redistribute
- Upstream **TaskPlane** ([github.com/HenryLach/taskplane](https://github.com/HenryLach/taskplane)): original design of wave orchestration, task packets, mailbox, and supervisor — this project is a native port
- Runtime: [DeepSeek Harness (DSH)](https://github.com/deepseek-ai)
