/**
 * Spec for dashboard/history.mjs — WEB-004 history / STATUS.md / preferences.
 *
 * Two layers:
 *   1. Pure-function tests on `listHistory` / `getHistoryEntry` against a
 *      temporary stateRoot with hand-written BatchState files (incl. a corrupt
 *      one and a batch with no timestamps).
 *   2. Route-contract integration tests: `registerExtra` on a minimal
 *      WEB-003-contract router double (`on(method, path, handler)` +
 *      `handle(req, res)` with `:param` pattern matching), asserting every
 *      route's status/body/content-type — the same assertions WEB-004 adds to
 *      WEB-003's `server.spec.mjs` at assembly time (`/api/history` 200,
 *      `/api/status-md` known→原文 / unknown→404, preferences POST→GET 回读).
 *      `server.spec.mjs` itself lives in the WEB-003 lane (parallel), so this
 *      spec keeps the WEB-004 assertions self-contained to avoid a file clash.
 *
 * Zero external dependencies.
 *
 * Run: npm run build && node --test dashboard/history.spec.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listHistory, getHistoryEntry, registerExtra } from './history.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'taskswarm-web004-'))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

/** Write one BatchState file under `<stateRoot>/batches/<id>.json`. */
function writeBatch(stateRoot, id, overrides = {}) {
  mkdirSync(join(stateRoot, 'batches'), { recursive: true })
  const startedAt = overrides.startedAt || '2026-08-13T10:00:00.000Z'
  const startMs = Date.parse(startedAt)
  const state = {
    id,
    repoRoot: '/tmp/repo',
    tasksRoot: '/tmp/repo/tasks',
    stateRoot,
    phase: 'complete',
    scope: 'all',
    startedAt,
    endedAt: new Date(startMs + 90 * 60 * 1000).toISOString(), // +90min
    waves: 2,
    lanes: [
      { lane: 1, taskId: 'TASK-001', phase: 'merged', log: [] },
      { lane: 2, taskId: 'TASK-002', phase: 'failed', error: 'boom', log: [] },
    ],
    ...overrides,
  }
  writeFileSync(join(stateRoot, 'batches', `${id}.json`), JSON.stringify(state, null, 2))
  return state
}

// ─── listHistory / getHistoryEntry (pure) ───────────────────────────────────

test('listHistory: compact fields, newest-first sort, corrupt files skipped', () => {
  const root = tmp()
  try {
    const stateRoot = join(root, '.taskswarm')
    writeBatch(stateRoot, 'b-old', { startedAt: '2026-08-13T10:00:00.000Z' })
    writeBatch(stateRoot, 'b-new', {
      startedAt: '2026-08-13T12:00:00.000Z',
      waves: 3,
      lanes: [
        { lane: 1, taskId: 'TASK-001', phase: 'merged', log: [] },
        { lane: 2, taskId: 'TASK-002', phase: 'merged', log: [] },
        { lane: 3, taskId: 'TASK-003', phase: 'merged', log: [] },
      ],
    })
    // Corrupt / partial write must be skipped, not throw.
    writeFileSync(join(stateRoot, 'batches', 'b-corrupt.json'), '{ this is not json !!!')

    const list = listHistory(stateRoot)
    assert.equal(list.length, 2)
    assert.equal(list[0].batchId, 'b-new', 'newest startedAt first')
    assert.equal(list[1].batchId, 'b-old')

    const first = list[0]
    assert.equal(first.status, 'completed')
    assert.equal(first.startedAt, '2026-08-13T12:00:00.000Z')
    assert.equal(first.endedAt, '2026-08-13T13:30:00.000Z')
    assert.equal(first.durationMs, 90 * 60 * 1000)
    assert.equal(first.totalWaves, 3)
    assert.equal(first.totalTasks, 3)
    assert.equal(first.succeededTasks, 3)
    assert.equal(first.failedTasks, 0)
    assert.equal(first.tokens, 0)

    const second = list[1]
    assert.equal(second.totalTasks, 2)
    assert.equal(second.succeededTasks, 1)
    assert.equal(second.failedTasks, 1)
  } finally {
    cleanup(root)
  }
})

