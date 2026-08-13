# Known Issues

> This file documents known but not-yet-fixed issues in dsh-buju. Each entry covers the symptom, root cause, relevant code locations, and candidate fix approaches.
> Rule: after a fix, move the entry to the `RESOLVED` section and note the fixing version/commit.

## OPEN

### KI-005: Worker's direct writes to task-package files trigger sandbox approval

- **Status:** ✅ Fixed (worker-level permission injection; v0.1.1 workspace, effective after restart)
- **Discovered:** 2026-08-14 (while batch `b-msrtvf7c-cea399` was running)
- **Symptom:** when a worker uses the fs tool to write `tasks/*/STATUS.md` directly in the main repo
  (task packages lie outside the lane worktree), the sandbox intercepts the write and pops up
  "waiting for approval".
- **Root cause:** the worker session's sandbox workspace = lane worktree, while task packages live
  in the main repo. `task_runner` goes through in-process node:fs and is unrestricted (which is why
  advance works), whereas the fs tool goes through the sandbox and gets blocked.
- **Fix description:** `src/worker/worker-tools.ts` adds `grantWorkerFullAccess()` — inside the
  `agents.create` setup for worker/reviewer it appends `sandbox/mode` (`danger-full-access`) +
  `approval/policy` (`never`) events to **the worker's own session** (DSH subagent delegation
  mechanism, same origin as `appendDelegatedPolicyOverrides` in `dsh-subagent`).
  Effect: the worker alone gets full access with no approvals; the GUI session and global profile
  configuration are left completely untouched, and `DSH_PERMISSION_MODE` is not required. Verified
  in practice:
  `sandbox overrideOf(worker)="danger-full-access"`、`approval effective="never"`.
- **Notes:** both the env route (`DSH_PERMISSION_MODE=danger-full-access`) and the global profile
  override (`~/.dsh/profiles/web/cordis.patch.yml`) were tried, but both change global behavior, so
  they were abandoned and the configuration restored; worker-level injection is the final approach.

---

### KI-006: Missing supervisor notifications — worker completions don't show up in the chat session automatically

- **Status:** ✅ Core loop implemented (conversational supervisor, TaskPlane port); audit/CI parts deferred
- **Discovered:** 2026-08-14 (discussed with the user after batch `b-msrtvf7c-cea399` ran through)
- **Gap (original):** TaskPlane had a conversational supervisor agent sharing the chat session with
  the operator, reporting worker progress in real time and requesting confirmation; when porting to
  Buju, only the mailbox storage was ported, and `engine.ts` merely drained and discarded messages
  via `drainInbox` at the end — users could only check manually via `/orch-status`.
