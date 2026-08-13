/**
 * Conversational supervisor — ported from TaskPlane
 * `extensions/taskplane/supervisor.ts` (github.com/HenryLach/taskplane, MIT).
 *
 * TaskPlane's supervisor shares the operator's session: after `/orch` it
 * activates to monitor the batch, reports significant events, classifies
 * every recovery action (diagnostic / tier0_known / destructive), and asks
 * the operator before destructive actions unless autonomy allows otherwise.
 *
 * DSH adaptation: the operator's session agent IS the supervisor. The
 * orchestrator registers a supervisor persona section + two tools
 * (`buju_supervisor_status` diagnostic, `buju_supervisor_control` actions) on
 * the invoking session agent, and wakes it with a `[Buju supervisor]` event
 * report whenever the engine emits a decision-worthy lifecycle event. The
 * agent then inspects state (read/status tools), classifies its next action,
 * and either acts or asks the operator — per {@link requiresConfirmation}.
 *
 * Ported verbatim: {@link requiresConfirmation}, {@link ACTION_CLASSIFICATION_EXAMPLES},
 * the supervisor prompt structure (Identity / Context / Capabilities /
 * Standing Orders / Classification / Autonomy). Rewritten for DSH: event
 * contract (engine onEvent), tools, `.buju` state paths.
 *
 * Deferred from the full port (supervisor.ts ~4.7k lines): audit-trail JSONL,
 * branch-protection detection, CI/PR lifecycle, rich batch-summary markdown.
 * @module buju/orchestrator/supervisor
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { BujuEvent, BujuEngine } from './engine.ts'
import { formatBatchStatus, type BatchState } from '../core/status.ts'
import { formatWavePlan } from '../core/discover.ts'
import { messages, detectLocaleFromSession, type Locale, type LocaleState } from './i18n.ts'
import { writeSetting, removeSetting, repoConfigPath } from './settings.ts'

/**
 * 粗估批次剩余时长。基于已完成 lane 的平均耗时 × 剩余 lane 数 ÷ 当前并行度。
 * 无已完成 lane 时返回"估算中"。纯启发式，供 supervisor 汇报 ETA 用。
 * 文案随 locale 双语。
 */
export function estimateEta(state: BatchState, locale: Locale): string {
  const m = messages(locale)
  const done = state.lanes.filter((l) => l.phase === 'merged' || l.phase === 'failed' || l.phase === 'skipped')
  const remaining = state.lanes.filter((l) => l.phase === 'pending' || l.phase === 'running' || l.phase === 'review')
  if (remaining.length === 0) return m.etaDone
  const durations = done
    .map((l) => (l.endedAt && l.startedAt ? Date.parse(l.endedAt) - Date.parse(l.startedAt) : NaN))
    .filter((d) => Number.isFinite(d) && d > 0)
  if (durations.length === 0) return m.etaEstimating
  const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length
  const parallel = Math.max(1, state.lanes.filter((l) => l.phase === 'running').length)
  const etaMs = (remaining.length * avgMs) / parallel
  const mins = Math.max(1, Math.round(etaMs / 60_000))
  const avgSec = Math.round(avgMs / 1000)
  const base = durations.length === 1 ? m.etaBaseOne(avgSec) : m.etaBaseMany(durations.length, avgSec)
  return m.etaFmt(mins, base, avgSec, remaining.length, parallel)
}

/** Supervisor autonomy levels (ported from TaskPlane `SupervisorAutonomyLevel`). */
export type SupervisorAutonomyLevel = 'interactive' | 'supervised' | 'autonomous'
/** Plugin-level toggle: 'off' disables the supervisor entirely. */
export type SupervisorMode = 'off' | SupervisorAutonomyLevel

/** Recovery action classification (ported from TaskPlane). */
export type RecoveryActionClassification = 'diagnostic' | 'tier0_known' | 'destructive'

export interface SupervisorEngineRef {
  engine: BujuEngine
  repoRoot: string
  tasksRoot: string
  stateRoot: string
  /** 会话语言状态（可变；supervisor 工具可文字切换并持久化到 config.json）。 */
  locale: LocaleState
}

