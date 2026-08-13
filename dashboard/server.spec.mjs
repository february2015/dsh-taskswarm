/**
 * Spec for dashboard/server.mjs — route registry, core routes, SSE, lifecycle.
 *
 * Covers the WEB-003 contract: createRouter (exact/pattern/wildcard), the
 * registerCore routes (/api/stream, /api/state, /api/health, static, CORS),
 * createServer JSON 404/500 fallbacks, and main() standalone startup with the
 * WEB-004 registerExtra (history.mjs) wired in. Zero external dependencies.
 *
 * Run: npm run build && node --test dashboard/server.spec.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRouter, registerCore, createServer } from './server.mjs'

// ─── Fixtures / helpers ──────────────────────────────────────────────────────

function tmp() {
  return mkdtempSync(join(tmpdir(), 'buju-web003-'))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

/** Write a BatchState JSON under `<root>/.buju/batches/`. */
function writeBatchState(root, state) {
  const dir = join(root, '.buju', 'batches')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${state.id}.json`), JSON.stringify(state, null, 2), 'utf-8')
}

function makeBatchState(root) {
  return {
    id: 'b-server-test',
    repoRoot: root,
    tasksRoot: join(root, 'tasks'),
    stateRoot: join(root, '.buju'),
    phase: 'running',
    scope: 'ALPHA-001',
    startedAt: '2026-08-13T10:00:00.000Z',
    waves: 1,
    lanes: [{ lane: 1, taskId: 'ALPHA-001', phase: 'running', log: [] }],
  }
}

/** Start `server` on an ephemeral port; close it when the test ends. */
async function listen(server, t) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const port = server.address().port
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  })
  return `http://127.0.0.1:${port}`
}

/** Race `promise` against a timeout that rejects after `ms`. */
function withTimeout(promise, ms, label = 'timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ])
}

/** Read SSE frames until `count` `data: ` frames have been seen. */
async function readFrames(reader, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let buf = ''
  let seen = 0
  while (seen < count) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const { value, done } = await withTimeout(reader.read(), remaining, 'SSE read timed out')
    if (done) break
    buf += new TextDecoder().decode(value)
    seen = (buf.match(/data: /g) || []).length
  }
  return buf
}

// ─── Router registry ─────────────────────────────────────────────────────────

test('router: unregistered path → 404, exact GET route hits after on()', async (t) => {
  const router = createRouter()
  const hits = []
  router.on('GET', '/x', (req, res) => {
    hits.push('x')
    res.end('ok')
  })
  const server = createServer(router)
  const base = await listen(server, t)

  // Unregistered path → createServer JSON 404.
  const missing = await fetch(`${base}/nope`)
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'Not Found' })

  // Registered exact route → hit.
  const hit = await fetch(`${base}/x`)
  assert.equal(hit.status, 200)
  assert.equal(await hit.text(), 'ok')
  assert.deepEqual(hits, ['x'])

  // Method mismatch → 404 (POST /x not registered).
  const wrongMethod = await fetch(`${base}/x`, { method: 'POST' })
  assert.equal(wrongMethod.status, 404)
})

test('router: :param pattern routes populate ctx.params', async (t) => {
  const router = createRouter()
  const seen = []
  router.on('GET', '/api/status-md/:taskId', (req, res, ctx) => {
    seen.push({ ...ctx.params })
    res.end('ok')
  })
  const server = createServer(router)
  const base = await listen(server, t)

  await fetch(`${base}/api/status-md/ALPHA-001-one`)
  await fetch(`${base}/api/status-md/other-2`)
  assert.deepEqual(seen, [{ taskId: 'ALPHA-001-one' }, { taskId: 'other-2' }])

  // Pattern does not match extra segments.
  const extra = await fetch(`${base}/api/status-md/a/b`)
  assert.equal(extra.status, 404)
})

// ─── registerCore endpoints ──────────────────────────────────────────────────