- **Implementation (v0.1.1 workspace, effective after restart):** `src/orchestrator/supervisor.ts`
  (a port of TaskPlane's supervisor.ts, adapted to DSH):
  - `requiresConfirmation()` and `ACTION_CLASSIFICATION_EXAMPLES` ported as-is;
    actions are classified into three categories — diagnostic / tier0_known / destructive — and
    whether to ask the operator for confirmation first is decided by the autonomy level
    (interactive / supervised / autonomous)
  - The session agent is the supervisor: a supervisor system prompt plus two tools are injected
    (`buju_supervisor_status` for diagnostics, `buju_supervisor_control` for control)
  - The engine emits structured events (batch-started / lane-failed / lane-revise /
    batch-complete / batch-aborted); decision-type events **wake up** the session agent
    (`followup`), which verifies the facts → classifies the action → executes it or asks the
    operator first
  - Configuration: plugin `supervisorMode` (defaults to supervised)
- **Deferred (the rest of TaskPlane's ~4.7k lines):** audit-trail JSONL
  (actions.jsonl/events.jsonl), branch-protection detection, CI/PR lifecycle, and the
  batch-summary markdown template. The event contract is already in place, so these can be
  filled in incrementally on top of it.

---

## RESOLVED

<!-- After a fix, move the entry here and note the fixing version/commit. -->

### KI-004: Residual lane worktrees and branches after a killed process/abort block the next batch

- **Status:** ✅ Fixed (in source; `src/core/worktree.ts` `createLaneWorktree`)
- **Discovered:** 2026-08-14 (every lane of new batch `b-msrtspik-47088e` failed with `could not create lane worktree`)
- **Symptom:** after the old batch's process is killed, the `buju/<taskId>` branch and lane worktree
  directories are left behind; the new batch's `git worktree add -b buju/<taskId>` fails because the
  branch already exists, and all lanes fail instantly.
- **Fix description:** `createLaneWorktree` now removes leftover worktree directories first
  (falling back to `prune` on failure), and when the `buju/<taskId>` branch already exists it uses
  `git worktree add <branch> <dir>` (attaching to the existing branch) instead of `-b` (creating a
  new one). Takes effect after the next dsh web restart.
- **Notes:** the worktrees/branches of failed lanes are still kept for troubleshooting (existing
  engine design), but they no longer block subsequent batches.

---

### KI-001: worker/reviewer sessions appear under "Ungrouped" in the GUI sidebar

- **Status:** ✅ Fixed (v0.1.1 workspace, effective after restart)
- **Fix version:** v0.1.1 (unreleased; workspace fix)
- **Fix description:** ① `agents.create()` for worker/reviewer now passes
  `meta.origin: 'subagent'` (the sidebar automatically hides internal sessions);
  ② sessions are `dispose()`d when done (no longer leaving residue in memory or `~/.dsh/sessions/`).
- **Discovered:** 2026-08-14
- **How it was found:** after running `/orch all` in a dsh web (GUI) session, 3 sessions
  (lane worker + reviewer) appeared under "Ungrouped" in the sidebar, mixed in with this session.
- **Triggering batch:** `b-msrszf33-d79cf6` (2026-08-14 01:39, 6 lanes / 4 waves)

#### Symptom

- After `/orch` starts a batch, in-process worker/reviewer sessions appear under the "Ungrouped"
  group in the GUI sidebar.
- Sessions have no title (`session-<uuid>`), so it's impossible to tell which lane / task / batch
  they belong to.
- The sidebar gets polluted by internal sessions; the user's own sessions are mixed together with
  worker sessions.

#### Root cause (code level)

1. The GUI sidebar groups by **Host Workspace** (`@deepseek-ai/dsh-client-ui-workspace`): a
   session's group is determined by the `cwd` in its header (`sessionIds` in `dsh-workspace` =
   `host.sessionPath(id) === record.path`).
2. A Buju worker session's `cwd` is the lane worktree (`.buju/worktrees/<taskId>`), a transient
   git worktree with no corresponding workspace record → all worker sessions fall into the
   "Ungrouped" fallback bucket (`stray` in `groupByWorkspace`).
3. DSH has built-in **automatic hiding of subagent sessions**: the sidebar's `sessionVisible()`
   filters on `session.origin !== 'subagent'`. Buju didn't pass `meta.origin: 'subagent'` when
   creating agents, so these internal sessions were exposed in the list.

#### Relevant code locations

- `src/orchestrator/in-process-host.ts` — `agents.create({ sessionId, meta: { cwd: spec.worktree }, ... })`
  inside `spawn()` (**missing `origin: 'subagent'`**)
- `src/worker/reviewer.ts` — `createReviewerSpawner` is likewise missing `origin`
- Evidence on the DSH side:
  - `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` `sessionVisible`: `session.origin !== "subagent" && !archived.has(...)`
  - `@deepseek-ai/dsh-agent` `CreateAgentOptions.meta.origin?: 'subagent'`
  - `@deepseek-ai/dsh-session` `CreateSessionOptions.meta.origin?: 'subagent'`
  - `@deepseek-ai/dsh-workspace` workspace = normalized directory path; sessions are grouped by header.cwd

#### Candidate fixes

- **Option A (recommended):** add `meta: { origin: 'subagent', cwd: worktree, ... }` to
  `agents.create()` in `InProcessWorkerHost.spawn()` and `reviewer.ts`. Effect: worker/reviewer
  sessions are automatically hidden from the sidebar (consistent with their "internal executor"
  role); progress can be watched via `/orch-status` or the future dashboard.
  - Trade-off: worker sessions are no longer visible/clickable in the GUI (you can't watch a
    worker from the sidebar), but in-process logs and `.buju` state remain.
  - Prerequisites: `npm run build` + restart the dsh web process; this interrupts an in-flight
    batch (the in-process host depends on the web process staying alive).
- **Option B (keep current behavior):** don't hide them and accept "Ungrouped"; suited to
  scenarios where you need to click into a worker session from the GUI to inspect its process for
  debugging.
- **Option C (enhancement, stackable with A):** give worker sessions recognizable titles (via the
  `dsh-session-title` service or meta), so that even if they remain visible you can identify
  `lane N · <taskId>` at a glance.

#### Repro steps

1. `cd ~/myProject/dsh-buju && npm run build`
2. In a dsh web session: `/buju-init` → `/orch all`
3. Watch the sidebar: `session-<uuid>` sessions appear under "Ungrouped"
   (count = active workers + reviewer)

#### Notes

- This issue doesn't affect batch execution correctness (`b-msrszf33-d79cf6` ran normally, with
  lane state written to `.buju/batches/`); it's purely a UX issue.
