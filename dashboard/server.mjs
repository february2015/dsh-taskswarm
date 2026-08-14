#!/usr/bin/env node
/**
 * TaskSwarm Dashboard — local HTTP server with SSE live updates.
 *
 * Port of TaskPlane `dashboard/server.cjs` (github.com/HenryLach/taskplane,
 * MIT License) to ESM + taskswarm data sources. Keeps every upstream advantage:
 * node:http with zero external dependencies, SSE initial-state + 2s polling +
 * `fs.watch` instant push, `--port/--root/--no-open` CLI, auto-open browser,
 * graceful shutdown. State JSON is produced by WEB-002's `dashboard/adapters.mjs`
 * (`buildDashboardState`) — this module never parses `.taskswarm` files itself.
 *
 * ─── Routing composition contract (WEB-003 × WEB-004) ──────────────────────
 * The server is a route-registry so WEB-004 (history/status-md/preferences)
 * and WEB-003 (SSE + core routes) develop in parallel with zero file
 * conflicts. Shared contract:
 *
 *   createRouter()                 → { on(method, path, handler), handle(req, res, ctx) }
 *                                    - `on`: exact `METHOD /path`, `:param` segments
 *                                      (`/api/history/:batchId`), `*` whole-path wildcard
 *                                    - `handle`: exact match → param patterns → wildcard;
 *                                      returns true when a handler ran, false on no match
 *   registerCore(router, ctx)      — this module: /api/stream, /api/state, /api/health,
 *                                    static files, CORS preflight
 *   registerExtra(router, ctx)     — WEB-004 (dashboard/history.mjs): /api/history,
 *                                    /api/status-md/:id, /api/preferences,
 *                                    /api/conversation/:prefix, /api/agent-events/:agentId.
 *                                    Wired into `main()` below (WEB-005 assembly point).
 *   createServer(router[, ctx])    → http server (JSON 404 fallback, JSON 500, static 404)
 *   main()                         — CLI entry: parse args, assemble registerCore +
 *                                    registerExtra, listen, poll + watch, graceful exit
 *
 * Handler signature is `(req, res, ctx) => void`; `ctx.params` is populated
 * for `:param` routes. `ctx` is assembled by `main()` and carries the data
 * dependencies WEB-004 needs: `stateRoot`, `tasksRoot`, `loadBatch`.
 *
 * Usage:
 *   node dashboard/server.mjs [--port 8100] [--root /path/to/repo] [--no-open]
 *
 * @module taskswarm/dashboard/server
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDashboardState } from './adapters.mjs'
import { readBatchState, latestBatch } from '../lib/core/status.js'
import { registerExtra } from './history.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const DEFAULT_PORT = 8100
const MAX_PORT_ATTEMPTS = 20
const POLL_INTERVAL = 2000 // ms between state checks (upstream constant)
const WATCH_DEBOUNCE_MS = 200 // ms debounce after an fs.watch event (upstream constant)

// ─── CLI Args ────────────────────────────────────────────────────────────────

const HELP_TEXT = `
TaskSwarm Dashboard — local HTTP server with SSE live updates

Usage:
  node dashboard/server.mjs [options]

Options:
  --port <number>   Port to listen on (default: ${DEFAULT_PORT})
  --root <path>     Project root containing .taskswarm/ and tasks/ (default: current directory)
  --no-open         Don't auto-open browser
  -h, --help        Show this help
`

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { port: DEFAULT_PORT, open: true, root: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      // Accept 0 (let the OS pick an ephemeral port); reject garbage/negatives.
      const parsed = parseInt(argv[i + 1], 10)
      opts.port = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT
      i++
    } else if (argv[i] === '--root' && argv[i + 1]) {
      opts.root = argv[i + 1]
      i++
    } else if (argv[i] === '--no-open') {
      opts.open = false
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(HELP_TEXT)
      process.exit(0)
    }
  }
  return opts
}

// ─── Route Registry ──────────────────────────────────────────────────────────

/**
 * Create a method+path → handler registry (the "route registry" contract).
 *
 * Registered routes are dispatched by `handle(req, res, ctx)` in priority
 * order: exact `METHOD /path` matches first, then `:param` patterns, then the
 * whole-path `*` wildcard (last). `handle` returns `true` when a handler ran
 * and `false` on no match — `createServer` owns the JSON 404 fallback.
 * For `:param` routes the collected params are exposed as `ctx.params`.
 *
 * @returns {{ on: Function, handle: Function }}
 */