test('registerCore: health 200, state batch:null, static index, unknown 404', async (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  mkdirSync(join(root, '.buju', 'batches'), { recursive: true })

  const ctx = { stateRoot: join(root, '.buju'), tasksRoot: join(root, 'tasks') }
  const router = createRouter()
  registerCore(router, ctx)
  const server = createServer(router, ctx)
  const base = await listen(server, t)

  // /api/health
  const health = await fetch(`${base}/api/health`)
  assert.equal(health.status, 200)
  const healthJson = await health.json()
  assert.equal(healthJson.status, 'ok')
  assert.equal(typeof healthJson.timestamp, 'number')

  // /api/state — no batch yet → batch:null, contract keys present.
  const state = await fetch(`${base}/api/state`)
  assert.equal(state.status, 200)
  assert.equal(state.headers.get('access-control-allow-origin'), '*')
  const stateJson = await state.json()
  assert.equal(stateJson.batch, null)
  assert.deepEqual(stateJson.sessions, [])
  assert.equal(typeof stateJson.timestamp, 'number')

  // Static: / → index.html contains "Buju Dashboard".
  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type'), /text\/html/)
  const html = await index.text()
  assert.ok(html.includes('Buju Dashboard'), 'index.html contains Buju Dashboard')

  // Static: app.js served with JS mime.
  const appjs = await fetch(`${base}/app.js`)
  assert.equal(appjs.status, 200)
  assert.match(appjs.headers.get('content-type'), /javascript/)
  assert.match(await appjs.text(), /EventSource/)

  // Unknown API route → unified JSON 404.
  const apiMissing = await fetch(`${base}/api/nope`)
  assert.equal(apiMissing.status, 404)
  assert.deepEqual(await apiMissing.json(), { error: 'Not Found' })

  // Missing static file → JSON 404 (静态 404).
  const staticMissing = await fetch(`${base}/nope.css`)
  assert.equal(staticMissing.status, 404)
  assert.deepEqual(await staticMissing.json(), { error: 'Not Found' })

  // CORS preflight.
  const preflight = await fetch(`${base}/api/preferences`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/)
})

test('registerCore: /api/state reflects a real batch from .buju/batches', async (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  mkdirSync(join(root, 'tasks'), { recursive: true })
  writeBatchState(root, makeBatchState(root))

  const ctx = { stateRoot: join(root, '.buju'), tasksRoot: join(root, 'tasks') }
  const router = createRouter()
  registerCore(router, ctx)
  const server = createServer(router, ctx)
  const base = await listen(server, t)

  const state = await (await fetch(`${base}/api/state`)).json()
  assert.equal(state.batch.batchId, 'b-server-test')
  assert.equal(state.batch.phase, 'running')
  assert.equal(state.batch.lanes[0].taskId, 'ALPHA-001')
})

