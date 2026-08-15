/**
 * Dashboard data adapter — taskswarm persisted state → TaskPlane dashboard JSON.
 *
 * Translates taskswarm's durable state (`.taskswarm/batches/<batchId>.json` BatchState,
 * `<tasksRoot>/<ID>-<slug>/PROMPT.md|STATUS.md`, `.taskswarm/mailbox/<batchId>/...`)
 * into the JSON contract that the TaskPlane frontend (`dashboard/public/app.js`,
 * ported by WEB-001) expects. The contract is fixed from TaskPlane
 * `dashboard/server.cjs` → `buildDashboardState()`; features taskswarm does not
 * have (runtime registry, telemetry, lane sidecars, supervisor, merge agents,
 * sessions) degrade to empty-state defaults, exactly as the upstream server does
 * when the corresponding data is absent.
 *
 * ─── Contract (from upstream server.cjs buildDashboardState()) ──────────────
 * Returns an object with the following top-level keys:
 *
 *   laneStates            {}                              — legacy lane-state-*.json sidecars (dsh: none)
 *   telemetry             {}                              — JSONL telemetry per session (dsh: none)
 *   batchTotalCost        0                               — aggregated cost (dsh: no telemetry)
 *   supervisor            null                            — supervisor data (not implemented)
 *   runtimeRegistry       null                            — runtime V2 registry (not implemented)
 *   runtimeLaneSnapshots  {}                              — runtime V2 lane snapshots (not implemented)
 *   runtimeMergeSnapshots {}                              — runtime V2 merge snapshots (not implemented)
 *   mailbox               { messages, agentIds, auditEvents }
 *   batch                 { batchId, phase, startedAt, updatedAt,
 *                           currentWaveIndex, totalWaves, wavePlan, lanes,
 *                           tasks, mergeResults, errors, lastError,
 *                           mode, segments }              — null when no batch exists
 *   sessions              []                              — active session names (dsh: none)
 *   tmuxSessions          []                              — legacy alias of sessions
 *   timestamp             Date.now()
 *
 * batch.wavePlan is `string[][]` — one entry per wave, each an array of taskIds
 * (upstream app.js: `batch.wavePlan.forEach((taskIds, i) => ...)`, and engine.ts
 * persists `wavePlan: wavePlan.map((wave) => [...wave])`). taskswarm does not
 * persist the wave→task mapping, so the adapter recomputes it from the tasks
 * root via lib/core `scanTasks()` + `buildWaves()`, filtered to the batch's lane
 * taskIds so it always lines up with `batch.lanes[].taskId`.
 *
 * batch.lanes[].laneSessionId is derived from the lane worktree directory name
 * (taskswarm lane worktrees live at `<stateRoot>/worktrees/<sanitized-task-id>`,
 * e.g. `.../web-002`); falls back to `lane-<N>` when no worktree is recorded.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   import { buildDashboardState } from './adapters.mjs'
 *   const state = buildDashboardState({ stateRoot: '/path/to/repo/.taskswarm' })
 *   const specific = buildDashboardState({ stateRoot, batchId: 'b-xxxx' })
 *
 * Pure functions + fs reads only — no HTTP/SSE (that is WEB-003). Zero external
 * dependencies; reuses the tested lib/core parsers (status/discover/task/mailbox).
 *
 * @module taskswarm/dashboard/adapters
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readBatchState, latestBatch } from '../lib/core/status.js'
import { scanTasks, buildWaves } from '../lib/core/discover.js'
import { parseStatusFile } from '../lib/core/task.js'
import { mailboxRoot } from '../lib/core/mailbox.js'

/** dsh lane phase → upstream persisted task status (app.js switches on these). */
const LANE_PHASE_TO_TASK_STATUS = {
  pending: 'pending',
  running: 'running',
  review: 'review',
  conflict: 'conflict',
  merged: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
}