/**
 * Whether an action of the given classification needs operator confirmation
 * under the given autonomy level. Ported verbatim from TaskPlane
 * `requiresConfirmation` (supervisor.ts:102).
 * - diagnostics never require confirmation
 * - autonomous never asks
 * - interactive asks for everything non-diagnostic
 * - supervised auto-acts on tier0_known, asks for destructive
 */
export function requiresConfirmation(classification: RecoveryActionClassification, autonomy: SupervisorAutonomyLevel): boolean {
  if (classification === 'diagnostic') return false
  if (autonomy === 'autonomous') return false
  if (autonomy === 'interactive') return true
  return classification === 'destructive'
}

/**
 * Example actions per classification, used by the system prompt to guide the
 * supervisor. Ported from TaskPlane `ACTION_CLASSIFICATION_EXAMPLES`
 * (supervisor.ts:127), paths/tools adapted to DSH/Buju.
 */
export const ACTION_CLASSIFICATION_EXAMPLES: Readonly<Record<RecoveryActionClassification, readonly string[]>> = {
  diagnostic: [
    'Reading .buju/batches/*.json, tasks/*/STATUS.md, lane logs',
    'Running git status / git log / git diff / git worktree list',
    'Running test suites (npm test / node --test)',
    'Inspecting lanes and worktrees (buju_supervisor_status)',
    'Reading any file for diagnostics',
  ],
  tier0_known: [
    'Retrying a failed or timed-out merge',
    'Resuming a paused batch (buju_supervisor_control resume)',
    'Pausing after the current wave (buju_supervisor_control pause)',
    'Clearing a git lock file (.git/index.lock)',
    'Cleaning up stale worktrees before a retry',
  ],
  destructive: [
    'Aborting the batch (buju_supervisor_control abort)',
    'Merging buju/orch into the working branch (buju_supervisor_control integrate)',
    'Running git reset / git checkout -B / git branch -D',
    'Removing worktrees (git worktree remove)',
    'Modifying STATUS.md / .DONE / batch-state files',
    'Skipping tasks or waves',
  ],
}

function autonomyDescription(autonomy: SupervisorAutonomyLevel): string {
  switch (autonomy) {
    case 'interactive':
      return 'Interactive: you must ask the operator before any non-diagnostic action (including resume/pause); only pure diagnostics run automatically.'
    case 'autonomous':
      return 'Autonomous: act on your own for every classification; after acting, report what you did and why.'
    default:
      return 'Supervised: diagnostics and tier0_known recovery run automatically; destructive actions (abort, integrate, branch/worktree mutations) require a one-line confirmation from the operator first.'
  }
}

/** 自主度一句话规则（供精简提示词复用）。双语。 */
export function autonomyRule(autonomy: SupervisorAutonomyLevel, locale: Locale): string {
  if (locale === 'en') {
    switch (autonomy) {
      case 'interactive':
        return 'ask the operator before any non-diagnostic action.'
      case 'autonomous':
        return 'act on all actions yourself; report in one sentence afterwards.'
      default:
        return 'tier0_known runs automatically; destructive actions require a one-line confirmation from the operator first.'
    }
  }
  switch (autonomy) {
    case 'interactive':
      return '非 diagnostic 动作一律先征求确认。'
    case 'autonomous':
      return '所有动作自主执行，事后一句话汇报。'
    default:
      return 'tier0_known 自动执行；destructive 先征求一句确认。'
  }
}

/**
 * Supervisor system prompt — 精简版（结构源自 TaskPlane supervisor.ts:2335，
 * 已大幅压缩以降低每次唤醒的 token 成本）。批上下文在注册时填充；
 * 唤醒消息携带更新状态。文案随 locale 双语。
 */