test('listHistory: status derivation — partial / failed / aborted / running', () => {
  const root = tmp()
  try {
    const stateRoot = join(root, '.taskswarm')
    writeBatch(stateRoot, 'b-partial', {
      phase: 'complete',
      lanes: [
        { lane: 1, taskId: 'TASK-001', phase: 'merged', log: [] },
        { lane: 2, taskId: 'TASK-002', phase: 'failed', log: [] },
      ],
    })
    writeBatch(stateRoot, 'b-failed', {
      phase: 'complete',
      lanes: [{ lane: 1, taskId: 'TASK-001', phase: 'failed', log: [] }],
    })
    writeBatch(stateRoot, 'b-aborted', { phase: 'aborted' })
    writeBatch(stateRoot, 'b-running', {
      phase: 'running',
      startedAt: '2026-08-13T12:00:00.000Z',
      endedAt: null, // still running
      lanes: [{ lane: 1, taskId: 'TASK-001', phase: 'running', log: [] }],
    })

    const byId = new Map(listHistory(stateRoot).map((e) => [e.batchId, e]))
    assert.equal(byId.get('b-partial').status, 'partial')
    assert.equal(byId.get('b-failed').status, 'failed')
    assert.equal(byId.get('b-aborted').status, 'aborted')
    assert.equal(byId.get('b-running').status, 'running')
    // Running batch with no endedAt still yields a non-negative duration.
    assert.ok(byId.get('b-running').durationMs >= 0)
    assert.equal(byId.get('b-running').endedAt, null)
  } finally {
    cleanup(root)
  }
})

test('listHistory: empty / missing stateRoot is a safe no-op', () => {
  const root = tmp()
  try {
    assert.deepEqual(listHistory(join(root, 'no-such-dir')), [])
    assert.deepEqual(listHistory(undefined), [])
    assert.deepEqual(listHistory(''), [])
  } finally {
    cleanup(root)
  }
})

test('getHistoryEntry: full BatchState plus summary superset', () => {
  const root = tmp()
  try {
    const stateRoot = join(root, '.taskswarm')
    writeBatch(stateRoot, 'b-1')

    const entry = getHistoryEntry(stateRoot, 'b-1')
    assert.ok(entry, 'found')
    // Full BatchState JSON preserved…
    assert.equal(entry.id, 'b-1')
    assert.equal(entry.repoRoot, '/tmp/repo')
    assert.equal(entry.phase, 'complete')
    assert.equal(entry.waves, 2)
    assert.equal(entry.lanes.length, 2)
    assert.deepEqual(entry.lanes[0], { lane: 1, taskId: 'TASK-001', phase: 'merged', log: [] })
    // …and the summary fields the frontend renderHistorySummary() consumes.
    assert.equal(entry.batchId, 'b-1')
    assert.equal(entry.status, 'partial')
    assert.equal(entry.totalTasks, 2)
    assert.equal(entry.succeededTasks, 1)
    assert.equal(entry.failedTasks, 1)
    assert.equal(entry.durationMs, 90 * 60 * 1000)
    assert.equal(entry.tokens, 0)
  } finally {
    cleanup(root)
  }
})

test('getHistoryEntry: null for missing batch and invalid/traversal ids', () => {
  const root = tmp()
  try {
    const stateRoot = join(root, '.taskswarm')
    writeBatch(stateRoot, 'b-1')
    assert.equal(getHistoryEntry(stateRoot, 'no-such-batch'), null)
    assert.equal(getHistoryEntry(stateRoot, '../b-1'), null)
    assert.equal(getHistoryEntry(stateRoot, 'b%2F1'), null)
    assert.equal(getHistoryEntry(undefined, 'b-1'), null)
  } finally {
    cleanup(root)
  }
})

// ─── registerExtra against the WEB-003 router contract ──────────────────────

/**
 * Minimal router faithful to the WEB-003 contract:
 * `on(method, path, handler)` + `handle(req, res)` with exact method and
 * pathname matching; `:param` segments match any single path segment. This is
 * the surface WEB-003's `createRouter()` must provide for the WEB-004 routes.
 */
function createRouterDouble() {
  const routes = []
  return {
    routes,
    on(method, path, handler) {
      routes.push({ method, path, handler })
    },
    handle(req, res) {
      const pathname = new URL(req.url, 'http://localhost').pathname
      for (const r of routes) {
        if (r.method !== req.method) continue
        if (matchPattern(r.path, pathname)) return r.handler(req, res)
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    },
  }
}

function matchPattern(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean)
  const s = pathname.split('/').filter(Boolean)
  if (p.length !== s.length) return false
  return p.every((seg, i) => seg.startsWith(':') || seg === s[i])
}