/**
 * Empty-state defaults for features taskswarm does not implement, plus the
 * no-batch object. Mirrors the upstream server.cjs empty branch (which returns
 * { batch: null, sessions, tmuxSessions, laneStates, telemetry, batchTotalCost,
 * supervisor, timestamp }) and additionally pins the runtime V2 keys to their
 * defaults so every contract key is always present.
 */
export function emptyDashboardState() {
  return {
    batch: null,
    laneStates: {},
    telemetry: {},
    batchTotalCost: 0,
    supervisor: null,
    runtimeRegistry: null,
    runtimeLaneSnapshots: {},
    runtimeMergeSnapshots: {},
    mailbox: { messages: [], agentIds: [], auditEvents: [] },
    sessions: [],
    tmuxSessions: [],
    timestamp: Date.now(),
  }
}

/**
 * Build the full dashboard state object.
 *
 * @param {object} [options]
 * @param {string} [options.stateRoot] - taskswarm state root (the `.taskswarm` dir).
 *   Required unless the batch state itself provides it.
 * @param {string} [options.batchId]   - explicit batch id; defaults to the
 *   latest batch under `<stateRoot>/batches/` (upstream semantics).
 * @param {string} [options.tasksRoot] - override for the tasks root (defaults to
 *   the value persisted in the BatchState).
 * @returns the contract object above.
 */
export function buildDashboardState(options = {}) {
  const { stateRoot, batchId, tasksRoot: tasksRootOverride } = options
  if (!stateRoot) return emptyDashboardState()
  const state = batchId ? readBatchState(stateRoot, batchId) : latestBatch(stateRoot)
  if (!state) return emptyDashboardState()

  const tasksRoot = tasksRootOverride || state.tasksRoot || join(state.repoRoot || stateRoot, 'tasks')

  // Reuse lib/core discovery to recompute the wave plan from the tasks root.
  // includeDone = true so merged lanes (`.DONE` present) stay in the plan.
  const discovered = scanTasks(tasksRoot, true)
  const byTaskId = new Map(discovered.map((d) => [d.task.id, d]))
  const laneTaskIds = state.lanes.map((l) => l.taskId)
  const batchTasks = laneTaskIds.map((tid) => byTaskId.get(tid)?.task).filter(Boolean)
  const plan = buildWaves(batchTasks)
  let wavePlan = plan.waves.map((wave) => wave.map((t) => t.id))
  // Degenerate fallback: lanes exist but nothing scanned (tasks root moved or
  // empty) — a single wave keeps the dashboard renderable.
  if (wavePlan.length === 0 && laneTaskIds.length > 0) wavePlan = [[...laneTaskIds]]

  const lanes = state.lanes.map(mapLane)
  const lanesByTaskId = new Map(state.lanes.map((l) => [l.taskId, l]))
  const tasks = state.lanes.map((l) => mapTask(l, byTaskId.get(l.taskId)))

  const errors = state.lanes
    .filter((l) => typeof l.error === 'string' && l.error.length > 0)
    .map((l) => ({ lane: l.lane, taskId: l.taskId, error: l.error }))
  const lastError = errors.length > 0 ? errors[errors.length - 1].error : null

  const mailbox = adaptMailbox(state.stateRoot || stateRoot, state.id)

  return {
    laneStates: {},
    telemetry: {},
    batchTotalCost: 0,
    supervisor: null,
    runtimeRegistry: null,
    runtimeLaneSnapshots: {},
    runtimeMergeSnapshots: {},
    mailbox,
    batch: {
      batchId: state.id,
      phase: state.phase,
      startedAt: state.startedAt,
      updatedAt: state.endedAt || state.startedAt,
      currentWaveIndex: deriveCurrentWaveIndex(wavePlan, lanesByTaskId),
      totalWaves: state.waves,
      wavePlan,
      lanes,
      tasks,
      mergeResults: [],
      errors,
      lastError,
      mode: 'repo',
      segments: [],
    },
    sessions: [],
    tmuxSessions: [],
    timestamp: Date.now(),
  }
}