test('registerCore: path traversal cannot escape public/', async (t) => {
  const ctx = { stateRoot: join(tmp(), '.buju') }
  const router = createRouter()
  registerCore(router, ctx)
  const server = createServer(router, ctx)
  const base = await listen(server, t)

  // Raw request with an unnormalized traversal path (fetch would normalize).
  const { request } = await import('node:http')
  const url = new URL(base)
  const body = await new Promise((resolve) => {
    const req = request(
      { host: url.hostname, port: url.port, path: '/../package.json' },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.end()
  })
  // Either 403 (guard) or 404 (normalized to /package.json, absent from
  // public/) — never the workspace package.json itself.
  assert.ok([403, 404].includes(body.status), `status ${body.status}`)
  assert.ok(!body.body.includes('"dsh-buju"'), 'workspace package.json leaked')
})

// ─── SSE ─────────────────────────────────────────────────────────────────────

test('SSE: initial data frame pushed immediately on connect', async (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  mkdirSync(join(root, '.buju', 'batches'), { recursive: true })

  const ctx = { stateRoot: join(root, '.buju'), tasksRoot: join(root, 'tasks') }
  const router = createRouter()
  registerCore(router, ctx)
  const server = createServer(router, ctx)
  const base = await listen(server, t)

  const res = await fetch(`${base}/api/stream`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const reader = res.body.getReader()
  t.after(() => res.body.cancel().catch(() => {}))

  const initialText = await withTimeout(readFrames(reader, 1, 3000), 5000, 'initial SSE frame missing')
  const initial = JSON.parse(initialText.split('\n')[0].slice('data: '.length))
  assert.equal(initial.batch, null)
  assert.equal(typeof initial.timestamp, 'number')
})

test('SSE push: main() fs.watch on .buju/batches/ → instant frame (curl-style smoke)', async (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  mkdirSync(join(root, '.buju', 'batches'), { recursive: true })

  // Spawn the real server (main()) — the 2s poll + fs.watch watcher only run
  // in main()'s lifecycle, mirroring the Step-4 curl smoke:
  //   curl -N /api/stream  → initial frame; touch .buju/batches/x → new frame.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url))
  const child = spawn(
    process.execPath,
    [serverPath, '--root', root, '--no-open', '--port', '0'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  t.after(() => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  })

  const output = await withTimeout(
    new Promise((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
        if (out.includes('Buju Dashboard → http://localhost:')) resolve(out)
      })
      child.stderr.on('data', (d) => (out += d.toString()))
      child.on('exit', (code) => reject(new Error(`child exited early (code ${code}): ${out}`)))
    }),
    8000,
    'server did not start',
  )
  const port = Number(output.match(/http:\/\/localhost:(\d+)/)[1])
  const base = `http://127.0.0.1:${port}`

  // Frame 1: initial state (batch:null).
  const res = await fetch(`${base}/api/stream`)
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  const initialText = await withTimeout(readFrames(reader, 1, 3000), 5000, 'initial SSE frame missing')
  const initial = JSON.parse(initialText.split('\n')[0].slice('data: '.length))
  assert.equal(initial.batch, null)

  // Frame 2: touch a new batch file → fs.watch debounce → broadcast.
  writeBatchState(root, makeBatchState(root))
  const pushedText = await withTimeout(
    readFrames(reader, (initialText.match(/data: /g) || []).length + 1, 5000),
    9000,
    'fs.watch push frame missing',
  )
  const frames = pushedText.split('data: ').filter(Boolean).map((f) => f.trim().split('\n')[0])
  const pushed = JSON.parse(frames[frames.length - 1])
  assert.equal(pushed.batch.batchId, 'b-server-test', 'pushed frame carries the new batch')

  // Clean shutdown.
  await res.body.cancel().catch(() => {})
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const { code } = await withTimeout(exited, 5000, 'child did not exit after SIGTERM')
  assert.equal(code, 0)
})

// ─── main() / CLI lifecycle ──────────────────────────────────────────────────

test('main(): standalone launch (registerCore + WEB-004 registerExtra) + clean SIGTERM exit', async (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  mkdirSync(join(root, '.buju', 'batches'), { recursive: true })

  const repoRoot = fileURLToPath(new URL('..', import.meta.url)) // worktree root
  const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url))
  const child = spawn(
    process.execPath,
    [serverPath, '--root', root, '--no-open', '--port', '0'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  t.after(() => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  })

  // Wait for the startup log, which also proves registerExtra (WEB-004) wired in
  // without breaking standalone launch.
  const output = await withTimeout(
    new Promise((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
        if (out.includes('Buju Dashboard → http://localhost:')) resolve(out)
      })
      child.stderr.on('data', (d) => (out += d.toString()))
      child.on('exit', (code) => reject(new Error(`child exited early (code ${code}): ${out}`)))
    }),
    8000,
    'server did not start',
  )
  assert.match(output, /Buju Dashboard → http:\/\/localhost:\d+/)

  const port = Number(output.match(/http:\/\/localhost:(\d+)/)[1])
  const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert.equal(health.status, 200)

  // Graceful shutdown: SIGTERM → exit code 0.
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const { code } = await withTimeout(exited, 5000, 'child did not exit after SIGTERM')
  assert.equal(code, 0)
})

test('main(): --help prints usage and exits 0', async () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url))
  const child = spawn(process.execPath, [serverPath, '--help'], { cwd: repoRoot })
  let out = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  const { code } = await withTimeout(
    new Promise((resolve) => child.on('exit', (c) => resolve({ code: c }))),
    5000,
    '--help did not exit',
  )
  assert.equal(code, 0)
  assert.match(out, /Usage:/)
  assert.match(out, /--port/)
  assert.match(out, /--no-open/)
})
