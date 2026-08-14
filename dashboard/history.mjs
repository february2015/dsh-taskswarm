/**
 * WEB-004 — batch history / STATUS.md / preferences + degraded routes.
 *
 * Ports the TaskPlane `dashboard/server.cjs` endpoints that the WEB-003 core
 * server deliberately left out (`serveHistory`, `serveHistoryEntry`,
 * `serveStatusMd`, `handleGetPreferences`, `handlePostPreferences`), adapted
 * to taskswarm's persisted state. Registered through the WEB-003 router
 * contract:
 *
 *   createRouter() → { on(method, path, handler), handle(req, res) }
 *   handler signature: (req, res, ctx) => void
 *
 * `registerExtra(router, ctx)` is the WEB-005 assembly point; it does not
 * parse CLI args and never touches `server.mjs` — all dependencies arrive via
 * `ctx`:
 *
 *   stateRoot — taskswarm state root (the `.taskswarm` dir). Source of
 *     `batches/*.json` (history) and `dashboard-preferences.json` (theme).
 *   tasksRoot — tasks root; STATUS.md fallback lookup
 *               (`<tasksRoot>/<taskId>-*` folders).
 *   loadBatch — () => current batch state (raw BatchState with `.lanes`, or a
 *               dashboard state object with `.batch.lanes`); used to resolve
 *               the lane.worktree → STATUS.md path.
 *   repoRoot  — optional base for resolving relative `lane.worktree` paths.
 *
 * taskswarm has no upstream `batch-history.json`: the history list is derived
 * on the fly from `<stateRoot>/batches/*.json` (corrupt files are skipped).
 * It has no `worker-conversation-*.jsonl` and no runtime V2 registry, so
 * `/api/conversation/:prefix` and `/api/agent-events/:agentId` return the
 * empty-state payloads the ported frontend (`public/app.js`) already handles.
 *
 * ─── Routes ────────────────────────────────────────────────────────────────
 *   GET  /api/history              → compact list (newest first)
 *   GET  /api/history/:batchId     → full BatchState + summary fields
 *   GET  /api/status-md/:taskId    → raw STATUS.md text (lane.worktree first,
 *                                    then <tasksRoot>/<taskId>-*)
 *   GET  /api/preferences          → merged preferences, default {theme:"dark"}
 *   POST /api/preferences          → merge patch, persist, return merged
 *   GET  /api/conversation/:prefix → 200 empty application/x-ndjson
 *   GET  /api/agent-events/:agentId→ 200 []
 *
 * Zero external dependencies (node:fs / node:path / node:http request objects
 * only); reuses lib/core `readBatchState`/`batchStateDir` for parsing.
 *
 * @module taskswarm/dashboard/history
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { batchStateDir, readBatchState } from '../lib/core/status.js'

/** History-entry statuses the frontend switches on (completed/partial/…). */
export const HISTORY_STATUSES = ['completed', 'partial', 'failed', 'aborted', 'running', 'planning', 'paused']

/** Batch id / task id path components must be plain [\w-]+ (no traversal). */
const ID_RE = /^[\w-]+$/

const DEFAULT_PREFERENCES = { theme: 'dark' }
const PREFERENCES_FILE = 'dashboard-preferences.json'

// ─── Batch history (derived from <stateRoot>/batches/*.json) ────────────────

/**
 * Compact history list: scan `batches/*.json`, derive one summary entry per
 * batch, newest `startedAt` first. Corrupt / unparsable files are skipped
 * (never throws).
 *
 * @param {string} [stateRoot] - the `.taskswarm` state root
 * @returns {Array<{batchId,status,startedAt,endedAt,durationMs,totalWaves,totalTasks,succeededTasks,failedTasks,tokens}>}
 */
export function listHistory(stateRoot) {
  if (!stateRoot) return []
  const dir = batchStateDir(stateRoot)
  if (!existsSync(dir)) return []
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }

  const entries = []
  for (const name of names) {
    const state = readBatchState(stateRoot, name.replace(/\.json$/, ''))
    if (!state) continue // corrupt / partial write → skip, never throw
    entries.push(deriveHistorySummary(state))
  }

  entries.sort((a, b) => {
    const at = Date.parse(a.startedAt) || 0
    const bt = Date.parse(b.startedAt) || 0
    if (at !== bt) return bt - at
    return String(a.batchId).localeCompare(String(b.batchId))
  })
  return entries
}

/**
 * Full BatchState JSON for one batch id, superset-style: the raw BatchState
 * (`{id, repoRoot, tasksRoot, stateRoot, phase, scope, startedAt, endedAt,
 * waves, lanes}`) spread under the derived summary fields (`batchId`, `status`,
 * `totalTasks`, …) so the ported `renderHistorySummary()` can consume it
 * directly. Returns null when the batch does not exist or the id is invalid
 * (path-traversal guard).
 *
 * @param {string} [stateRoot] - the `.taskswarm` state root
 * @param {string} batchId     - batch id (`/^[\w-]+$/`)
 * @returns {object|null}
 */
