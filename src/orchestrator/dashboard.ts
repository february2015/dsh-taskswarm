/**
 * TaskSwarm Dashboard lifecycle — one shared registry of dashboard server
 * processes, keyed by repoRoot.
 *
 * The supervisor tool (`tswarm_dashboard`), the `/taskswarm-dashboard` command and
 * the auto-start-on-batch logic all go through this manager, so "one
 * dashboard per repo" holds no matter which entry point ran first. The server
 * itself (`dashboard/server.mjs`) auto-avoids occupied ports (bumps 8100+
 * unless an explicit `--port` is given).
 * @module taskswarm/orchestrator/dashboard
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DASHBOARD_SERVER_PATH = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url))
const START_TIMEOUT_MS = 15_000
/** 探测外部已运行 dashboard 的端口范围：与 server.mjs 的 MAX_PORT_ATTEMPTS 对齐。 */
const PROBE_FROM = 8100
const PROBE_RANGE = 20
const PROBE_TIMEOUT_MS = 400

export interface DashboardResult {
  ok: boolean
  url?: string
  text?: string
}

interface DashboardHandle {
  proc: ChildProcess
  url: string
}

export class DashboardManager {
  private readonly servers = new Map<string, DashboardHandle>()

  /** Whether a live dashboard is tracked for the repo (stale handles dropped). */
  status(repoRoot: string): { running: boolean; url?: string } {
    const h = this.servers.get(repoRoot)
    if (h && h.proc.exitCode === null) return { running: true, url: h.url }
    if (h) this.servers.delete(repoRoot)
    return { running: false }
  }

  /**
   * Idempotent start — 同工作区单实例保证：
   * 1. 本 manager 已跟踪的运行中实例 → 复用；
   * 2. 扫描端口找「已在服务同一 repoRoot」的 dashboard（外部手动启动 / 残留
   *    孤儿进程），命中则复用其 URL，绝不重复拉起；
   * 3. 都没有 → spawn `dashboard/server.mjs --root <repo> --no-open`。
   * `port` 可选 —— 不传时 server 自动避让到空闲端口；显式传入也会一并探测。
   */
  async ensure(repoRoot: string, port?: number): Promise<DashboardResult> {
    const known = this.status(repoRoot)
    if (known.running) return { ok: true, url: known.url }
    const external = await this.findExternal(repoRoot, port)
    if (external) return { ok: true, url: external }
    if (!existsSync(DASHBOARD_SERVER_PATH)) {
      return { ok: false, text: `未找到 dashboard server：${DASHBOARD_SERVER_PATH}（先 build / integrate）` }
    }
    const args = [DASHBOARD_SERVER_PATH, '--root', repoRoot, '--no-open']
    if (port !== undefined && Number.isFinite(port) && port >= 0) args.push('--port', String(port))
    const proc = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let url: string
    try {
      url = await this.waitForUrl(proc)
    } catch (e) {
      // 启动失败（端口冲突/超时/提前退出）以 ok:false 返回，绝不 throw ——
      // 调用方（/tswarm 命令、start 工具）需要在失败时仍正常返回消息。
      try {
        proc.kill()
      } catch {
        // already dead
      }
      return { ok: false, text: e instanceof Error ? e.message : String(e) }
    }
    // 排空 stdout/stderr，避免管道背压卡住子进程
    proc.stdout?.resume()
    proc.stderr?.resume()
    this.servers.set(repoRoot, { proc, url })
    return { ok: true, url }
  }

  /** Stop the dashboard for a repo (no-op when not running). */
  stop(repoRoot: string): { ok: boolean; text: string } {
    const h = this.servers.get(repoRoot)
    if (!h) return { ok: true, text: 'Dashboard 未启动。' }
    try {
      h.proc.kill()
    } catch {
      // already dead
    }
    this.servers.delete(repoRoot)
    return { ok: true, text: `已停止 ${h.url}` }
  }

  /** Kill every tracked dashboard (plugin unload / process shutdown). */
  disposeAll(): void {
    for (const h of this.servers.values()) {
      try {
        h.proc.kill()
      } catch {
        // already dead
      }
    }
    this.servers.clear()
  }

  /**
   * 扫描默认端口范围（+ 显式 port），找已在服务同一 repo 的 dashboard。
   * server 的 /api/health 返回其 `root`，据此精确匹配，避免误认其他 repo
   * 或无关服务的端口。每个端口同时探测 localhost（IPv6 ::1）与 127.0.0.1
   * （IPv4），兼容 server 只绑到其中一族的情况。
   */
  private async findExternal(repoRoot: string, extraPort?: number): Promise<string | null> {
    const target = resolve(repoRoot)
    const ports = new Set<number>()
    for (let i = 0; i < PROBE_RANGE; i++) ports.add(PROBE_FROM + i)
    if (extraPort !== undefined && Number.isFinite(extraPort) && extraPort >= 0) ports.add(extraPort)
    const probes = [...ports].flatMap((port) => ['127.0.0.1', '[::1]'].map(async (host) => {
      try {
        const res = await fetch(`http://${host}:${port}/api/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        if (!res.ok) return null
        const body = (await res.json()) as { root?: unknown } | null
        if (body && typeof body.root === 'string' && resolve(body.root) === target) {
          return `http://localhost:${port}`
        }
      } catch {
        // 端口无服务 / 超时 / 非本仓库：跳过
      }
      return null
    }))
    return (await Promise.all(probes)).find((r): r is string => r !== null) ?? null
  }

  /** Wait for `TaskSwarm Dashboard → http://localhost:<port>` on stdout. */
  private waitForUrl(proc: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = ''
      let settled = false
      const finish = (err: Error | null, url?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.stdout?.off('data', onData)
        proc.stderr?.off('data', onErr)
        proc.off('exit', onExit)
        if (err) reject(err)
        else resolve(url as string)
      }
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          // ignore
        }
        finish(new Error('dashboard 启动超时（15s 内未输出 URL）'))
      }, START_TIMEOUT_MS)
      const onData = (buf: Buffer): void => {
        out += buf.toString()
        const m = out.match(/http:\/\/localhost:\d+/)
        if (m) finish(null, m[0])
      }
      const onErr = (buf: Buffer): void => {
        out += buf.toString()
      }
      const onExit = (code: number | null): void => {
        finish(new Error(out.includes('already in use')
          ? `port already in use (dashboard server exited, code ${String(code)})`
          : `dashboard 进程退出（code ${String(code)}）`))
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onErr)
      proc.on('exit', onExit)
    })
  }
}