- Related to the WEB-005/WEB-006 dashboard plans: once the dashboard ships, worker progress will
  have a proper visualization entry point, making Option A's hiding trade-off cheaper.

---

### KI-002: In-process workers under the web profile lack shell/file tools — tasks produce zero output

- **Fix version:** v0.1.1 (unreleased; workspace fix)
- **Fix description:** added `mountStandardTools()` in `src/worker/worker-tools.ts`, which —
  inside the `InProcessWorkerHost.spawn()` and reviewer `agents.create()` setup — mounts
  `dsh-tool-bash` / `dsh-tool-fs` / `dsh-tool-fs-search` /
  `dsh-tool-str-replace-editor` onto the agent scope when the scope doesn't include the `bash`
  tool (a workaround for the web profile's root-level tool disablement; automatically skipped
  under the dsh-base profile to avoid duplicate registration). Verified against a simulated web
  profile (root-level tool disablement): the worker toolset went from "lane tools only" to
  including `bash/edit/read/write/str_replace_editor`. `npm test` passes 9/9.
- **Triggering batch:** `b-msrszf33-d79cf6` (2026-08-14 01:39, 6 lanes / 4 waves)

#### Symptom

- After `/orch`, both wave-1 workers (WEB-001/WEB-002) were unable to execute: the escalate
  message read, verbatim, "Missing shell/file tooling: I cannot execute commands or modify files
  to perform the WEB-001 port", and lane-2 kept notifying "probing for a shell/filesystem tool to
  read upstream server.cjs and src/core".
- Both lane worktrees (web-001/web-002) have shown a **clean git status, zero commits, and zero
  output files** since the batch started (no `dashboard/`).
- The main repo's STATUS.md stayed at "Current Step: Preflight / Not Started", with no progress
  for 6 minutes after the last worker message.
- For comparison: in the sandbox verification with `dsh --profile buju-verify` documented in the
  README, the in-process worker could create files normally (under that profile the worker has
  tools).

#### Root cause

- `registerLaneTools()` (`src/worker/lane-tools.ts`) only registers the 4 bridge tools
  (task_runner / notify_supervisor / escalate_to_supervisor / review_step, etc.) and **doesn't
  include shell / filesystem tools**.
- The `setup` of `InProcessWorkerHost.spawn()` (`src/orchestrator/in-process-host.ts:38-45`) only
  calls `registerLaneTools(agentCtx, lane)` and never mounts bash/file tool plugins onto the
  worker scope.
- DSH's tool inheritance for agent scopes behaves differently between the web profile and the
  buju-verify sandbox profile: under the sandbox profile the worker got the tools, under the web
  profile it didn't (agent scopes don't inherit the per-session tool assembly of the GUI session).

#### Relevant code locations