/** Invoke one request through the router double, capturing the response. */
function invoke(router, method, path, body) {
  const res = {
    _status: 200,
    _headers: {},
    _body: '',
    writeHead(status, headers) {
      this._status = status
      this._headers = { ...this._headers, ...(headers || {}) }
    },
    write(chunk) {
      this._body += String(chunk)
    },
    end(chunk) {
      if (chunk !== undefined) this._body += String(chunk)
    },
    get status() {
      return this._status
    },
    get headers() {
      return this._headers
    },
    get body() {
      return this._body
    },
  }
  const req = new EventEmitter()
  req.method = method
  req.url = path
  router.handle(req, res)
  if (body !== undefined) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    req.emit('data', Buffer.from(payload))
  }
  req.emit('end')
  return res
}

function setupFixture() {
  const root = tmp()
  const stateRoot = join(root, '.taskswarm')
  const tasksRoot = join(root, 'tasks')
  writeBatch(stateRoot, 'b-1', {
    lanes: [
      { lane: 1, taskId: 'TASK-001', phase: 'merged', worktree: join(root, 'worktrees', 'task-001'), log: [] },
    ],
  })
  // Lane worktree STATUS.md (preferred source).
  const worktreeDir = join(root, 'worktrees', 'task-001')
  mkdirSync(worktreeDir, { recursive: true })
  writeFileSync(join(worktreeDir, 'STATUS.md'), '# TASK-001 worktree status\n\n- [x] lane worktree\n')
  // tasksRoot fallback STATUS.md for a task with no lane.
  const taskDir = join(tasksRoot, 'TASK-002-slug')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(join(taskDir, 'STATUS.md'), '# TASK-002 tasks-root status\n\n- [x] tasks root fallback\n')

  const ctx = {
    stateRoot,
    tasksRoot,
    repoRoot: root,
    loadBatch: () => JSON.parse(readFileSync(join(stateRoot, 'batches', 'b-1.json'), 'utf-8')),
  }
  return { root, stateRoot, ctx }
}

test('registerExtra registers all five route groups', () => {
  const router = createRouterDouble()
  registerExtra(router, {})
  const paths = router.routes.map((r) => `${r.method} ${r.path}`).sort()
  assert.deepEqual(paths, [
    'GET /api/agent-events/:agentId',
    'GET /api/conversation/:prefix',
    'GET /api/history',
    'GET /api/history/:batchId',
    'GET /api/preferences',
    'GET /api/status-md/:taskId',
    'POST /api/preferences',
  ])
})

test('/api/history: 200 compact list; /api/history/:batchId: 200 full entry + 404 unknown', () => {
  const { root, ctx } = setupFixture()
  try {
    const router = createRouterDouble()
    registerExtra(router, ctx)

    const list = invoke(router, 'GET', '/api/history')
    assert.equal(list.status, 200)
    assert.match(list.headers['Content-Type'], /application\/json/)
    const parsed = JSON.parse(list.body)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].batchId, 'b-1')

    const entry = invoke(router, 'GET', '/api/history/b-1')
    assert.equal(entry.status, 200)
    assert.equal(JSON.parse(entry.body).id, 'b-1')
    assert.equal(JSON.parse(entry.body).status, 'completed')

    const missing = invoke(router, 'GET', '/api/history/nope')
    assert.equal(missing.status, 404)
    assert.ok(JSON.parse(missing.body).error)

    const traversal = invoke(router, 'GET', '/api/history/%2e%2e%2fsecret')
    assert.equal(traversal.status, 404)
  } finally {
    cleanup(root)
  }
})

test('/api/status-md: lane.worktree first, tasksRoot fallback, 404 unknown, 400 traversal', () => {
  const { root, ctx } = setupFixture()
  try {
    const router = createRouterDouble()
    registerExtra(router, ctx)

    // 1. lane.worktree STATUS.md (raw BatchState via loadBatch).
    const laneMd = invoke(router, 'GET', '/api/status-md/TASK-001')
    assert.equal(laneMd.status, 200)
    assert.match(laneMd.headers['Content-Type'], /text\/markdown/)
    assert.match(laneMd.body, /lane worktree/)

    // 2. tasksRoot/<taskId>-*/STATUS.md fallback (no lane for TASK-002).
    const fallbackMd = invoke(router, 'GET', '/api/status-md/TASK-002')
    assert.equal(fallbackMd.status, 200)
    assert.match(fallbackMd.body, /tasks root fallback/)

    // 3. unknown task → 404.
    const unknown = invoke(router, 'GET', '/api/status-md/TASK-999')
    assert.equal(unknown.status, 404)
    assert.ok(JSON.parse(unknown.body).error)

    // 4. taskId validation blocks traversal / junk. The WHATWG URL parser
    //    collapses some malformed segments (`..` → dot-segment normalization),
    //    so the id may end up as 400 (regex rejected) or 404 (collapsed to a
    //    different valid-looking id that simply doesn't exist) — the invariant
    //    is that it is never 200 and never reads outside the state root.
    for (const bad of ['..%2Fetc%2Fpasswd', 'a%2Fb', '%2E%2E', 'a b', 'a?b=1']) {
      const r = invoke(router, 'GET', `/api/status-md/${bad}`)
      assert.ok([400, 404].includes(r.status), `taskId ${bad} blocked (got ${r.status})`)
      assert.doesNotMatch(r.body, /etc\/passwd/, `taskId ${bad} never leaks file contents`)
    }
  } finally {
    cleanup(root)
  }
})

