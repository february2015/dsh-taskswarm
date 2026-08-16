/**
 * TaskSwarm orchestrator plugin — registers the /orch-family human commands on
 * `ctx.commands` and lazily builds a per-repo TaskSwarmEngine. Mount via the
 * `taskswarm` bundle patch (cordis.patch.yml) on any profile that composes the
 * base services. Replaces TaskPlane's `extensions/task-orchestrator.ts`
 * (github.com/HenryLach/taskplane, MIT License).
 *
 * Commands:
 *   /orch [scope]       start a batch (scope: all | <task-id> | <path>)
 *   /orch-plan [scope]  preview waves and dependencies (no execution)
 *   /orch-check         validate all task packets (parse + structure + waves)
 *   /orch-status        current batch / lane progress
 *   /orch-pause         pause after the current wave
 *   /orch-resume        resume a paused batch
 *   /orch-abort         abort after the current wave
 *   /orch-deps [scope]  show the dependency graph
 *   /orch-sessions      list active lanes and their worktrees
 *   /orch-integrate     merge taskswarm/orch into the working branch
 *   /tswarm-init [ID]     scaffold two example tasks from templates
 * @module taskswarm/orchestrator
 */
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult, CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TaskSwarmEngine, type EngineConfig, type TaskSwarmEvent } from './engine.ts'
import { InProcessWorkerHost } from './in-process-host.ts'
import { HeadlessWorkerHost, type WorkerHost } from './worker-host.ts'
import { shouldWake, supervisorEventReport, registerSupervisor, startPeriodicSupervision, estimateEta, type SupervisorAutonomyLevel } from './supervisor.ts'
import { DashboardManager } from './dashboard.ts'
import { resolveLocale, type LocaleState } from './i18n.ts'
import { readSettings } from './settings.ts'
import { scanTasks, scanTaskFailures, formatTaskFailures, formatWavePlan, buildWaves } from '../core/discover.ts'
import { scaffoldTask, checkPacketQuality } from '../core/task.ts'
import { formatBatchStatus, type BatchState } from '../core/status.ts'

export const name = 'tswarm-orchestrator'
export const inject = ['commands', 'agents', 'agentDefaultModel', 'sessions']

export interface Config {
  repoRoot?: string
  tasksRoot?: string
  stateRoot?: string
  workerModel?: string
  reviewerModel?: string
  /** LLM merge agent 的模型路由（默认跟随当前会话模型）。 */
  mergerModel?: string
  /** Merge 完成后运行的验证命令（如 ["npm test"]）。 */
  mergeVerifyCommands?: string[]
  /** LLM merge agent 看门狗超时（分钟），默认 10（0 = 禁用）。 */
  mergerTimeoutMinutes?: number
  includeDoneTasks?: boolean
  host?: 'in-process' | 'headless'
  dshBin?: string
  workerProfile?: string
  /** Conversational supervisor autonomy (ported from TaskPlane): 'off' | 'interactive' | 'supervised' (default) | 'autonomous'. */
  supervisorMode?: 'off' | 'interactive' | 'supervised' | 'autonomous'
  /** 定时检查间隔（毫秒），默认 60000（1 分钟）。只读状态，零成本。 */
  supervisorCheckIntervalMs?: number
  /** 距上次 lane 变化超过该时长 → 唤醒"疑似卡住"提醒（毫秒），默认 420000（7 分钟）。 */
  supervisorStalledMs?: number
  /** supervisor 通知/提示词语言：'auto'（默认，按会话语言检测）| 'zh-CN' | 'en'。.taskswarm/config.json 的运行时设置优先。 */
  locale?: 'auto' | 'zh-CN' | 'en'
  /** 单 lane 看门狗超时（分钟），默认 90：worker 超时无完成事件 → 强制结束该 lane（failed），
   *  防止失联 worker 卡死 wave、批次只能靠重启引擎恢复（KI-007 方案 B）。0 = 禁用。 */
  laneTimeoutMinutes?: number
  /** 波次内出现 failed lane 时自动暂停批次等 supervisor 处置（默认 true）。 */
  pauseOnLaneFailure?: boolean
}

