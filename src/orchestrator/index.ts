/**
 * Buju orchestrator plugin — registers the /orch-family human commands on
 * `ctx.commands` and lazily builds a per-repo BujuEngine. Mount via the
 * `dsh-buju` bundle patch (cordis.patch.yml) on any profile that composes the
 * base services. Replaces TaskPlane's `extensions/task-orchestrator.ts`
 * (github.com/HenryLach/taskplane, MIT License).
 *
 * Commands:
 *   /orch [scope]       start a batch (scope: all | <task-id> | <path>)
 *   /orch-plan [scope]  preview waves and dependencies (no execution)
 *   /orch-status        current batch / lane progress
 *   /orch-pause         pause after the current wave
 *   /orch-resume        resume a paused batch
 *   /orch-abort         abort after the current wave
 *   /orch-deps [scope]  show the dependency graph
 *   /orch-sessions      list active lanes and their worktrees
 *   /orch-integrate     merge buju/orch into the working branch
 *   /buju-init [ID]     scaffold two example tasks from templates
 * @module buju/orchestrator
 */
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { BujuEngine, type EngineConfig } from './engine.ts'
import { InProcessWorkerHost } from './in-process-host.ts'
import { HeadlessWorkerHost, type WorkerHost } from './worker-host.ts'
import { scanTasks, formatWavePlan } from '../core/discover.ts'
import { scaffoldTask } from '../core/task.ts'
import { formatBatchStatus, type BatchState } from '../core/status.ts'

export const name = 'buju-orchestrator'
export const inject = ['commands', 'agents', 'agentDefaultModel', 'sessions']

export interface Config {
  repoRoot?: string
  tasksRoot?: string
  stateRoot?: string
  workerModel?: string
  reviewerModel?: string
  includeDoneTasks?: boolean
  host?: 'in-process' | 'headless'
  dshBin?: string
  workerProfile?: string
}

export const Config: z<Config> = z.object({
  repoRoot: z.string(),
  tasksRoot: z.string(),
  stateRoot: z.string(),
  workerModel: z.string(),
  reviewerModel: z.string(),
  includeDoneTasks: z.boolean(),
  host: z.union([z.const('in-process'), z.const('headless')]).default('in-process'),
  dshBin: z.string(),
  workerProfile: z.string(),
})

interface EngineRef {
  engine: BujuEngine
  repoRoot: string
  tasksRoot: string
  stateRoot: string
}

const USAGE = 'Usage: /orch [all|<task-id>|<path>]'

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function err(text: string): CommandResult {
  return { kind: 'error', text }
}

function agentCwd(invocation: CommandInvocation): string | undefined {
  const session = (invocation.agent as {
    session?: { header?: { cwd?: string }; meta?: { cwd?: string } }
  } | undefined)?.session
  return session?.header?.cwd ?? session?.meta?.cwd
}