test('/api/status-md: dashboard-state shape (state.batch.lanes) also resolves', () => {
  const root = tmp()
  try {
    const stateRoot = join(root, '.taskswarm')
    const worktreeDir = join(root, 'worktrees', 'task-x')
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, 'STATUS.md'), '# dashboard-shape lane status\n')
    const ctx = {
      stateRoot,
      loadBatch: () => ({
        batch: {
          lanes: [{ taskId: 'TASK-X', phase: 'running', worktree: worktreeDir }],
        },
      }),
    }
    const router = createRouterDouble()
    registerExtra(router, ctx)
    const r = invoke(router, 'GET', '/api/status-md/TASK-X')
    assert.equal(r.status, 200)
    assert.match(r.body, /dashboard-shape lane status/)
  } finally {
    cleanup(root)
  }
})

test('/api/preferences: default {theme:dark}, POST merges, GET round-trips, file persisted', () => {
  const root = tmp()
  try {
    const ctx = { stateRoot: join(root, '.taskswarm') }
    const router = createRouterDouble()
    registerExtra(router, ctx)

    // Default.
    const initial = invoke(router, 'GET', '/api/preferences')
    assert.equal(initial.status, 200)
    assert.deepEqual(JSON.parse(initial.body), { theme: 'dark' })
    assert.equal(existsSync(join(ctx.stateRoot, 'dashboard-preferences.json')), false)

    // POST merges and persists.
    const posted = invoke(router, 'POST', '/api/preferences', { theme: 'light' })
    assert.equal(posted.status, 200)
    assert.deepEqual(JSON.parse(posted.body), { theme: 'light' })
    const persisted = JSON.parse(readFileSync(join(ctx.stateRoot, 'dashboard-preferences.json'), 'utf-8'))
    assert.deepEqual(persisted, { theme: 'light' })

    // GET round-trips the merged value.
    const reRead = invoke(router, 'GET', '/api/preferences')
    assert.deepEqual(JSON.parse(reRead.body), { theme: 'light' })

    // POST merges onto existing (keeps theme, adds key).
    const merged = invoke(router, 'POST', '/api/preferences', { fontSize: 14 })
    assert.equal(merged.status, 200)
    assert.deepEqual(JSON.parse(merged.body), { theme: 'light', fontSize: 14 })

    // Malformed body → 400, no crash.
    const bad = invoke(router, 'POST', '/api/preferences', '{not json')
    assert.equal(bad.status, 400)
    assert.ok(JSON.parse(bad.body).error)
  } finally {
    cleanup(root)
  }
})

test('/api/conversation/:prefix: 200 empty application/x-ndjson; /api/agent-events/:agentId: 200 []', () => {
  const { root, ctx } = setupFixture()
  try {
    const router = createRouterDouble()
    registerExtra(router, ctx)

    const conv = invoke(router, 'GET', '/api/conversation/some-prefix')
    assert.equal(conv.status, 200)
    assert.match(conv.headers['Content-Type'], /application\/x-ndjson/)
    assert.equal(conv.body, '')

    const events = invoke(router, 'GET', '/api/agent-events/agent-1')
    assert.equal(events.status, 200)
    assert.match(events.headers['Content-Type'], /application\/json/)
    assert.deepEqual(JSON.parse(events.body), [])
  } finally {
    cleanup(root)
  }
})

test('unregistered path still falls through to router 404 (no extra shadowing)', () => {
  const { root, ctx } = setupFixture()
  try {
    const router = createRouterDouble()
    registerExtra(router, ctx)
    const r = invoke(router, 'GET', '/api/state')
    assert.equal(r.status, 404)
  } finally {
    cleanup(root)
  }
})
