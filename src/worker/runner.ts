/**
 * Buju worker runner — the headless worker bundle's one-shot driver.
 * Mirrors `@deepseek-ai/dsh-headless` (DeepSeek Harness, MIT): creates one
 * Agent per lane, registers the four bridge tools on its scoped context,
 * submits the mission, prints the final assistant text, and requests exit.
 *
 * Composition (profile `buju-worker`, bundles: [dsh-base]):
 *   - insert: buju-worker-startup  (name: 'dsh-buju/worker/startup')
 *   - insert: buju-worker-runner   (name: 'dsh-buju/worker/runner')
 * @module buju/worker/runner
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BUJU_WORKER_STARTUP_SERVICE, type BujuWorkerStartupValues } from './startup.ts'
import { registerLaneTools, buildWorkerMission, type LaneRuntime } from './lane-tools.ts'
import { createReviewerSpawner, lastAssistantText, type ReviewerDeps } from './reviewer.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

export const name = 'buju-worker-runner'
export const inject = ['agents', 'agentDefaultModel', 'sessions']

interface WorkerIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

export const internals: { stdout: WorkerIo['stdout']; stderr: WorkerIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

async function run(ctx: Context, startup: BujuWorkerStartupValues, io: WorkerIo): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents') as ReviewerDeps['agents'] | undefined
  const defaultModel = ctx.get('agentDefaultModel') as ReviewerDeps['agentDefaultModel'] | undefined
  if (agents === undefined || defaultModel === undefined) {
    io.stderr.write('dsh-buju: missing agents or agentDefaultModel service\n')
    io.exit(1)
    return
  }

  const selection = defaultModel.currentSelection()
  const lane: LaneRuntime = {
    taskDir: startup.taskDir,
    worktree: startup.worktree,
    repoRoot: startup.repoRoot,
    batchId: startup.batchId,
    stateRoot: startup.stateRoot,
    lane: startup.lane,
    ...(startup.model ? { reviewerModel: startup.reviewerModel } : {}),
    spawnReviewer: createReviewerSpawner({ agents, agentDefaultModel: defaultModel }, startup.reviewerModel),
  }

  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: startup.worktree },
    agentOptions: {
      provider: selection.provider,
      model: startup.model ?? selection.model,
    },
    setup: (agentCtx) => {
      registerLaneTools(agentCtx as unknown as { tools: { register(def: unknown): unknown } }, lane)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: buildWorkerMission(startup.taskDir, startup.worktree, startup.lane, startup.taskDir.split(/[\\/]/).pop()!.split('-').slice(0, 2).join('-').toUpperCase()) }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }

  io.stdout.write(text + '\n')
  if (reason?.kind === 'error') {
    io.stderr.write(`dsh-buju: ${reason.error.code}: ${reason.error.message}\n`)
  }
  io.exit(reason?.kind === 'completed' ? 0 : 1)
}

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as { (code: number): void } | undefined
  if (exit === undefined) {
    throw new Error('buju-worker-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const startup = ctx.get(BUJU_WORKER_STARTUP_SERVICE) as BujuWorkerStartupValues | undefined
  if (startup === undefined) {
    throw new Error('buju-worker-runner: missing bujuWorkerStartup service (worker profile must mount dsh-buju/worker/startup)')
  }
  const io: WorkerIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, startup, io).catch((error: unknown) => {
    io.stderr.write(`dsh-buju: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