export function apply(ctx: Context, config: Config): void {
  const engines = new Map<string, EngineRef>()
  const templatesDir = fileURLToPath(new URL('../../templates/tasks/', import.meta.url))

  const ensureEngine = (invocation: CommandInvocation): EngineRef | { error: string } => {
    const agentDir = agentCwd(invocation)
    const repoRoot = config.repoRoot
      ? resolve(config.repoRoot)
      : agentDir
        ? resolve(agentDir)
        : process.cwd()
    const cached = engines.get(repoRoot)
    if (cached) return cached

    const tasksRoot = config.tasksRoot ? resolve(config.tasksRoot) : join(repoRoot, 'tasks')
    const stateRoot = config.stateRoot ? resolve(config.stateRoot) : join(repoRoot, '.buju')
    mkdirSync(stateRoot, { recursive: true })

    let host: WorkerHost
    if (config.host === 'headless') {
      host = new HeadlessWorkerHost({
        dshBin: config.dshBin ?? 'dsh',
        profile: config.workerProfile ?? 'buju-worker',
      })
    } else {
      host = new InProcessWorkerHost({
        agents: ctx.get('agents') as never,
        agentDefaultModel: ctx.get('agentDefaultModel') as never,
      })
    }

    const engineConfig: EngineConfig = {
      repoRoot,
      tasksRoot,
      stateRoot,
      host,
      ...(config.workerModel ? { workerModel: config.workerModel } : {}),
      ...(config.reviewerModel ? { reviewerModel: config.reviewerModel } : {}),
      includeDoneTasks: config.includeDoneTasks,
    }
    const ref: EngineRef = { engine: new BujuEngine(engineConfig), repoRoot, tasksRoot, stateRoot }
    engines.set(repoRoot, ref)
    return ref
  }

  const withEngine = (invocation: CommandInvocation, fn: (ref: EngineRef) => CommandResult): CommandResult => {
    const ref = ensureEngine(invocation)
    if ('error' in ref) return err(ref.error)
    try {
      return fn(ref)
    } catch (e) {
      return err(`buju: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  ctx.commands.register({
    name: 'orch',
    description: 'start a Buju batch: orchestrate tasks in parallel waves (git worktree isolation)',
    input: { hint: '[all|<task-id>|<path>]' },
    handler: (invocation) => withEngine(invocation, (ref) => {
      const scope = invocation.rawInput.trim() || 'all'
      const handle = ref.engine.run(scope)
      const status = ref.engine.status()
      const waveCount = status?.waves ?? 0
      return ok(`Batch ${handle.batchId} started: ${status?.lanes.length ?? 0} tasks in ${waveCount} wave(s). Monitor with /orch-status.`)
    }),
  })

  ctx.commands.register({
    name: 'orch-plan',
    description: 'preview the Buju wave plan and dependency graph without executing',
    input: { hint: '[all|<task-id>|<path>]' },
    handler: (invocation) => withEngine(invocation, (ref) => {
      const scope = invocation.rawInput.trim() || 'all'
      const { waves, count } = ref.engine.plan(scope)
      return ok(count === 0
        ? `No tasks found under ${ref.tasksRoot}. Run /buju-init to scaffold examples, or check the tasks root.`
        : `${count} task(s):\n\n${formatWavePlan(waves)}`)
    }),
  })

  ctx.commands.register({
    name: 'orch-status',
    description: 'show the current Buju batch and lane progress',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const state: BatchState | null = ref.engine.status()
      return state ? ok(formatBatchStatus(state)) : ok('No Buju batch has been run yet in this repo. Start one with /orch.')
    }),
  })

  ctx.commands.register({
    name: 'orch-pause',
    description: 'pause the Buju batch after the current wave',
    handler: (invocation) => withEngine(invocation, (ref) =>
      ref.engine.pause() ? ok('Batch paused after the current wave.') : err('No running batch to pause.')),
  })

  ctx.commands.register({
    name: 'orch-resume',
    description: 'resume a paused Buju batch',
    handler: (invocation) => withEngine(invocation, (ref) =>
      ref.engine.resume() ? ok('Batch resumed.') : err('No paused batch to resume.')),
  })

  ctx.commands.register({
    name: 'orch-abort',
    description: 'abort the Buju batch after the current wave (kills running lanes)',
    handler: (invocation) => withEngine(invocation, (ref) =>
      ref.engine.abort() ? ok('Batch abort requested.') : err('No running batch to abort.')),
  })

  ctx.commands.register({
    name: 'orch-deps',
    description: 'show the Buju task dependency graph',
    input: { hint: '[all|<task-id>|<path>]' },
    handler: (invocation) => withEngine(invocation, (ref) => {
      const scope = invocation.rawInput.trim() || 'all'
      const { waves, count } = ref.engine.plan(scope)
      return ok(count === 0 ? 'No tasks match the requested scope.' : formatWavePlan(waves))
    }),
  })

  ctx.commands.register({
    name: 'orch-sessions',
    description: 'list active Buju lanes and their worktrees',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const state = ref.engine.status()
      if (!state) return ok('No batch yet.')
      const active = state.lanes.filter((l) => l.phase === 'running' || l.phase === 'review')
      if (active.length === 0) return ok('No active lanes.')
      return ok(active.map((l) => `lane ${l.lane} [${l.phase}] ${l.taskId} @ ${l.worktree ?? '?'}`).join('\n'))
    }),
  })

  ctx.commands.register({
    name: 'orch-integrate',
    description: 'merge the buju/orch integration branch into the working branch',
    handler: (invocation) => withEngine(invocation, (ref) => {
      const result = ref.engine.integrate()
      return result.ok ? ok(`Integrated: ${result.message}`) : err(`Integration failed: ${result.message}`)
    }),
  })

  ctx.commands.register({
    name: 'buju-init',
    description: 'scaffold two example Buju tasks (EXAMPLE-001 hello-world, EXAMPLE-002 parallel-smoke)',
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