export function createRouter() {
  const exact = new Map() // `${METHOD} ${pathname}` → handler
  const patterns = [] // { method, segs: string[], handler }
  const wildcards = new Map() // METHOD → whole-path `*` handler

  return {
    /**
     * Register a route. `path` is either an exact path (`/api/state`), a
     * pattern with `:param` segments (`/api/history/:batchId`), or the
     * whole-path wildcard `*`.
     * @param {string} method - HTTP method, e.g. 'GET'
     * @param {string} routePath - exact path, pattern, or '*'
     * @param {(req: http.IncomingMessage, res: http.ServerResponse, ctx: object) => void} handler
     */
    on(method, routePath, handler) {
      const key = method.toUpperCase()
      if (routePath === '*') {
        wildcards.set(key, handler)
      } else if (routePath.includes(':') || routePath.includes('*')) {
        patterns.push({ method: key, segs: splitPath(routePath), handler })
      } else {
        exact.set(`${key} ${routePath}`, handler)
      }
      return this // allow chaining
    },

    /**
     * Dispatch one request. Matches `new URL(req.url).pathname` exactly, then
     * patterns, then the wildcard. Returns true if a handler was invoked.
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @param {object} [ctx] - shared context (stateRoot/tasksRoot/loadBatch/...)
     * @returns {boolean} true when handled, false on no match
     */
    handle(req, res, ctx = {}) {
      const method = (req.method || 'GET').toUpperCase()
      let pathname
      try {
        pathname = new URL(req.url, 'http://localhost').pathname
      } catch {
        pathname = req.url || '/'
      }
      ctx.params = {}

      const exactHandler = exact.get(`${method} ${pathname}`)
      if (exactHandler) {
        exactHandler(req, res, ctx)
        return true
      }

      const segs = splitPath(pathname)
      for (const p of patterns) {
        if (p.method !== method || p.segs.length !== segs.length) continue
        const params = matchSegments(p.segs, segs)
        if (params) {
          ctx.params = params
          p.handler(req, res, ctx)
          return true
        }
      }

      const wildcard = wildcards.get(method)
      if (wildcard) {
        wildcard(req, res, ctx)
        return true
      }

      return false
    },
  }
}

/** Split a pathname into non-empty segments (`/a/b` → ['a', 'b']). */
function splitPath(pathname) {
  return String(pathname).split('/').filter(Boolean)
}

/**
 * Match `segs` against a registered pattern. A `:name` pattern segment matches
 * any single segment (captured into params), `*` matches any single segment
 * without capture. Returns params on success, null on mismatch.
 */
function matchSegments(pattern, segs) {
  const params = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]
    if (p === '*') continue
    if (p.startsWith(':')) params[p.slice(1)] = segs[i]
    else if (p !== segs[i]) return null
  }
  return params
}

// ─── State building (via WEB-002 adapters — never parse .taskswarm here) ─────────

