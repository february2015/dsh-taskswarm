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
- **Orch-based lane baselines** — every lane worktree is created from the `taskswarm/orch` integration HEAD, so it inherits all previously merged output instead of re-inventing shared code
- **Task-packet validation** — `/tswarm-check` + `npm run check:tasks` surface malformed packets (bad IDs, missing steps/criteria) with actionable causes instead of silently skipping them
- **LLM merge agent** — when a lane merge into `taskswarm/orch` conflicts, an independent merger agent resolves the conflict semantically inside the orch worktree; unresolvable conflicts land the lane in a `conflict` state and pause the batch for supervisor intervention

## Why TaskSwarm, when DSH already has subagents?

DSH's native `subagent` / `workflow` / `goal` are *conversational, one-shot* scheduling — great for
ad-hoc delegation. TaskSwarm is a **project-level orchestration layer** on top of them:

|               | DSH native subagents              | TaskSwarm                                                                                       |
| ------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Task shape    | one sentence in chat              | **task packets** (PROMPT.md / STATUS.md) — versioned, batchable, reusable                       |
| Parallelism   | manual                            | **wave planning**: dependency-topological waves, parallel lanes per wave                        |
| Isolation     | shared workspace (writes collide) | **git worktree isolation**: per-lane branch + checkpoints, merged into `taskswarm/orch`         |
| Quality gate  | none                              | **independent Reviewer** (PASS / REVISE)                                                        |
| Resumability  | gone when the process ends        | **durable batch state** (`.taskswarm/batches/*.json`): restart / resume / skip finished lanes   |
| Observability | watch the chat                    | **supervisor event reports + Web Dashboard**, auto-started with the batch, link printed in chat |

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

> **Upgrading an existing install**: `dsh plugin --profile web add dsh-taskswarm`
> reports "Already up to date" and stays on the old version when the lockfile
> version already satisfies the declared range. Pin the new version explicitly:
> `dsh plugin --profile web add dsh-taskswarm@<new-version>` (or run
> `pnpm update --latest` in the profile directory), then restart dsh web.

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
| `/tswarm-pause` / `/tswarm-resume` | Pause after the current wave / resume. A failed lane also auto-pauses after the wave (`pauseOnLaneFailure`, on by default) — resume then skips the failed lane; rerun it with `/tswarm <taskId>` |
| `/tswarm-stop-lane <taskId>`       | Stop one lane immediately (kill worker, mark failed, preserve worktree/checkpoints); sibling lanes continue, the batch pauses after the wave |
| `/tswarm-switch-model <taskId> <model>` | Switch one lane to a different model: stop it, record the override, auto-rerun from the next step (checkpoints preserved). Override > `workerModel` > parent-session default |
| `/tswarm-abort`                    | Abort after the current wave (kills running lanes)     |
| `/tswarm-deps [scope]`             | Show the dependency graph                              |
| `/tswarm-sessions`                 | List active lanes and their worktrees                  |
| `/tswarm-integrate`                | Merge `taskswarm/orch` into the current working branch |
| `/tswarm-dashboard`                | Start the Web Dashboard                                |
| `/tswarm-init [ID]`                | Scaffold example task packets                          |

> Compatible aliases: `/orch`, `/orch-status` and other `/orch-*` commands are equivalent.

## Hot Reload / HMR Behavior

- **Config hot-reload**: TaskSwarm is a standard DSH bundle — config overrides layered in the profile's `cordis.patch.yml` are hot-reloaded by DSH without a restart. **Caveat**: reloading the orchestrator plugin (e.g. editing its config row) aborts all running batches via its unload cleanup — do not touch orchestrator config while a batch is running.
- **Source HMR**: DSH does not enable plugin source HMR on the web profile (`cordis-plugin-hmr` is disabled by default); source changes require `npm run build` followed by a **dsh web restart**.
- **Batch recovery**: even after a restart, `.taskswarm/` disk state + checkpoints + lane branches persist; check `/orch-status` afterwards and resume/rerun failed lanes through the supervisor without losing completed work.
- **Wave plan is fixed at batch start**: the wave structure (how many waves, which tasks in each) is persisted and never recomputed mid-flight — pause/resume, crash recovery, and single-lane reruns all continue within the original wave layout. Completed waves stay done, remaining tasks keep their original wave numbers, and the dashboard/dingo wave segmentation stays consistent.

## Notifications & Token Efficiency

Supervisor notifications are designed to save tokens without losing information:

- **Complete, localized messages** — every notification (periodic report, wave complete, lane
  failed, stalled, batch complete) is already written in full, human-readable language (Chinese
  or English per the session locale), e.g.:

  ```
  [TaskSwarm] ⏱️ 定时汇报（每 5 分钟）：
  批次 b-msvinu6n — running（已完成 1/4）· 波次 1/2
    lane 1 [已合并] JM-402 · 步骤 8/8，218 步
  ```

- **The supervisor agent never re-translates or restates them** — the system prompt explicitly
  tells it: *notifications are already complete and readable; do NOT translate or repeat them;
  judge only whether there is an anomaly or an action needed — if yes, handle/report briefly; if
  no, stay quiet or acknowledge in one short line.* This is what actually saves tokens: the
  notification itself is written once in the cheapest place (the engine), and the model does not
  burn tokens re-explaining it back to the user.

- The design principle: **don't shrink the message, eliminate the re-explanation**. A terse
  message forces the model to translate/expand it (expensive); a complete message lets the user
  read it directly and lets the model act only on anomalies.

## Integration with dsh-dingo

TaskSwarm exposes a standard Cordis service for other DSH plugins:

```ts
const taskswarm = ctx.get('taskswarm')
const { batches } = taskswarm.getSnapshot()
```

Each batch includes `ownerSessionId`, so plugins like [dsh-dingo](https://github.com/february2015/dsh-dingo) can show a **“waiting for background/subtasks/swarm”** state on the main session card while the batch is still running.

This makes it possible to see “main conversation finished, but the swarm is still working” directly in the dsh-dingo card panel.

**Clean card list** — TaskSwarm's internal worker/reviewer/merger sessions never appear as user
cards in dsh-dingo: no purple draft counts, no stray cards, no reminders from sub-agents. Only the
main session that started the batch shows as a user card (with the "waiting for swarm" state).

## Docs

- **[Runbook (ops)](docs/runbook.md)** — standard operating procedures for cleanup, error recovery, and work salvage (required reading for supervisors / AI agents)
- **[Release Guide](docs/release.md)** — publishing to npm, version bumps, and the 2FA/bypass-token gotcha (for maintainers)
- **[Known Issues](docs/known-issues.md)** — root-cause analyses and fixes for resolved issues
- **[Changelog](CHANGELOG.md)** — version-by-version release notes (中文版 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md))

## License & Credits

- **MIT License** — free to use, modify, and redistribute
- Upstream **TaskPlane** ([github.com/HenryLach/taskplane](https://github.com/HenryLach/taskplane)): original design of wave orchestration, task packets, mailbox, and supervisor — this project is a native port
- Runtime: [DeepSeek Harness (DSH)](https://github.com/deepseek-ai)