export function getHistoryEntry(stateRoot, batchId) {
  if (!stateRoot || !batchId || !ID_RE.test(batchId)) return null
  const state = readBatchState(stateRoot, batchId)
  if (!state) return null
  return { ...state, ...deriveHistorySummary(state) }
}

/**
 * Derive the compact history record from one taskswarm BatchState.
 *
 * `status` maps the BatchState phase to the frontend's history vocabulary:
 *   complete + no failed lanes → 'completed'
 *   complete + mixed          → 'partial'
 *   complete + all failed     → 'failed'
 *   aborted                   → 'aborted'
 *   running/planning/paused   → the phase itself
 * `durationMs` is ended−started, or now−started while still running (0 when
 * the timestamps are missing/unparsable). `tokens` is pinned to 0 (taskswarm
 * has no telemetry).
 */
function deriveHistorySummary(state) {
  const lanes = Array.isArray(state.lanes) ? state.lanes : []
  const totalTasks = lanes.length
  const succeededTasks = lanes.filter((l) => l.phase === 'merged').length
  const failedTasks = lanes.filter((l) => l.phase === 'failed').length

  const startedAt = state.startedAt || null
  const endedAt = state.endedAt || null
  const startMs = startedAt ? Date.parse(startedAt) : NaN
  const endMs = endedAt ? Date.parse(endedAt) : NaN
  let durationMs = 0
  if (Number.isFinite(startMs)) {
    durationMs = Number.isFinite(endMs) ? endMs - startMs : Math.max(0, Date.now() - startMs)
  }

  return {
    batchId: state.id,
    status: deriveStatus(state.phase, { totalTasks, succeededTasks, failedTasks }),
    startedAt,
    endedAt,
    durationMs,
    totalWaves: Number.isFinite(state.waves) ? state.waves : 0,
    totalTasks,
    succeededTasks,
    failedTasks,
    tokens: 0,
  }
}

function deriveStatus(phase, counts) {
  if (phase === 'complete') {
    if (counts.failedTasks === 0 && counts.succeededTasks > 0) return 'completed'
    if (counts.succeededTasks > 0) return 'partial'
    if (counts.failedTasks > 0) return 'failed'
    return 'completed' // complete with zero lanes (degenerate) → completed
  }
  if (phase === 'aborted') return 'aborted'
  if (phase === 'running' || phase === 'planning' || phase === 'paused') return phase
  return phase || 'unknown'
}

// ─── STATUS.md (lane.worktree first, tasksRoot fallback) ────────────────────

/**
 * Locate the STATUS.md for a task: prefer the current batch lane's worktree
 * (`<lane.worktree>/STATUS.md`), fall back to the tasks root (folders named
 * `<taskId>-*`). Returns null when neither exists.
 * The taskId is validated against `/^[\w-]+$/` by the caller (path traversal
 * guard).
 */
function findStatusMd(ctx, taskId) {
  // 1. current batch state → lane.worktree (accepts raw BatchState or the
  //    adapters' dashboard state object).
  const state = typeof ctx.loadBatch === 'function' ? ctx.loadBatch() : null
  const lane = lanesFromState(state).find((l) => l && l.taskId === taskId)
  if (lane && lane.worktree) {
    const wt = resolveWorktree(ctx, lane.worktree)
    if (wt) {
      const p = join(wt, 'STATUS.md')
      if (existsSync(p)) return p
    }
  }

  // 2. tasksRoot/<taskId>-*/STATUS.md
  const tasksRoot = ctx.tasksRoot
  if (tasksRoot && existsSync(tasksRoot)) {
    for (const folder of taskFolderCandidates(tasksRoot, taskId)) {
      const p = join(tasksRoot, folder, 'STATUS.md')
      if (existsSync(p)) return p
    }
  }
  return null
}

/** `.lanes` from either a raw BatchState or a `{batch:{lanes}}` state object. */
function lanesFromState(state) {
  if (!state) return []
  if (Array.isArray(state.lanes)) return state.lanes
  if (state.batch && Array.isArray(state.batch.lanes)) return state.batch.lanes
  return []
}

/** Task folders matching the `<taskId>-*` convention (folder per packet). */
function taskFolderCandidates(tasksRoot, taskId) {
  try {
    return readdirSync(tasksRoot).sort().filter((n) => n.startsWith(`${taskId}-`))
  } catch {
    return []
  }
}