- `src/worker/lane-tools.ts` — `registerLaneTools()` (bridge tools only)
- `src/orchestrator/in-process-host.ts` — the `setup` in `spawn()` (tool plugins not mounted)
- `src/worker/runner.ts` — the tool assembly of the headless worker bundle (reference: headless
  mode has the full toolset)
- DSH side: tool plugins such as `@deepseek-ai/dsh-bash-local`; agent-scope inheritance rules

#### Candidate fixes

- **Option A (recommended):** in the `setup` of `InProcessWorkerHost.spawn()`, mount standard tool
  plugins such as bash / filesystem alongside `registerLaneTools` (following the headless assembly
  in `src/worker/runner.ts`), so the in-process and headless toolsets stay identical.
- **Option B:** default to `host: headless` (a `dsh --profile buju-worker` subprocess with the
  full toolset built in).
- **Option C:** investigate the agent-scope tool inheritance mechanism under the web profile and
  fix it on the DSH side (if it's a framework behavior difference).

#### Repro steps

1. In a web profile (GUI) session: `/buju-init` → `/orch all`
2. Watch the mailbox (`.buju/mailbox/<batch>/supervisor/inbox/`): the worker escalates with
   "Missing shell/file tooling"
3. Check the lane worktree: no output at all

#### Notes

- Doesn't affect the planning/command layer (plan/status work fine); it's purely a worker
  execution-capability issue.
- Not contradictory to the successful headless verification (README) — the tool-assembly
  difference only surfaces under specific profile combinations.

---

---

### KI-003: Concurrent runLane's writeBatchState overwrites sibling lanes' state (incorrect status display)

- **Fix version:** v0.1.1 (unreleased; workspace fix)
- **Fix description:** removed the wholesale `writeBatchState(state)` of the stale in-memory
  `state` inside `engine.ts` runLane (that write would overwrite the on-disk results that
  concurrent sibling lanes had persisted via `updateLane`); lane persistence now uniformly goes
  through the per-lane `updateLane`, which is race-free by design.

#### Symptom

- With 2 concurrent lanes (wave-1), the on-disk `.buju/batches/*.json` shows lane 1 (WEB-001) as
  `pending` with no worktree, even though its worktree `web-001` was actually created and the
  worker session is alive.
- `/orch-status` / the dashboard would therefore show incorrect lane status.

#### Root cause

- `writeBatchState(state)` on line 162 of `runLane()` in `engine.ts` writes the **stale
  in-memory state object** to disk wholesale: the new lane object (`const lane = {...}`) was never
  inserted into `state.lanes`, so this write effectively rolled back the progress sibling lanes had
  already persisted via `updateLane()`.
- Concurrency timeline: lane1 `updateLane` (running/web-001) → lane2 `writeBatchState(state)`
  (stale, all pending) → overwrite → lane2 `updateLane` (running/web-002). Final disk =
  lane1 pending + lane2 running.

#### Relevant code locations

- `src/orchestrator/engine.ts:162` — `writeBatchState(state)` (early in runLane; writes stale
  shared state)
- `src/orchestrator/engine.ts:176` — `updateLane(...)` (the correct write, but overwritten by the
  above)
- `src/core/status.ts` — semantics of `updateLane` / `writeBatchState`

#### Candidate fixes

- **Option A (recommended):** remove the `writeBatchState(state)` on line 162 of runLane (lane
  persistence uniformly goes through `updateLane`, writing its own lane record in one shot,
  race-free by design).
- **Option B:** insert the new lane into `state.lanes` before writeBatchState
  (`state.lanes.push(lane)`) so the in-memory state matches the disk; but concurrent writes to the
  same file still have last-write-wins semantics, so this is inferior to Option A.
- **Option C:** change full-state writes to a single-writer / serial queue (engineering work; can
  be done later).

#### Repro steps

1. Two tasks with no dependencies (two lanes in wave-1)
2. `/orch all`
3. Read `.buju/batches/*.json`: the lane that started first may show pending/no worktree even
   though its worktree already exists

#### Notes

- A pure status-display issue; it doesn't affect actual worker execution, but it does affect the
  correctness of /orch-status and the future dashboard.

---