export const Config: z<Config> = z.object({
  repoRoot: z.string(),
  tasksRoot: z.string(),
  stateRoot: z.string(),
  workerModel: z.string(),
  reviewerModel: z.string(),
  mergerModel: z.string(),
  mergeVerifyCommands: z.array(z.string()),
  mergerTimeoutMinutes: z.number().default(10),
  includeDoneTasks: z.boolean(),
  host: z.union([z.const('in-process'), z.const('headless')]).default('in-process'),
  dshBin: z.string(),
  workerProfile: z.string(),
  supervisorMode: z.union([z.const('off'), z.const('interactive'), z.const('supervised'), z.const('autonomous')]).default('supervised'),
  supervisorCheckIntervalMs: z.number().default(60_000),
  supervisorStalledMs: z.number().default(420_000),
  locale: z.union([z.const('auto'), z.const('zh-CN'), z.const('en')]).default('auto'),
  laneTimeoutMinutes: z.number().default(180),
  pauseOnLaneFailure: z.boolean().default(true),
})

interface EngineRef {
  engine: TaskSwarmEngine
  repoRoot: string
  tasksRoot: string
  stateRoot: string
  /** 该仓库的定时检查/汇报控制（engine 创建时建立）。 */
  periodic?: ReturnType<typeof startPeriodicSupervision>
  /** 语言状态（可变；tswarm_supervisor_locale 工具可文字切换并持久化）。 */
  locale: LocaleState
}

const USAGE = 'Usage: /orch [all|<task-id>|<path>]'

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function err(text: string): CommandResult {
  return { kind: 'error', text }
}

interface SessionLike {
  id?: string
  header?: { cwd?: string }
  meta?: { cwd?: string; origin?: string }
}

interface AgentLike {
  ctx?: Context
  session?: SessionLike
}

function agentCwdOf(agent: AgentLike | undefined, ctx: Context): string | undefined {
  const session = agent?.session
  const direct = session?.header?.cwd ?? session?.meta?.cwd
  if (direct) return direct
  // 会话恢复后 header/meta 可能不带 cwd：用 workspace 服务反查权威的"会话→工作目录"
  // 映射（侧边栏分组同源），与 Pi 的"会话即工作目录"模型一致，无需配置默认仓库。
  const sessionId = session?.id
  if (!sessionId) return undefined
  try {
    const workspaces = (ctx.get('workspace') as { list?(): { path: string; sessionIds: string[] }[] } | undefined)?.list?.() ?? []
    for (const ws of workspaces) {
      if (ws.sessionIds.includes(sessionId)) return ws.path
    }
  } catch {
    // workspace 服务不可用时退回 undefined（由调用方兜底）
  }
  return undefined
}

// ── /tswarm-dashboard（移植自 WEB-006 的抢救实现）────────────────────────────
// dashboard 进程统一由 DashboardManager 管理（与 supervisor 的 tswarm_dashboard
// 工具共享注册表），启动批次时也会自动拉起并打印链接。