/** Full dashboard state for the current batch (empty state when none exists). */
function buildState(ctx) {
  return buildDashboardState({
    stateRoot: ctx && ctx.stateRoot,
    tasksRoot: ctx && ctx.tasksRoot,
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

// ─── Static File Serving ────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

/** Serve files from `dashboard/public/` with a MIME table and traversal guard. */
function serveStatic(req, res) {
  let pathname
  try {
    pathname = new URL(req.url, 'http://localhost').pathname
  } catch {
    pathname = req.url || '/'
  }
  if (pathname === '/') pathname = '/index.html'

  // Resolve against PUBLIC_DIR, then verify containment. URL parsing already
  // normalizes '..' segments (incl. %2e forms); this guard is the second line
  // of defense for any raw-path fallback.
  const fullPath = path.resolve(PUBLIC_DIR, '.' + pathname)
  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' })
    return
  }

  const ext = path.extname(fullPath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  try {
    const content = fs.readFileSync(fullPath)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(content)
  } catch {
    sendJson(res, 404, { error: 'Not Found' })
  }
}

// ─── SSE Stream ──────────────────────────────────────────────────────────────

const sseClients = new Set() // live ServerResponse objects

/**
 * GET /api/stream — push the current state, then live updates.
 *
 * Sends one `data:` frame immediately (initial state), then every broadcast
 * (2s poll tick or fs.watch debounce). No heartbeat comments: upstream
 * TaskPlane sends none, and browsers treat a dropped connection as an error
 * and reconnect (app.js `connect()` retries every 3s) — keeping upstream
 * behavior consistent.
 */
function handleSSE(req, res, ctx) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
  // Initial state immediately on connect.
  res.write(`data: ${JSON.stringify(buildState(ctx))}\n\n`)

  sseClients.add(res)
  // Drop dead clients on close/error so broadcasts never write to a torn-down
  // response (and a flaky socket never crashes the process).
  req.on('close', () => sseClients.delete(res))
  res.on('error', () => sseClients.delete(res))
}

/** Push the current state to every connected SSE client (2s poll / fs.watch). */
function broadcastState(ctx) {
  if (sseClients.size === 0) return
  const payload = `data: ${JSON.stringify(buildState(ctx))}\n\n`
  for (const client of sseClients) {
    try {
      client.write(payload)
    } catch {
      sseClients.delete(client)
    }
  }
}

// ─── Core Routes ─────────────────────────────────────────────────────────────

/**
 * Register the WEB-003 core routes on `router`: SSE stream, one-shot state,
 * health, static files and the CORS preflight. Data dependencies (stateRoot /
 * tasksRoot / loadBatch) come from `ctx`, assembled by `main()`.
 *
 * @param {ReturnType<typeof createRouter>} router
 * @param {object} [ctx] - { stateRoot, tasksRoot, loadBatch, ... }
 */
export function registerCore(router, ctx = {}) {
  // CORS preflight — OPTIONS on any path (browser preflights POST /api/...).
  router.on('OPTIONS', '*', (req, res) => {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
  })

  // Live SSE stream — initial state + 2s poll + fs.watch instant push.
  router.on('GET', '/api/stream', (req, res, c) => handleSSE(req, res, c))

  // One-shot full state (dashboard boot fetch before SSE connects).
  router.on('GET', '/api/state', (req, res, c) => {
    sendJson(res, 200, buildState(c))
  })

  // Health check — `root` identifies which repo this dashboard serves, so
  // callers can detect an existing instance for the same workspace and must
  // never spawn a second one (one dashboard per repo, ever).
  router.on('GET', '/api/health', (req, res) => {
    sendJson(res, 200, { status: 'ok', root: ctx?.root ?? null, timestamp: Date.now() })
  })

  // Static files — catch-all GET, dispatched last by the router.
  router.on('GET', '*', serveStatic)
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

/**
 * Wrap a router in an http.Server. JSON 404 fallback for unmatched routes,
 * JSON 500 when a handler throws, JSON 404 for missing static files.
 *
 * @param {ReturnType<typeof createRouter>} router
 * @param {object} [ctx] - shared context forwarded to every handler
 * @returns {import('node:http').Server}
 */
export function createServer(router, ctx = {}) {
  return http.createServer((req, res) => {
    try {
      if (router.handle(req, res, ctx)) return
      sendJson(res, 404, { error: 'Not Found' })
    } catch (err) {
      try {
        sendJson(res, 500, {
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        })
      } catch {
        res.destroy() // headers already sent — force-close
      }
    }
  })
}

// ─── Browser Auto-Open ───────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? 'start'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open'
  exec(`${cmd} ${url}`, () => {}) // fire-and-forget
}

// ─── Port Discovery ──────────────────────────────────────────────────────────

/** Listen on `port`; resolves with the actual bound port, rejects on error. */
function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port)
  })
}

