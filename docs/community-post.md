# TaskSwarm（蜂群）— wave-based multi-agent orchestration for DeepSeek Harness

> 蜂群 (fēngqún) is a swarm of bees: the queen directs, the workers each buzz on their own task in parallel — exactly what this project does: **the supervisor plans the waves, then every worker advances in its own lane**.

**TaskSwarm** is a native port of [TaskPlane](https://github.com/HenryLach/taskplane) (MIT) for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai). It arranges a batch of tasks into dependency-ordered **waves**, runs AI workers in **parallel lanes** isolated by git worktrees, then automatically reviews and merges their output.

## Install

```bash
dsh plugin --profile web add dsh-taskswarm
# restart dsh web, then in the session:
/tswarm-init        # scaffold two example task packets
/tswarm all         # run all tasks in parallel waves
/tswarm-status      # watch progress anytime
```

Compatibility aliases: `/orch`, `/orch-status`, … still work.

## Why TaskSwarm when DSH already has subagents?

DSH's native `subagent`/`workflow`/`goal` are *conversational, one-shot* scheduling — great for ad-hoc delegation. TaskSwarm is a **project-level orchestration layer** on top of them:

|               | DSH native subagents              | TaskSwarm                                                                                       |
| ------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Task shape    | one sentence in chat              | **task packets** (PROMPT.md / STATUS.md) — versioned, batchable, reusable                       |
| Parallelism   | manual                            | **wave planning**: dependency-topological waves, parallel lanes per wave                        |
| Isolation     | shared workspace (writes collide) | **git worktree isolation**: per-lane branch + checkpoints, merged into `taskswarm/orch`         |
| Quality gate  | none                              | **independent Reviewer** (PASS / REVISE)                                                        |
| Resumability  | gone when the process ends        | **durable batch state** (`.taskswarm/batches/*.json`): restart / resume / skip finished lanes   |
| Observability | watch the chat                    | **supervisor event reports + Web Dashboard**, auto-started with the batch, link printed in chat |

## Highlights

- **Waves/lanes execution** — dozens of tasks run in parallel waves, never all at once
- **Supervisor agent** — shares your session, reports wave completion / failures / batch done, takes verbal commands (`start`, `pause`, `abort`, `integrate`), bilingual (中文 / English)
- **Web Dashboard** — local realtime board (zero-dep node:http + SSE); **auto-starts when a batch starts and prints its link**; one dashboard per workspace, ever
- **Cross-model review** — reviewer agents (optionally a different model) gate every lane
- **Lane watchdog** — a stuck/vanished worker is force-finished so the wave keeps moving

## Links

- npm: <https://www.npmjs.com/package/dsh-taskswarm>
- GitHub: <https://github.com/february2015/dsh-taskswarm>
- Docs: `docs/runbook.md` in the repo · MIT License · upstream [TaskPlane](https://github.com/HenryLach/taskplane)