/** 从起点向上找最近的 git 仓库根（含 .git 的目录）；找不到返回 undefined。 */
function nearestGitRoot(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function apply(ctx: Context, config: Config): void {
  const engines = new Map<string, EngineRef>()
  const dashboards = new DashboardManager()
  const templatesDir = fileURLToPath(new URL('../../templates/tasks/', import.meta.url))

  // 标准集成服务：其它插件（如 dsh-dingo）可通过 ctx.get('taskswarm') 读取活跃批次。
  const taskswarmService = {
    getSnapshot(): {
      batches: Array<{
        batchId: string
        phase: string
        lanes: Array<{ lane: number; taskId: string; phase: string }>
        ownerSessionId?: string
      }>
    } {
      const batches: Array<{
        batchId: string
        phase: string
        lanes: Array<{ lane: number; taskId: string; phase: string }>
        ownerSessionId?: string
      }> = []
      for (const ref of engines.values()) {
        batches.push(...ref.engine.activeBatches())
      }
      return { batches }
    },
  }
  ctx.provide('taskswarm', taskswarmService)

  // 进程关闭（Ctrl+C / 插件卸载）时，先优雅停止所有在跑 batch：abort 会 cancel
  // 活跃 lanes 并清理 worktree，避免 worker 在 agent 工厂卸载后仍在 spawn
  // （"no agent factory registered" 竞态）；同时回收 dashboard 子进程。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const ref of engines.values()) {
        try {
          ref.engine.abort()
        } catch {
          // shutdown must not throw
        }
      }
      dashboards.disposeAll()
    })
  }

  // 会话一出现就自动挂 supervisor 工具（对齐 Pi：agent 天生具备能力，无需先发命令）。
  const tryRegisterSupervisorFor = (agent: AgentLike | undefined): void => {
    if (config.supervisorMode === 'off') return
    if (!agent?.ctx || !agent.session) return
    if (agent.session.meta?.origin === 'subagent') return // worker/reviewer 不挂 supervisor 工具
    try {
      const ref = ensureEngineForAgent(agent)
      if ('error' in ref) return
      const autonomy: SupervisorAutonomyLevel = config.supervisorMode ?? 'supervised'
      registerSupervisor(agent.ctx, () => ref, autonomy, ref.periodic, dashboards)
    } catch {
      // 非致命：工具挂载失败不影响会话
    }
  }
  try {
    const onAgentCreated = (payload: { agent: AgentLike }): void => tryRegisterSupervisorFor(payload.agent)
    ctx.on('agent/created' as unknown as keyof Context['on'], onAgentCreated as never)
  } catch {
    // 事件通道不可用时退回命令时注册
  }

  const ensureEngineForAgent = (agent: AgentLike | undefined): EngineRef | { error: string } => {
    const agentDir = agentCwdOf(agent, ctx)
    const repoRoot = config.repoRoot
      ? resolve(config.repoRoot)
      : agentDir
        ? resolve(agentDir)
        : nearestGitRoot(process.cwd()) ?? process.cwd()
    const cached = engines.get(repoRoot)
    if (cached) return cached

    const tasksRoot = config.tasksRoot ? resolve(config.tasksRoot) : join(repoRoot, 'tasks')
    const stateRoot = config.stateRoot ? resolve(config.stateRoot) : join(repoRoot, '.taskswarm')
    mkdirSync(stateRoot, { recursive: true })

    let host: WorkerHost
    if (config.host === 'headless') {
      host = new HeadlessWorkerHost({
        dshBin: config.dshBin ?? 'dsh',
        profile: config.workerProfile ?? 'tswarm-worker',
      })
    } else {
      host = new InProcessWorkerHost({
        agents: ctx.get('agents') as never,
        agentDefaultModel: ctx.get('agentDefaultModel') as never,
      }, { mergerModel: config.mergerModel })
    }

    // Conversational supervisor (ported from TaskPlane): the session agent
    // becomes the supervisor. The engine emits structured events;
    // decision-worthy events (started / failed / REVISE / complete / aborted)
    // wake the agent with a [TaskSwarm supervisor] report so it inspects state,
    // classifies its next action, and acts or asks per its autonomy level.
    const supervisorMode: SupervisorAutonomyLevel | 'off' = config.supervisorMode ?? 'supervised'
    const supervisorAgent = (supervisorMode === 'off'
      ? undefined
      : agent as { followup?(message: unknown): void; ctx?: Context } | undefined)
    const autonomy: SupervisorAutonomyLevel = supervisorMode === 'off' ? 'supervised' : supervisorMode

    // 仓库级设置（.taskswarm/config.json）：运行时文字设置优先于插件 config。
    const repoSettings = readSettings(stateRoot)
    // 语言状态：可变 holder，onEvent / supervisor 工具 / 定时检查共享同一份。
    const localeState: LocaleState = {
      value: repoSettings.locale ?? resolveLocale(config.locale, ctx.get('sessions'), agent?.session?.id),
    }

    const engine = new TaskSwarmEngine({
      repoRoot,
      tasksRoot,
      stateRoot,
      host,
      laneTimeoutMinutes: config.laneTimeoutMinutes,
      ...(config.pauseOnLaneFailure != null ? { pauseOnLaneFailure: config.pauseOnLaneFailure } : {}),
      ...(config.workerModel ? { workerModel: config.workerModel } : {}),
      ...(config.reviewerModel ? { reviewerModel: config.reviewerModel } : {}),
      ...(config.mergerModel ? { mergerModel: config.mergerModel } : {}),
      ...(config.mergeVerifyCommands?.length ? { mergeVerifyCommands: config.mergeVerifyCommands } : {}),
      ...(config.mergerTimeoutMinutes != null ? { mergerTimeoutMinutes: config.mergerTimeoutMinutes } : {}),
      includeDoneTasks: config.includeDoneTasks,
      ...(supervisorAgent?.followup
        ? {
            onEvent: (event: TaskSwarmEvent, owner?: unknown): void => {
              if (!shouldWake(event)) return
              // 事件只回发给发起该 batch 的会话（owner），避免共享 engine 时跨会话串消息。
              const target = (owner ?? supervisorAgent) as { followup?(m: unknown): void } | undefined
              if (!target?.followup) return
              try {
                const state = engine.status()
                target.followup(createUserMessage({
                  content: [{ type: 'text', text: supervisorEventReport(event, state, localeState.value) }],
                  source: { kind: 'user' },
                }))
              } catch {
                // A failing supervisor wake must never break batch execution.
              }
            },
          }
        : {}),
    })
    let periodic: EngineRef['periodic']
    if (supervisorAgent?.followup && supervisorMode !== 'off') {
      // 定时检查（常驻、默认开）：卡住检测。定时汇报默认关，由 operator 通过
      // tswarm_supervisor_report_interval 工具开启（"每隔 X 分钟汇报一次"）；
      // .taskswarm/config.json 里的 reportIntervalMinutes 会作为初始间隔（跨重启生效）。
      periodic = startPeriodicSupervision(() => ref, (text) => {
        if (!supervisorAgent.followup) return
        try {
          supervisorAgent.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }))
        } catch {
          // non-fatal
        }
      }, {
        checkIntervalMs: config.supervisorCheckIntervalMs,
        stalledThresholdMs: config.supervisorStalledMs,
        initialReportIntervalMinutes: repoSettings.reportIntervalMinutes,
        // 波次执行期间自动维持 dashboard（同工作区单实例，幂等）
        dashboardStatus: () => dashboards.status(ref.repoRoot),
        ensureDashboard: () => dashboards.ensure(ref.repoRoot),
      })
    }
    const ref: EngineRef = { engine, repoRoot, tasksRoot, stateRoot, periodic, locale: localeState }
    engines.set(repoRoot, ref)
    return ref
  }

  const ensureEngine = (invocation: CommandInvocation): EngineRef | { error: string } =>
    ensureEngineForAgent(invocation.agent as AgentLike)

  const withEngine = async (
    invocation: CommandInvocation,
    fn: (ref: EngineRef) => CommandResult | Promise<CommandResult>,
  ): Promise<CommandResult> => {
    const ref = ensureEngine(invocation)
    if ('error' in ref) return err(ref.error)
    try {
      return await fn(ref)
    } catch (e) {
      return err(`taskswarm: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Command family: /tswarm-* primary, /orch-* kept as compatible aliases ──
  const registerCommand = (names: string[], def: Omit<CommandDefinition, 'name'>): void => {
    for (const name of names) ctx.commands.register({ ...def, name })
  }

  registerCommand(['tswarm', 'orch'], {
    description: 'start a TaskSwarm batch: orchestrate tasks in parallel waves (git worktree isolation)',
    input: { hint: '[all|<task-id>|<path>]' },
    handler: (invocation) => withEngine(invocation, async (ref) => {
      const scope = invocation.rawInput.trim() || 'all'
      const handle = ref.engine.run(scope, invocation.agent)
      const status = ref.engine.status()
      const waveCount = status?.waves ?? 0
      let text = `Batch ${handle.batchId} started: ${status?.lanes.length ?? 0} tasks in ${waveCount} wave(s). Monitor with /tswarm-status.`
      const failures = scanTaskFailures(ref.tasksRoot)
      if (failures.length > 0) {
        text += `\n⚠️ ${failures.length} 个任务包解析失败被跳过：${failures.map((f) => f.folder).join(', ')}（/tswarm-check 查看原因）`
      }
      // 波次执行即自动拉起 dashboard 并把链接打印出来（正常跑着就想看状态）。
      const d = await dashboards.ensure(ref.repoRoot)
      text += d.ok ? `\n📊 Dashboard: ${d.url}` : `\n⚠️ Dashboard 启动失败：${d.text}`
      return ok(text)
    }),
  })

  registerCommand(['tswarm-plan', 'orch-plan'], {
    description: 'preview the TaskSwarm wave plan and dependency graph without executing',
    input: { hint: '[all|<task-id>|<path>]' },
    handler: (invocation) => withEngine(invocation, (ref) => {
      const scope = invocation.rawInput.trim() || 'all'
      const { waves, count } = ref.engine.plan(scope)
      const failNote = formatTaskFailures(scanTaskFailures(ref.tasksRoot))
      return ok(count === 0
        ? `${failNote ? failNote + '\n\n' : ''}No tasks found under ${ref.tasksRoot}. Run /tswarm-init to scaffold examples, or check the tasks root.`
        : `${count} task(s):\n\n${formatWavePlan(waves)}${failNote ? `\n\n${failNote}` : ''}`)
    }),
  })

  registerCommand(['tswarm-check', 'orch-check'], {
    description: 'validate all task packets: parse status, structure warnings, and the wave plan',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const failures = scanTaskFailures(ref.tasksRoot)
      const tasks = scanTasks(ref.tasksRoot, true)
      const lines: string[] = [`任务包校验（${ref.tasksRoot}）：解析成功 ${tasks.length} 个${failures.length > 0 ? `，失败 ${failures.length} 个` : ''}`]
      if (failures.length > 0) {
        lines.push('', '❌ 解析失败（会被引擎静默跳过，必须修复）：')
        for (const f of failures) lines.push(`  - ${f.folder}：${f.reason}`)
      }
      const warnings: string[] = []
      for (const t of tasks) {
        for (const w of checkPacketQuality(t.task)) warnings.push(`  - ${t.task.id}（${t.task.name}）：${w}`)
      }
      if (warnings.length > 0) {
        lines.push('', '⚠️ 结构警告（不影响解析，但建议修复）：')
        lines.push(...warnings)
      }
      if (tasks.length > 0) {
        lines.push('', formatWavePlan(buildWaves(tasks.map((t) => t.task))))
      }
      return ok(lines.join('\n'))
    }),
  })

  registerCommand(['tswarm-status', 'orch-status'], {
    description: 'show the current TaskSwarm batch and lane progress',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const state: BatchState | null = ref.engine.status()
      return state ? ok(formatBatchStatus(state)) : ok('No TaskSwarm batch has been run yet in this repo. Start one with /tswarm.')
    }),
  })

  registerCommand(['tswarm-pause', 'orch-pause'], {
    description: 'pause the TaskSwarm batch after the current wave',
    handler: (invocation) => withEngine(invocation, (ref) =>
      ref.engine.pause() ? ok('Batch paused after the current wave.') : err('No running batch to pause.')),
  })

  registerCommand(['tswarm-resume', 'orch-resume'], {
    description: 'resume a paused TaskSwarm batch',
    handler: (invocation) => withEngine(invocation, (ref) =>
      ref.engine.resume() ? ok('Batch resumed.') : err('No paused batch to resume.')),
  })

  registerCommand(['tswarm-abort', 'orch-abort'], {
    description: 'abort the TaskSwarm batch after the current wave (kills running lanes)',
    handler: (invocation) => withEngine(invocation, (ref) =>
      ref.engine.abort() ? ok('Batch abort requested.') : err('No running batch to abort.')),
  })

  registerCommand(['tswarm-deps', 'orch-deps'], {
    description: 'show the TaskSwarm task dependency graph',
    input: { hint: '[all|<task-id>|<path>]' },
    handler: (invocation) => withEngine(invocation, (ref) => {
      const scope = invocation.rawInput.trim() || 'all'
      const { waves, count } = ref.engine.plan(scope)
      return ok(count === 0 ? 'No tasks match the requested scope.' : formatWavePlan(waves))
    }),
  })

  registerCommand(['tswarm-sessions', 'orch-sessions'], {
    description: 'list active TaskSwarm lanes and their worktrees',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const state = ref.engine.status()
      if (!state) return ok('No batch yet.')
      const active = state.lanes.filter((l) => l.phase === 'running' || l.phase === 'review' || l.phase === 'conflict')
      if (active.length === 0) return ok('No active lanes.')
      return ok(active.map((l) => `lane ${l.lane} [${l.phase}] ${l.taskId} @ ${l.worktree ?? '?'}`).join('\n'))
    }),
  })

  registerCommand(['tswarm-stop-lane', 'orch-stop-lane'], {
    description: 'stop one lane immediately (kill its worker, mark failed, preserve worktree/checkpoints); other lanes continue; the batch pauses after the wave for disposition',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const scope = invocation.rawInput.trim()
      if (!scope) return err('Usage: /tswarm-stop-lane <taskId>')
      const result = ref.engine.stopLane(scope.toUpperCase())
      return result.ok ? ok(result.message) : err(result.message)
    }),
  })

  registerCommand(['tswarm-switch-model', 'orch-switch-model'], {
    description: 'switch one lane to a different model: stop its worker, record the model override, and auto-rerun it from the next step (checkpoints preserved). Usage: /tswarm-switch-model <taskId> <model>',
    handler: (invocation) => withEngine(invocation, async (ref) => {
      const args = invocation.rawInput.trim().split(/\s+/)
      const taskId = (args[0] ?? '').toUpperCase()
      const model = args.slice(1).join(' ')
      if (!taskId || !model) return err('Usage: /tswarm-switch-model <taskId> <model>')
      const result = await ref.engine.switchLaneModel(taskId, model)
      return result.ok ? ok(result.message) : err(result.message)
    }),
  })

  registerCommand(['tswarm-integrate', 'orch-integrate'], {
    description: 'merge the taskswarm/orch integration branch into the working branch',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const result = ref.engine.integrate()
      return result.ok ? ok(`Integrated: ${result.message}`) : err(`Integration failed: ${result.message}`)
    }),
  })

  registerCommand(['tswarm-dashboard', 'orch-dashboard'], {
    description: 'start the TaskSwarm web dashboard for this repo (independent local server)',
    input: { hint: '[--port <number>]' },
    handler: (invocation) => withEngine(invocation, async (ref) => {
      // 显式 --port 才指定端口；缺省走自动避让。同工作区单实例由 manager 保证
      // （已在跑的实例会复用，绝不重复拉起）。
      const match = invocation.rawInput.trim().match(/--port\s+(\d+)/)
      const rawPort = match ? Number(match[1]) : undefined
      const port = rawPort !== undefined && Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : undefined
      const d = await dashboards.ensure(ref.repoRoot, port)
      return d.ok
        ? ok(`TaskSwarm Dashboard → ${d.url} (repo: ${ref.repoRoot})`)
        : err(`Dashboard 启动失败：${d.text}`)
    }),
  })

  ctx.commands.register({
    name: 'tswarm-init',
    description: 'scaffold two example TaskSwarm tasks (EXAMPLE-001 hello-world, EXAMPLE-002 parallel-smoke)',
    input: { hint: '[ID]' },
    handler: (invocation) => withEngine(invocation, (ref) => {
      const prefix = invocation.rawInput.trim().toUpperCase()
      const template = (name: string): string => join(templatesDir, name)
      const create = (templateName: string, id: string, slug: string): string => {
        const folder = scaffoldTask(ref.tasksRoot, template(templateName), id, slug)
        return folder ? `  ${id}-${slug} @ ${folder}` : `  ${id}-${slug}: skipped (already exists or template missing)`
      }
      const base = prefix || 'EXAMPLE'
      if (!existsSync(ref.tasksRoot)) mkdirSync(ref.tasksRoot, { recursive: true })
      const lines = [
        `Tasks root: ${ref.tasksRoot}`,
        create('EXAMPLE-001-hello-world', `${base}-001`, 'hello-world'),
        create('EXAMPLE-002-parallel-smoke', `${base}-002`, 'parallel-smoke'),
      ]
      return ok(lines.join('\n'))
    }),
  })
}