export function buildSupervisorSystemPrompt(
  autonomy: SupervisorAutonomyLevel,
  context: { batchId?: string; phase?: string; progress?: string; stateRoot?: string },
  locale: Locale = 'zh-CN',
): string {
  const ctx = [
    `- **Batch:** ${context.batchId ?? '—'} | **Phase:** ${context.phase ?? 'idle'}`,
    context.progress ? `- **Progress:** ${context.progress}` : '',
    `- **State root:** ${context.stateRoot ?? '.buju/'}`,
  ].filter(Boolean).join('\n')
  if (locale === 'en') {
    return `# Buju Supervisor

You are the batch supervisor, sharing this session with the operator (activated after /buju starts a batch). On a [Buju supervisor] event:
1. Verify state with buju_supervisor_status;
2. Classify actions: diagnostic (read-only checks, always allowed) / tier0_known (resume, pause, clearing locks, known recoveries) / destructive (abort, integrate, state changes);
3. Act per autonomy: ${autonomyRule(autonomy, 'en')}
4. For routine notices (wave complete / periodic report / stall without anomaly) reply in ≤2 sentences with no extra checks or lists; only expand into verification and handling on failure / REVISE / batch completion / a confirmed stall.
5. Standard procedures for cleanup / error recovery / work salvage are in the repo's docs/runbook.md — read it before handling.

${ctx}

Normal user conversation is unaffected.`
  }
  return `# Buju Supervisor

你是 batch supervisor，与 operator 共享此会话（/buju 启动批次后激活）。收到 [Buju supervisor] 事件后：
1. 用 buju_supervisor_status 查证状态；
2. 分类动作：diagnostic（只读查证，永远可做）/ tier0_known（resume、pause、清锁等已知恢复）/ destructive（abort、integrate、改状态）；
3. 按自主度执行：${autonomyRule(autonomy, 'zh-CN')}
4. 常规提醒（wave 完成 / 定时汇报 / 卡住无异常）回复 ≤2 句，不做额外查证不列表；仅失败 / REVISE / batch 完成 / 确认真卡住才展开查证处理。
5. 清理残留 / 错误恢复 / 工作抢救的标准步骤见仓库 docs/runbook.zh-CN.md，处理前先读它。

${ctx}

普通用户对话不受影响。`
}

/** Events that wake the supervisor agent. `lane-done` stays informational. */
export function shouldWake(event: BujuEvent): boolean {
  return event.type !== 'lane-done'
}

/** One-line event headline, shown first in the wake message. 双语。 */
export function eventHeadline(event: BujuEvent, locale: Locale): string {
  const m = messages(locale)
  switch (event.type) {
    case 'batch-started':
      return m.batchStarted(event.batchId, event.total ?? 0)
    case 'lane-failed':
      return m.laneFailed(event.lane ?? 0, event.taskId ?? '', event.error)
    case 'lane-revise':
      return m.laneRevise(event.lane ?? 0, event.taskId ?? '')
    case 'wave-complete':
      return m.waveComplete(event.waveIndex ?? 0, event.totalWaves ?? 0, event.merged ?? 0, event.failed ?? 0)
    case 'batch-complete':
      return m.batchComplete(event.batchId, event.merged ?? 0, event.total ?? 0, event.failed ?? 0)
    case 'batch-aborted':
      return m.batchAborted(event.batchId)
    default:
      return `[Buju supervisor] ${String(event.type)}`
  }
}

/** Wake message handed to the session agent（指引已由系统提示承载；状态用精简渲染+ETA）。 */
export function supervisorEventReport(event: BujuEvent, state: BatchState | null, locale: Locale): string {
  const m = messages(locale)
  return [
    eventHeadline(event, locale),
    '',
    state ? compactBatchStatus(state) : m.noBatchState,
    state ? `\n${m.etaLabel}${estimateEta(state, locale)}` : '',
  ].join('\n')
}

/** 精简版批次状态（supervisor 消息用）：batch id + phase + lane 列表，去掉完整时间戳/scope 冗余。 */
export function compactBatchStatus(state: BatchState): string {
  const done = state.lanes.filter((l) => l.phase === 'merged' || l.phase === 'failed' || l.phase === 'skipped').length
  const lines = [`Batch ${state.id} — ${state.phase} (${done}/${state.lanes.length} lanes done)`]
  for (const l of state.lanes) {
    lines.push(`  lane ${l.lane} [${l.phase}] ${l.taskId}`)
  }
  return lines.join('\n')
}

