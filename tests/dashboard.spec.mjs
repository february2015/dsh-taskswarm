/**
 * DashboardManager 单实例语义测试 —— 核心约束：同一工作区（repoRoot）同时
 * 只能有一个 dashboard 在跑。
 *
 * 覆盖：
 *  - ensure() 幂等：同 repo 重复 ensure 复用同一 URL，不重复拉起；
 *  - 外部已运行的 dashboard（手动 spawn 的 server）会被探测到并复用，不新起；
 *  - 不同 repo 各一个实例（多仓库多实例是允许的），端口自动避让；
 *  - stop() 只停自己管理的实例；停掉后可重新 ensure。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DashboardManager } from '../lib/orchestrator/dashboard.js'

const SERVER_PATH = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url))

function tmpRepo(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 等 server 打印 URL（TaskSwarm Dashboard → http://localhost:<port>）。 */
function waitForUrl(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`server did not report URL in ${timeoutMs}ms (out: ${out})`)), timeoutMs)
    const onData = (buf) => {
      out += buf.toString()
      const m = out.match(/http:\/\/localhost:\d+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    }
    child.stdout?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited early (code ${code}, out: ${out})`))
    })
  })
}

/** 启动一个外部 dashboard server（不走 DashboardManager，模拟手动/残留实例）。 */
function spawnExternal(root) {
  // 不传 --port：让 server 自动避让落在 8100+ 范围内，便于 findExternal 探测到。
  const child = spawn(process.execPath, [SERVER_PATH, '--root', root, '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return child
}

async function fetchHealth(url) {
  const port = url.match(/:(\d+)$/)?.[1]
  // 双 loopback 探测（127.0.0.1 IPv4 / [::1] IPv6），兼容 server 只绑其中一族。
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return res.json()
    } catch {
      // try next host
    }
  }
  return null
}

test('ensure 幂等：同 repo 重复 ensure 复用同一 URL，只有一个实例', async (t) => {
  const repo = tmpRepo('taskswarm-dash-idem-')
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const m = new DashboardManager()
  t.after(() => m.disposeAll())

  const a = await m.ensure(repo)
  assert.equal(a.ok, true)
  assert.ok(a.url)
  const b = await m.ensure(repo)
  assert.equal(b.ok, true)
  assert.equal(b.url, a.url, '重复 ensure 必须复用同一 URL，不得再起一个')

  // 只有一个实例在跑：status running 且 health 指向该 repo
  const s = m.status(repo)
  assert.equal(s.running, true)
  assert.equal(s.url, a.url)
  const health = await fetchHealth(a.url)
  assert.equal(health?.root, repo)
})

test('外部已运行的 dashboard 会被探测复用，不新起实例', async (t) => {
  const repo = tmpRepo('taskswarm-dash-ext-')
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const child = spawnExternal(repo)
  t.after(() => {
    try {
      child.kill()
    } catch {
      // already dead
    }
  })
  const externalUrl = await waitForUrl(child)
  t.after(() => child.stdout?.destroy())

  const m = new DashboardManager()
  const r = await m.ensure(repo)
  assert.equal(r.ok, true)
  assert.equal(r.url, externalUrl, '必须复用外部实例的 URL，而不是新起一个')

  // 关键：manager 没有 spawn 新实例（stop 无跟踪实例可停）
  const stopped = m.stop(repo)
  assert.equal(stopped.text, 'Dashboard 未启动。')
  // 外部实例仍然活着
  const health = await fetchHealth(externalUrl)
  assert.equal(health?.root, repo)
})

test('不同 repo 各一个实例，端口自动避让', async (t) => {
  const repoA = tmpRepo('taskswarm-dash-a-')
  const repoB = tmpRepo('taskswarm-dash-b-')
  t.after(() => {
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
  })
  const m = new DashboardManager()
  t.after(() => m.disposeAll())

  const a = await m.ensure(repoA)
  const b = await m.ensure(repoB)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.url, b.url, '两个 repo 必须各自独立实例')

  assert.equal((await fetchHealth(a.url))?.root, repoA)
  assert.equal((await fetchHealth(b.url))?.root, repoB)
})

test('stop 后同一 repo 可重新 ensure（单实例语义不破坏）', async (t) => {
  const repo = tmpRepo('taskswarm-dash-stop-')
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const m = new DashboardManager()
  t.after(() => m.disposeAll())

  const a = await m.ensure(repo)
  assert.equal(a.ok, true)
  const stopped = m.stop(repo)
  assert.equal(stopped.ok, true)
  assert.equal(m.status(repo).running, false)

  const b = await m.ensure(repo)
  assert.equal(b.ok, true)
  assert.ok(b.url)
  assert.equal(m.status(repo).running, true)
})