/** Map one taskswarm LaneState to the upstream lane record shape. */
function mapLane(lane) {
  return {
    laneNumber: lane.lane,
    taskId: lane.taskId,
    // Upstream persisted lane records carry taskIds[] — app.js resolves each
    // lane's task rows from `lane.taskIds`. taskswarm runs one task per lane.
    taskIds: [lane.taskId],
    laneSessionId: lane.worktree ? basename(lane.worktree) : `lane-${lane.lane}`,
    worktreePath: lane.worktree || null,
    phase: lane.phase,
    startedAt: lane.startedAt || null,
    endedAt: lane.endedAt || null,
    exitCode: lane.exitCode ?? null,
    error: lane.error || null,
    reviewVerdict: lane.reviewVerdict || null,
    log: Array.isArray(lane.log) ? lane.log : [],
  }
}

/** Map one lane + its discovered task packet to an upstream task record. */
function mapTask(lane, discovered) {
  const taskFolder = discovered?.task?.folder || null
  const doneFileFound = taskFolder ? existsSync(join(taskFolder, '.DONE')) : false
  return {
    taskId: lane.taskId,
    taskFolder,
    laneNumber: lane.lane,
    status: LANE_PHASE_TO_TASK_STATUS[lane.phase] || lane.phase,
    statusData: taskFolder ? buildStatusData(taskFolder) : null,
    taskTitle: discovered?.task?.name || null,
    doneFileFound,
    startedAt: lane.startedAt ? Date.parse(lane.startedAt) : null,
    endedAt: lane.endedAt ? Date.parse(lane.endedAt) : null,
  }
}

/**
 * Build task.statusData: lib/core `parseStatusFile()` (status/currentStep/done)
 * plus the STATUS.md checkbox/iteration regexes the upstream parseStatusMd uses
 * (currentStep/checked/total/progress). Returns null when STATUS.md is absent
 * (upstream behavior).
 */
export function buildStatusData(taskFolder) {
  const statusPath = join(taskFolder, 'STATUS.md')
  if (!existsSync(statusPath)) return null
  const info = parseStatusFile(taskFolder)
  const content = readFileSync(statusPath, 'utf-8')
  const iterMatch = content.match(/\*\*Iteration:\*\*\s*(\d+)/)
  const reviewMatch = content.match(/\*\*Review Counter:\*\*\s*(\d+)/)
  const checked = (content.match(/- \[x\]/gi) || []).length
  const unchecked = (content.match(/- \[ \]/g) || []).length
  const total = checked + unchecked
  return {
    currentStep: info.currentStep || 'Unknown',
    status: info.status,
    iteration: iterMatch ? parseInt(iterMatch[1], 10) : 0,
    reviews: reviewMatch ? parseInt(reviewMatch[1], 10) : 0,
    checked,
    total,
    progress: total > 0 ? Math.round((checked / total) * 100) : 0,
  }
}

/**
 * First wave index that contains at least one non-pending lane. Matches the
 * upstream intent (`currentWaveIndex` marks the currently-executing wave).
 * All-pending (or empty) plans report wave 0.
 */
export function deriveCurrentWaveIndex(wavePlan, lanesByTaskId) {
  for (let i = 0; i < wavePlan.length; i++) {
    const hasWork = wavePlan[i].some((tid) => {
      const lane = lanesByTaskId.get(tid)
      return lane && lane.phase !== 'pending'
    })
    if (hasWork) return i
  }
  return 0
}