/**
 * Register the supervisor persona + tools on a live session agent context.
 * Safe to call once per engine (the orchestrator guards by repo).
 */
export function registerSupervisor(
  agentCtx: Context,
  getRef: () => SupervisorEngineRef | { error: string } | undefined,
  autonomy: SupervisorAutonomyLevel,
  periodic?: PeriodicControl,
): void {
  // ── supervisor 提示词段：可热替换（dispose 旧段后按当前语言重注册）──
  let systemPromptService: { section?(opts: { name: string; order: number; text: string }): (() => void) | undefined } | undefined
  try {
    systemPromptService = agentCtx.get('systemPrompt') as typeof systemPromptService
  } catch {
    // non-fatal
  }
  let disposePrompt: (() => void) | undefined
  const registerPrompt = (promptLocale: Locale): void => {
    try {
      disposePrompt?.()
      disposePrompt = systemPromptService?.section?.({
        name: 'buju:supervisor',
        order: 90,
        text: buildSupervisorSystemPrompt(autonomy, {}, promptLocale),
      }) ?? undefined
    } catch {
      disposePrompt = undefined
    }
  }
  const ref = getRef()
  registerPrompt(ref && 'locale' in ref ? (ref as SupervisorEngineRef).locale.value : 'zh-CN')
  const tools = agentCtx.get('tools') as { register(def: unknown): unknown } | undefined
  if (!tools) return
  const register = (def: unknown): void => {
    try {
      tools.register(def)
    } catch {
      // duplicate/incompatible registration must not break the session
    }
  }
  const refOf = (): SupervisorEngineRef | { error: string } | undefined => getRef()
  const uninitialized = { ok: false, text: 'Buju 引擎未初始化（先运行 /orch）' } as const
  // 注册该工具的会话 agent：作为 batch owner，让事件只回发到本会话（避免跨会话串消息）。
  const toolOwner = (agentCtx as unknown as { agent?: unknown }).agent
  const toolSessionId = (agentCtx as unknown as { agent?: { session?: { id?: string } } }).agent?.session?.id

  register(defineTool({
    name: 'buju_supervisor_status',
    description: 'Buju supervisor：查看当前 batch / lane 状态（.buju 状态 + buju/orch 分支）。诊断类动作，无需确认。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const state = ref.engine.status()
      return { ok: true, text: state ? formatBatchStatus(state) : 'No Buju batch yet.' }
    },
  }))

  register(defineTool({
    name: 'buju_supervisor_control',
    description: 'Buju supervisor 控制。动作分类：status=diagnostic；resume/pause=tier0_known；integrate/abort=destructive（按自主度可能需先征求 operator 确认）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'plan', 'start', 'integrate', 'resume', 'pause', 'abort'],
        description: '要执行的控制动作（plan=展示波次计划；start 用 scope 指定任务，如 WEB-006 / all；空项目会自动初始化示例任务）。',
      },
      scope: { type: 'string', description: 'start 动作的任务 scope（任务 ID / all / 路径），默认 all。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const { engine } = ref
      const action = args.action as string
      switch (action) {
        case 'status': {
          const s = engine.status()
          return { ok: true, text: s ? formatBatchStatus(s) : 'No Buju batch yet.' }
        }
        case 'plan': {
          const scope = (args.scope as string | undefined)?.trim() || 'all'
          const { waves, count } = engine.plan(scope)
          return {
            ok: true,
            text: count === 0
              ? `No tasks found under ${ref.tasksRoot}. 说需求让我先分析并生成任务包，或 start 会自动初始化示例任务。`
              : `${count} 个任务 / ${waves.waves.length} 个波次：\n${formatWavePlan(waves)}`,
          }
        }
        case 'start': {
          const running = engine.status()
          if (running && (running.phase === 'running' || running.phase === 'planning')) {
            return { ok: false, text: `批次 ${running.id} 正在运行，先等它结束或 abort 再启动新批次。` }
          }
          const scope = (args.scope as string | undefined)?.trim() || 'all'
          try {
            const handle = engine.run(scope, toolOwner)
            return { ok: true, text: `Batch ${handle.batchId} started (scope: ${scope})。` }
          } catch (e) {
            return { ok: false, text: e instanceof Error ? e.message : String(e) }
          }
        }
        case 'integrate': {
          const r = engine.integrate()
          return { ok: r.ok, text: r.ok ? `Integrated: ${r.message}` : `Integration failed: ${r.message}` }
        }
        case 'resume': {
          const ok = engine.resume()
          return { ok, text: ok ? 'Batch resumed.' : 'No paused batch to resume.' }
        }
        case 'pause': {
          const ok = engine.pause()
          return { ok, text: ok ? 'Batch will pause after the current wave.' : 'No running batch to pause.' }
        }
        case 'abort': {
          const ok = engine.abort()
          return { ok, text: ok ? 'Batch abort requested.' : 'No running batch to abort.' }
        }
        default:
          return { ok: false, text: `Unknown action: ${action}` }
      }
    },
  }))

  // ── buju_supervisor_locale：文字切换 supervisor 语言（写入 .buju/config.json）──
  register(defineTool({
    name: 'buju_supervisor_locale',
    description: 'Buju supervisor 语言：查询/切换 supervisor 通知与提示词语言（zh-CN / en / auto 按会话自动检测）。operator 说"用英文汇报"/"用中文"等时调用；设置写入 .buju/config.json 持久化。',
    parameters: {
      locale: {
        type: 'string',
        enum: ['zh-CN', 'en', 'auto'],
        description: '目标语言：zh-CN 中文 / en 英文 / auto 恢复为按会话语言自动检测。不传 = 查询当前。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const m = messages(ref.locale.value)
      const target = args.locale as 'zh-CN' | 'en' | 'auto' | undefined
      if (!target) {
        return { ok: true, text: m.localeCurrent(ref.locale.value) }
      }
      const resolved: Locale = target === 'auto'
        ? detectLocaleFromSession(agentCtx.get('sessions'), toolSessionId)
        : target
      ref.locale.value = resolved
      if (target === 'auto') {
        removeSetting(ref.stateRoot, 'locale')
      } else {
        writeSetting(ref.stateRoot, 'locale', resolved)
      }
      registerPrompt(resolved)
      return { ok: true, text: messages(resolved).localeSwitchedTo(resolved, repoConfigPath(ref.stateRoot)) }
    },
  }))

  if (periodic) {
    register(defineTool({
      name: 'buju_supervisor_report_interval',
      description: 'Buju supervisor 定时汇报：设置每隔 N 分钟汇报一次批次进度（minutes=0 关闭）。operator 要求"每隔 X 分钟汇报一次"时调用；不传参数则查询当前设置。设置写入 .buju/config.json 持久化。',
      parameters: {
        minutes: { type: 'integer', description: '汇报间隔（分钟）。0 = 关闭定时汇报；不传 = 查询当前设置。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const ref = refOf()
        if (!ref || 'error' in ref) return uninitialized
        if (args.minutes === undefined) {
          return { ok: true, text: `当前定时汇报间隔：${periodic.getReportInterval()} 分钟（0 = 关闭）` }
        }
        const minutes = args.minutes as number
        const text = periodic.setReportInterval(minutes)
        // 持久化到仓库配置：跨重启生效（0 时移除键，回到默认关闭）
        if (minutes === 0) removeSetting(ref.stateRoot, 'reportIntervalMinutes')
        else writeSetting(ref.stateRoot, 'reportIntervalMinutes', minutes)
        return { ok: true, text: text }
      },
    }))
  }

  // ── buju_dashboard：文字指令启动 Web Dashboard（自动探测空闲端口）──
  const dashboards = new Map<string, { proc: ChildProcess; url: string }>()
  const dashboardServerPath = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url))
  register(defineTool({
    name: 'buju_dashboard',
    description: 'Buju Web Dashboard 管理：start（为当前仓库启动本地 dashboard server，自动探测空闲端口）/ status / stop。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'status', 'stop'],
        description: '操作：start 启动 / status 查询 / stop 停止。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const repoRoot = ref.repoRoot
      const action = args.action as string
      if (action === 'status') {
        const d = dashboards.get(repoRoot)
        return { ok: true, text: d ? `Dashboard 运行中：${d.url}` : 'Dashboard 未启动（用 start 启动）。' }
      }
      if (action === 'stop') {
        const d = dashboards.get(repoRoot)
        if (!d) return { ok: true, text: 'Dashboard 未启动。' }
        try {
          d.proc.kill()
        } catch {
          // already dead
        }
        dashboards.delete(repoRoot)
        return { ok: true, text: `已停止 ${d.url}` }
      }
      // start
      const existing = dashboards.get(repoRoot)
      if (existing) return { ok: true, text: `Dashboard 已在运行：${existing.url}` }
      if (!existsSync(dashboardServerPath)) {
        return { ok: false, text: `未找到 ${dashboardServerPath}——dashboard server 产物（WEB-003）尚未并入工作分支，先完成 integrate。` }
      }
      const proc = spawn(process.execPath, [dashboardServerPath, '--root', repoRoot, '--no-open'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {
            // ignore
          }
          reject(new Error('dashboard 启动超时（15s 内未输出 URL）'))
        }, 15_000)
        const onData = (buf: Buffer): void => {
          const m = buf.toString().match(/http:\/\/localhost:\d+/)
          if (m) {
            clearTimeout(timer)
            resolve(m[0])
          }
        }
        proc.stdout?.on('data', onData)
        proc.on('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`dashboard 进程退出（code ${String(code)}）`))
        })
      })
      dashboards.set(repoRoot, { proc, url })
      return { ok: true, text: `Dashboard 已启动：${url}（浏览器打开即可；stop 可停止）` }
    },
  }))
}

