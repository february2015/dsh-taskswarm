# Buju（布局）

**Multi-agent task orchestration for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai).**

Buju arranges a batch of tasks into dependency-ordered **waves**, runs multiple AI workers in **parallel lanes** isolated by git worktrees, then automatically reviews and merges their output.

> 布局 (bùjú) is a Go term: before placing a stone, lay out the whole board, then let every stone advance in its own position — exactly what this project does: **plan the waves first, then execute in parallel**.

- **License:** MIT
- **Upstream:** [TaskPlane](https://github.com/HenryLach/taskplane)（Pi ecosystem multi-agent orchestration）— this project is a native port
- **中文文档:** [README.zh-CN.md](README.zh-CN.md)

## Features

- **Waves / Lanes parallel orchestration** — tasks are topologically layered by their dependency DAG into waves; tasks within a wave run concurrently
- **Git worktree isolation** — every task (lane) works in its own worktree; results are merged into the `buju/orch` integration branch
- **Task packets** — each task is a `PROMPT.md` (mission / steps / constraints) + `STATUS.md` (progress), giving workers durable memory across context resets
- **Checkpoint discipline** — automatic git commits at step boundaries; a crashed worker never loses committed work
- **Cross-model review** — an independent reviewer scores each task per its `Review Level`; PASS merges, REVISE sends it back for revision
- **File mailbox** — workers and supervisor communicate asynchronously (notify / escalate / request) without shared context
- **Conversational supervisor** — shares your session: reports wave completion, lane failures, batch completion; takes verbal commands (start / pause / abort / integrate / open dashboard); notifications and the prompt are **bilingual (中文 / English)** — say "use English" to switch, auto-detected from your session language, persisted to `.buju/config.json` across restarts
- **Web Dashboard** — local realtime dashboard, zero-dependency node:http + SSE, multiple instances with automatic port negotiation
- **Crash-recoverable** — durable disk state + checkpoints + retained lane branches; after a kill/restart you can salvage work, clean up residue, and re-run

## Quick Start

### 1. Install (pick one)

```bash
# npm registry
dsh plugin --profile web add dsh-buju

# GitHub
dsh plugin --profile web add https://github.com/february2015/dsh-buju.git

# Local directory (development / offline)
git clone https://github.com/february2015/dsh-buju.git && cd dsh-buju
npm install && npm run build
dsh plugin --profile web add $(pwd)
```

**Restart dsh web** after installing — the plugin takes effect on boot.

### 2. Scaffold example tasks

```
/buju-init        # creates two example task packets (EXAMPLE-001 / EXAMPLE-002)
```

### 3. Preview the wave plan (no execution)

```
/buju-plan all    # shows tasks grouped into waves by dependency
```

### 4. Start a batch

```
/buju all         # run all tasks in parallel; or target one: /buju EXAMPLE-002
/buju-status      # watch progress anytime
```

### 5. Open the Dashboard

```bash
# from a DSH session (supervisor command)
/buju-dashboard

# or standalone CLI — after installing the plugin, the bin is on PATH:
npx buju-dashboard --root <repo>

# or without installing anything, fetched on the fly (after npm publish):
npx --package dsh-buju buju-dashboard --root <repo> [--port 8100] [--no-open]
```

## How It Works

Four roles are orchestrated:

| Role           | Responsibility                                                                              |
| -------------- | ------------------------------------------------------------------------------------------- |
| **Supervisor** | Plans waves, schedules lanes, handles events, talks to you (the session that ran `/buju`)   |
| **Worker**     | One DSH agent per task, advancing its task packet step by step in an isolated lane worktree |
| **Reviewer**   | Independent agent reviewing worker output, emitting PASS / REVISE                           |
| **Merger**     | Merges finished lane output into the `buju/orch` integration branch                         |

**Git model:**

```
buju/orch            ← integration branch: all lane output lands here (persistent — don't delete)
buju/<taskId>        ← per-lane working branch (holds step checkpoints; removed after merge)
```

**Durable state** (`<repo>/.buju/`):

```
.buju/batches/<batchId>.json   # single source of truth for a batch (phase + lanes)
.buju/mailbox/<batchId>/       # agent-to-agent messages
.buju/worktrees/_orch/         # integration worktree
.buju/worktrees/<taskId>/      # per-lane isolated worktrees
```

## Command Reference

| Command                        | Action                                                |
| ------------------------------ | ----------------------------------------------------- |
| `/buju [scope]`                | Start a batch (scope: `all` / task id / path)         |
| `/buju-plan [scope]`           | Preview wave plan and dependency graph (no execution) |
| `/buju-status`                 | Show current batch / lane progress                    |
| `/buju-pause` / `/buju-resume` | Pause after the current wave / resume                 |
| `/buju-abort`                  | Abort after the current wave (kills running lanes)    |
| `/buju-deps [scope]`           | Show the dependency graph                             |
| `/buju-sessions`               | List active lanes and their worktrees                 |
| `/buju-integrate`              | Merge `buju/orch` into the current working branch     |
| `/buju-dashboard`              | Start the Web Dashboard                               |
| `/buju-init [ID]`              | Scaffold example task packets                         |

> Compatible aliases: `/orch`, `/orch-status` and other `/orch-*` commands are equivalent.

## Project Status

**In development (v0.1)** — the core engine and command layer are implemented and tested (`npm install && npm run build && npm test`, 9/9), and verified inside a real DSH process:

- ✅ core unit tests + engine integration tests (parallel waves + worktree isolation + orch merge)
- ✅ real LLM workers running in parallel (deepseek-v4-flash), checkpoint commits + merge into `buju/orch`
- ✅ conversational supervisor: event wake-ups + periodic stall detection + verbal command control
- ✅ Web Dashboard verified live (multiple instances, automatic port negotiation)

## Docs

- **[Runbook (ops)](docs/runbook.md)** — standard operating procedures for cleanup, error recovery, and work salvage (required reading for supervisors / AI agents)
- **[Known Issues](docs/known-issues.md)** — root-cause analyses and fixes for resolved issues

## License & Credits

- **MIT License** — free to use, modify, and redistribute
- Upstream **TaskPlane** ([github.com/HenryLach/taskplane](https://github.com/HenryLach/taskplane)): original design of wave orchestration, task packets, mailbox, and supervisor — this project is a native port
- Runtime: [DeepSeek Harness (DSH)](https://github.com/deepseek-ai)