/** Resolve a (possibly relative) lane.worktree path against the repo root. */
function resolveWorktree(ctx, worktree) {
  if (isAbsolute(worktree)) return worktree
  const base = ctx.repoRoot || (ctx.stateRoot ? dirname(resolve(ctx.stateRoot)) : process.cwd())
  try {
    return resolve(base, worktree)
  } catch {
    return null
  }
}

// ─── Preferences (<stateRoot>/dashboard-preferences.json) ───────────────────

function preferencesPath(stateRoot) {
  return join(stateRoot, PREFERENCES_FILE)
}

/** Merged preferences; corrupt/absent file falls back to the default. */
function readPreferences(ctx) {
  if (!ctx.stateRoot) return { ...DEFAULT_PREFERENCES }
  const p = preferencesPath(ctx.stateRoot)
  if (!existsSync(p)) return { ...DEFAULT_PREFERENCES }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_PREFERENCES }
    }
    return { ...DEFAULT_PREFERENCES, ...parsed }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

// ─── Route handlers ──────────────────────────────────────────────────────────

function serveHistoryList(req, res, ctx) {
  sendJson(res, 200, listHistory(ctx.stateRoot))
}

function serveHistoryEntry(req, res, ctx) {
  const batchId = pathId(req)
  if (!batchId || !ID_RE.test(batchId)) {
    return sendJson(res, 404, { error: 'batch not found' })
  }
  const entry = getHistoryEntry(ctx.stateRoot, batchId)
  if (!entry) return sendJson(res, 404, { error: `Batch ${batchId} not found` })
  sendJson(res, 200, entry)
}

function serveStatusMd(req, res, ctx) {
  const taskId = pathId(req)
  if (!taskId || !ID_RE.test(taskId)) {
    return sendJson(res, 400, { error: 'invalid taskId' })
  }
  const statusPath = findStatusMd(ctx, taskId)
  if (!statusPath) {
    return sendJson(res, 404, { error: `STATUS.md for task ${taskId} not found` })
  }
  let text
  try {
    text = readFileSync(statusPath, 'utf-8')
  } catch {
    return sendJson(res, 404, { error: `STATUS.md for task ${taskId} not found` })
  }
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(text)
}

function serveGetPreferences(req, res, ctx) {
  sendJson(res, 200, readPreferences(ctx))
}

function servePostPreferences(req, res, ctx) {
  let raw = ''
  let done = false
  const finish = (status, payload) => {
    if (done) return
    done = true
    sendJson(res, status, payload)
  }
  req.on('error', () => finish(400, { error: 'invalid request body' }))
  req.on('data', (chunk) => {
    raw += String(chunk)
  })
  req.on('end', () => {
    let patch = {}
    try {
      patch = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      return finish(400, { error: 'invalid JSON body' })
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return finish(400, { error: 'body must be a JSON object' })
    }
    const merged = { ...readPreferences(ctx), ...patch }
    try {
      const p = preferencesPath(ctx.stateRoot)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(merged, null, 2), 'utf-8')
    } catch (err) {
      return finish(500, { error: err && err.message ? err.message : String(err) })
    }
    finish(200, merged)
  })
}

function serveConversation(req, res) {
  // taskswarm has no worker-conversation-*.jsonl: empty NDJSON stream. The
  // frontend renders the empty state ("No conversation events yet…").
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end('')
}

function serveAgentEvents(req, res) {
  // No runtime V2 registry in taskswarm: empty event array (frontend empty state).
  sendJson(res, 200, [])
}

/** Last path segment of req.url, URI-decoded (malformed → ''). */
function pathId(req) {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '')
  } catch {
    return ''
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    })
  }
  res.end(body)
}

/**
 * Register the five WEB-004 route groups on a WEB-003-style router.
 * Dependency-injected via `ctx` (stateRoot/tasksRoot/loadBatch/repoRoot) —
 * never parses CLI args, never touches server.mjs.
 *
 * @param {{on: (method: string, path: string, handler: Function) => void}} router
 * @param {object} [ctx]
 * @returns the same router (chainable)
 */
export function registerExtra(router, ctx = {}) {
  router.on('GET', '/api/history', (req, res) => serveHistoryList(req, res, ctx))
  router.on('GET', '/api/history/:batchId', (req, res) => serveHistoryEntry(req, res, ctx))
  router.on('GET', '/api/status-md/:taskId', (req, res) => serveStatusMd(req, res, ctx))
  router.on('GET', '/api/preferences', (req, res) => serveGetPreferences(req, res, ctx))
  router.on('POST', '/api/preferences', (req, res) => servePostPreferences(req, res, ctx))
  router.on('GET', '/api/conversation/:prefix', (req, res) => serveConversation(req, res, ctx))
  router.on('GET', '/api/agent-events/:agentId', (req, res) => serveAgentEvents(req, res, ctx))
  return router
}