export interface PeriodicSupervisionOptions {
  /** 状态检查间隔（毫秒）。检查本身零成本（只读状态），默认 60s。 */
  checkIntervalMs?: number
  /** 距上次 lane 状态变化超过该时长仍无动静 → 唤醒一次"疑似卡住"提醒（默认 4 分钟）。 */
  stalledThresholdMs?: number
  /** 初始定时汇报间隔（分钟），来自 .buju/config.json 的持久化设置（默认 0 = 关）。 */
  initialReportIntervalMinutes?: number
}

export interface PeriodicControl {
  /** 设置定时进度汇报间隔（分钟）。0 = 关闭（默认）。返回给用户的确认文本。 */
  setReportInterval(minutes: number): string
  /** 当前定时汇报间隔（分钟），0 = 关闭。 */
  getReportInterval(): number
  /** 停止定时器。 */
  dispose(): void
}

/**
 * 定时检查/汇报（常驻）。
 *
 * **定时检查（总是开启）**：周期性读 batch 状态（零成本）。只做**卡住检测**——
 * 批次运行中距上次 lane 变化超过 `stalledThresholdMs` 仍无动静 → 唤醒一次
 * "疑似卡住"提醒（限一次，直到再次出现变化）。不做"有变化即汇报"。
 *
 * **定时汇报（默认关闭）**：通过 {@link PeriodicControl.setReportInterval} 设置
 * 间隔（分钟）后，每满一个间隔唤醒一次，汇报当前批次进度。默认 0（关），
 * 由 operator 要求时开启（"每隔 15 分钟汇报一次"）。
 *
 * batch 结束后自动重置，等待下一个 batch。进程级常驻定时器（cordis timer mixin
 * 无类型声明，用原生实现）。
 */