/**
 * Find an available port starting at `start`. Auto-scan tries up to
 * MAX_PORT_ATTEMPTS ports (+1 each on EADDRINUSE); an explicit `--port` tries
 * only that one and exits with an error when it is taken. Returns
 * `{ server, port }` — a fresh server is created per attempt so failed binds
 * never leave stale listeners behind.
 */
async function findPort(router, ctx, start, explicit) {
  if (explicit) {
    const server = createServer(router, ctx)
    try {
      const port = await tryListen(server, start)
      return { server, port }
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`\n  Port ${start} is already in use.`)
        console.error(`  Try: node dashboard/server.mjs --port ${start + 1}\n`)
        process.exit(1)
      }
      throw err
    }
  }
  for (let port = start; port < start + MAX_PORT_ATTEMPTS; port++) {
    const server = createServer(router, ctx)
    try {
      const bound = await tryListen(server, port)
      return { server, port: bound }
    } catch (err) {
      if (!err || err.code !== 'EADDRINUSE') throw err
      // Port taken — try the next one.
    }
  }
  console.error(`\n  No available port found in range ${start}-${start + MAX_PORT_ATTEMPTS - 1}.\n`)
  process.exit(1)
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * CLI entry. Assembles the router from `registerCore` + `registerExtra`,
 * resolves the project root (`--root` > cwd), listens on an available port,
 * then starts the 2s poll + `fs.watch` push and opens the browser unless
 * `--no-open`. SIGINT/SIGTERM clear timers, close SSE clients and the server.
 */
export async function main() {
  const opts = parseArgs()
  const root = path.resolve(opts.root || process.cwd())
  const stateRoot = path.join(root, '.taskswarm')
  const tasksRoot = path.join(root, 'tasks')

  // Data dependencies shared with WEB-004's registerExtra (history.mjs).
  const ctx = {
    root,
    stateRoot,
    tasksRoot,
    loadBatch: (batchId) => (batchId ? readBatchState(stateRoot, batchId) : latestBatch(stateRoot)),
  }

  const router = createRouter()
  registerCore(router, ctx)
  registerExtra(router, ctx) // WEB-004: /api/history, /api/status-md/:id, /api/preferences, …

  const explicitPort = process.argv.slice(2).includes('--port')
  const { server, port } = await findPort(router, ctx, opts.port, explicitPort)

  console.log(`\n  TaskSwarm Dashboard → http://localhost:${port}\n`)

  // Broadcast state to all SSE clients on interval (upstream POLL_INTERVAL).
  const pollTimer = setInterval(() => broadcastState(ctx), POLL_INTERVAL)

  // Also watch <stateRoot>/batches/ for instant push on any batch change.
  // taskswarm persists one BatchState JSON per batch in `batches/` (upstream
  // watched a single batch-state.json in .pi/) — any event triggers a
  // 200ms-debounced broadcast.
  let watcher = null
  let debounce = null
  try {
    const batchesDir = path.join(stateRoot, 'batches')
    if (fs.existsSync(batchesDir)) {
      watcher = fs.watch(batchesDir, () => {
        clearTimeout(debounce)
        debounce = setTimeout(() => broadcastState(ctx), WATCH_DEBOUNCE_MS)
      })
    }
  } catch {
    // fs.watch unsupported (rare) — the 2s poll still covers updates.
  }

  // Auto-open browser
  if (opts.open) {
    setTimeout(() => openBrowser(`http://localhost:${port}`), 500)
  }

  // Graceful shutdown
  function cleanup() {
    clearInterval(pollTimer)
    if (debounce) clearTimeout(debounce)
    if (watcher) {
      try { watcher.close() } catch { /* already closed */ }
    }
    for (const client of sseClients) {
      try { client.end() } catch { /* already closed */ }
    }
    server.close()
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

// CLI entry — run main() only when executed directly (not when imported by specs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
