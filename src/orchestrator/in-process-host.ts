/**
 * In-process worker host — creates lane worker agents through the DSH agent
 * registry inside the orchestrator process (the default host for the web
 * profile). Replaces TaskPlane's `pi --mode rpc` subprocess spawn
 * (extensions/taskplane/agent-host.ts, github.com/HenryLach/taskplane, MIT).
 * @module taskswarm/orchestrator/in-process-host
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerLaneTools, buildWorkerMission, type LaneRuntime } from '../worker/lane-tools.ts'
import { mountStandardTools, grantWorkerFullAccess } from '../worker/worker-tools.ts'
import { createReviewerSpawner, lastAssistantText, type ReviewerAgent, type ReviewerDeps } from '../worker/reviewer.ts'
import { createMergerSpawner, type MergeRequest, type MergeResult } from '../worker/merger.ts'
import type { LaneSpec, WorkerHost, WorkerResult } from './worker-host.ts'

export interface InProcessHostDeps {
  agents: ReviewerDeps['agents']
  agentDefaultModel: ReviewerDeps['agentDefaultModel']
}

export class InProcessWorkerHost implements WorkerHost {
  readonly kind = 'in-process'
  private readonly running = new Map<number, ReviewerAgent>()
  private readonly mergerModel?: string

  constructor(private readonly deps: InProcessHostDeps, options: { mergerModel?: string } = {}) {
    this.mergerModel = options.mergerModel
  }

  async spawn(spec: LaneSpec): Promise<WorkerResult> {
    const selection = this.deps.agentDefaultModel.currentSelection()
    const lane: LaneRuntime = {
      taskDir: spec.task.folder,
      worktree: spec.worktree,
      repoRoot: spec.repoRoot,
      batchId: spec.batchId,
      stateRoot: spec.stateRoot,
      lane: spec.lane,
      ...(spec.reviewerModel ? { reviewerModel: spec.reviewerModel } : {}),
      spawnReviewer: createReviewerSpawner(this.deps, spec.reviewerModel),
    }
    let agent: ReviewerAgent
    let dispose: (() => Promise<void> | void) | undefined
    try {
      const handle = await this.deps.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        // origin 'subagent' keeps worker sessions out of the sidebar's workspace
        // groups (they are internal agents, not user conversations); dispose()
        // tears the session down once the lane turn finishes.
        // taskswarmWorker: 显式标记，供 dsh-dingo 等插件精确识别 TaskSwarm 内部 worker
        // （9fd2634：dingo 用该字段排除内部会话，避免出现在用户卡片清单/统计）。
        meta: { cwd: spec.worktree, origin: 'subagent', taskswarmWorker: true },
        agentOptions: { provider: selection.provider, model: spec.model ?? selection.model },
        setup: (agentCtx) => {
          // Workers are internal agents: grant them full sandbox access with
          // approvals off (per-session, via the DSH delegation event mechanism),
          // then mount the standard tool set when the ambient profile does not
          // provide it, and finally register the lane bridge tools.
          grantWorkerFullAccess(agentCtx as unknown as Context)
          mountStandardTools(agentCtx as unknown as Context)
          registerLaneTools(agentCtx as unknown as { tools: { register(def: unknown): unknown } }, lane)
        },
      })
      agent = handle.agent
      dispose = handle.dispose
    } catch (e) {
      // Process shutdown (agent factory already unloaded) or transient creation
      // failure: fail the lane cleanly instead of crashing the batch loop.
      const message = e instanceof Error ? e.message : String(e)
      return { exitCode: 1, error: message, text: message }
    }
    this.running.set(spec.lane, agent)
    try {
      await agent.whenIdle()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildWorkerMission(spec.task.folder, spec.worktree, spec.lane, spec.task.id) }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      const text = lastAssistantText(agent)
      const ok = turnCompleted(agent)
      return { exitCode: ok ? 0 : 1, text }
    } finally {
      this.running.delete(spec.lane)
      // Tear the worker session down once its turn finishes so completed
      // workers do not linger in memory or the sidebar session list.
      try {
        await dispose?.()
      } catch {
        // disposal failure must not mask the lane result
      }
    }
  }

  /** Resolve a failed lane merge with an LLM merge agent inside the orch worktree. */
  async spawnMerger(request: MergeRequest): Promise<MergeResult> {
    const spawner = createMergerSpawner(this.deps, this.mergerModel)
    return spawner(request)
  }

  abort(lane: number): void {
    const agent = this.running.get(lane)
    if (agent) void agent.cancel?.('taskswarm-abort')
  }
}

function turnCompleted(agent: ReviewerAgent): boolean {
  for (const event of agent.session.events) {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') return true
  }
  return false
}