/**
 * 最近一次 worker 会话日志活动（毫秒时间戳）。把 lane worktree 绝对路径换算成
 * DSH 会话存储目录名（`/` → `-`，前后加 `--`，如
 * `--Users-robin-myProject-dsh-buju-.buju-worktrees-web-003--`），取其中
 * 会话子目录（前缀 `session-`）里 `session.jsonl(.zstd)` 的最新 mtime。找不到返回 0。
 */
export function latestSessionActivity(worktree: string): number {
  const dirName = `--${worktree.replace(/\//g, '-')}--`
  const sessionsRoot = join(homedir(), '.dsh', 'sessions')
  const dir = join(sessionsRoot, dirName)
  let latest = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let files: string[] = []
    try {
      files = readdirSync(full).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        latest = Math.max(latest, statSync(join(full, f)).mtimeMs)
      } catch {
        // ignore unreadable files
      }
    }
  }
  return latest
}

export function startPeriodicSupervision(
  getRef: () => SupervisorEngineRef | { error: string } | undefined,
  wake: (text: string) => void,
  options: PeriodicSupervisionOptions = {},
): PeriodicControl {
  const checkIntervalMs = options.checkIntervalMs ?? 60_000
  const stalledThresholdMs = options.stalledThresholdMs ?? 240_000
  // 定时汇报默认关闭；可用 settings 里的 reportIntervalMinutes 初始化为持久值
  const initialMinutes = options.initialReportIntervalMinutes ?? 0
  let reportIntervalMs = Math.round(initialMinutes * 60_000)
  let lastSnapshot = ''
  let lastChangeAt = 0
  let lastReportAt = initialMinutes > 0 ? Date.now() : 0
  let stalledWarned = false

  /** 当前 locale（引擎 ref 上的可变状态；工具切换后即时生效）。 */
  const refLocale = (): Locale => {
    const ref = getRef()
    return ref && 'locale' in ref ? (ref as SupervisorEngineRef).locale.value : 'zh-CN'
  }

  const check = (): void => {
    const ref = getRef()
    if (!ref || 'error' in ref) return
    const m = messages(refLocale())
    const state = ref.engine.status()
    if (!state) return
    if (state.phase !== 'running' && state.phase !== 'planning' && state.phase !== 'paused') {
      // batch 结束：重置，等待下一个 batch
      lastSnapshot = ''
      lastChangeAt = 0
      lastReportAt = 0
      stalledWarned = false
      return
    }
    const now = Date.now()
    const fingerprint = state.lanes.map((l) => `${l.taskId}:${l.phase}`).join(',')
    if (fingerprint !== lastSnapshot) {
      lastSnapshot = fingerprint
      lastChangeAt = now
      stalledWarned = false
    } else if (!stalledWarned && now - lastChangeAt >= stalledThresholdMs) {
      // 卡住检测（默认开启）：lane 阶段不变 + worker 会话日志也超时无更新才算真卡住。
      // 会话仍在写说明 worker 在干活（写大段代码时 lane 阶段不变），不误报。
      const runningLanes = state.lanes.filter((l) => l.phase === 'running' || l.phase === 'review')
      const activities = runningLanes.map((l) => (l.worktree ? latestSessionActivity(l.worktree) : 0))
      const anyFound = activities.some((m) => m > 0)
      const allStale = activities.length > 0 && activities.every((m) => m > 0 && now - m >= stalledThresholdMs)
      if (anyFound && allStale) {
        stalledWarned = true
        lastReportAt = now
        const minutes = Math.round((now - lastChangeAt) / 60_000)
        wake(m.stalled(state.id, minutes))
      } else if (anyFound) {
        // 会话仍活跃：worker 在干活，重置无变化计时，避免每轮重复评估。
        lastChangeAt = now
      }
    }
    // 定时汇报（默认关闭；operator 要求后按间隔唤醒）
    if (reportIntervalMs > 0 && now - lastReportAt >= reportIntervalMs) {
      lastReportAt = now
      wake(`${m.periodicReport(Math.round(reportIntervalMs / 60_000))}\n${compactBatchStatus(state)}\n\n${m.etaLabel}${estimateEta(state, refLocale())}`)
    }
  }

  const timer = setInterval(check, checkIntervalMs)
  return {
    setReportInterval(minutes: number): string {
      const m = messages(refLocale())
      if (!Number.isFinite(minutes) || minutes < 0) return m.invalidInterval(minutes)
      reportIntervalMs = Math.round(minutes * 60_000)
      // 以设置时刻为基准：第一次汇报在完整间隔之后，而不是立即触发。
      lastReportAt = Date.now()
      return reportIntervalMs === 0 ? m.reportIntervalOff : m.reportIntervalOn(minutes)
    },
    getReportInterval(): number {
      return Math.round(reportIntervalMs / 60_000)
    },
    dispose(): void {
      clearInterval(timer)
    },
  }
}