/**
 * Mailbox adapter: scan `<stateRoot>/mailbox/<batchId>/` and produce the
 * upstream `{ messages, agentIds, auditEvents }` payload.
 *
 * taskswarm layout (lib/core/mailbox.ts):
 *   <stateRoot>/mailbox/<batchId>/<session>/{inbox, outbox}
 *   <stateRoot>/mailbox/<batchId>/<session>/inbox/_ack   (acked messages)
 *   <stateRoot>/mailbox/<batchId>/broadcast              (supervisor → all)
 *
 * Message files are `*.json` (TaskPlane used `*.msg.json`); both are accepted.
 * _status mapping (per task spec): inbox→pending, ack→delivered, outbox→reply.
 * Messages are sorted by timestamp ascending (upstream `loadMailboxData`).
 *
 * @param {string} stateRoot - the `.taskswarm` state root
 * @param {string} batchId   - batch id
 * @returns {{ messages: object[], agentIds: string[], auditEvents: object[] }}
 */
export function adaptMailbox(stateRoot, batchId) {
  const root = mailboxRoot(stateRoot, batchId)
  if (!existsSync(root)) return { messages: [], agentIds: [], auditEvents: [] }

  const messages = []
  const agentIds = []
  let sessionDirs = []
  try {
    sessionDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    sessionDirs = []
  }

  for (const session of sessionDirs) {
    if (session === 'broadcast' || session === '_broadcast') continue
    agentIds.push(session)
    // inbox (pending), ack (delivered), outbox (reply)
    for (const [sub, status] of [
      ['inbox', 'pending'],
      ['ack', 'delivered'],
      ['outbox', 'reply'],
    ]) {
      readMessageDir(join(root, session, sub), status, session, false, messages)
    }
    // taskswarm ack mechanism moves consumed messages into inbox/_ack/.
    readMessageDir(join(root, session, 'inbox', '_ack'), 'delivered', session, false, messages)
  }

  // broadcast: supervisor → all lanes (single shared inbox dir).
  for (const sub of ['broadcast', '_broadcast']) {
    readMessageDir(join(root, sub), 'pending', sub, true, messages)
  }

  messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

  return {
    messages,
    agentIds,
    auditEvents: loadAuditEvents(root),
  }
}

/** Read one mailbox message directory, mapping dsh messages to the contract. */
function readMessageDir(dir, status, agentDir, isBroadcast, out) {
  if (!existsSync(dir)) return
  let names = []
  try {
    names = readdirSync(dir).filter((n) => !n.startsWith('.') && n.endsWith('.json'))
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    let msg
    try {
      msg = JSON.parse(readFileSync(full, 'utf-8'))
    } catch {
      continue // skip corrupt / partial message files
    }
    if (!msg || typeof msg !== 'object') continue
    out.push(adaptMailboxMessage(msg, status, agentDir, isBroadcast))
  }
}

/** Map a taskswarm MailboxMessage ({id,from,to,type,payload,ts}) → contract. */
export function adaptMailboxMessage(msg, status, agentDir, isBroadcast = false) {
  const payload = msg.payload
  const timestamp = typeof msg.ts === 'string' ? Date.parse(msg.ts) : 0
  return {
    id: msg.id || null,
    from: msg.from || null,
    to: msg.to || null,
    type: msg.type || null,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    subject: deriveSubject(payload),
    body: payload ?? null,
    content: deriveContent(payload),
    _status: status,
    _agentDir: agentDir,
    _isBroadcast: isBroadcast,
  }
}

/** Human-readable one-line subject from a dsh mailbox payload. */
function deriveSubject(payload) {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload
  if (typeof payload === 'object') {
    const p = payload
    return (
      p.subject ??
      p.reason ??
      p.issue ??
      p.message ??
      p.description ??
      p.type ??
      (typeof p.taskId === 'string' ? `task ${p.taskId}` : '') ??
      ''
    )
  }
  return ''
}

/** Preview string for app.js `msg.content`. */
function deriveContent(payload) {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

/** Read `<root>/events.jsonl` audit events (taskswarm does not write these yet). */
function loadAuditEvents(root) {
  const eventsPath = join(root, 'events.jsonl')
  if (!existsSync(eventsPath)) return []
  const events = []
  try {
    const raw = readFileSync(eventsPath, 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        continue
      }
    }
  } catch {
    return []
  }
  return events
}
