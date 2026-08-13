/**
 * In-process worker host — creates lane worker agents through the DSH agent
 * registry inside the orchestrator process (the default host for the web
 * profile). Replaces TaskPlane's `pi --mode rpc` subprocess spawn
 * (extensions/taskplane/agent-host.ts, github.com/HenryLach/taskplane, MIT).
 * @module buju/orchestrator/in-process-host
 */
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerLaneTools, buildWorkerMission, type LaneRuntime } from '../worker/lane-tools.ts'
import { createReviewerSpawner, lastAssistantText, type ReviewerAgent, type ReviewerDeps } from '../worker/reviewer.ts'
import type { LaneSpec, WorkerHost, WorkerResult } from './worker-host.ts'

export interface InProcessHostDeps {
  agents: ReviewerDeps['agents']
  agentDefaultModel: ReviewerDeps['agentDefaultModel']
}

export class InProcessWorkerHost implements WorkerHost {
  readonly kind = 'in-process'
  private readonly running = new Map<number, ReviewerAgent>()

  constructor(private readonly deps: InProcessHostDeps) {}

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
    const { agent } = await this.deps.agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: spec.worktree },
      agentOptions: { provider: selection.provider, model: spec.model ?? selection.model },
      setup: (agentCtx) => {
        registerLaneTools(agentCtx as unknown as { tools: { register(def: unknown): unknown } }, lane)
      },
    })
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
    }
  }

  abort(lane: number): void {
    const agent = this.running.get(lane)
    if (agent) void agent.cancel?.('buju-abort')
  }
}

function turnCompleted(agent: ReviewerAgent): boolean {
  for (const event of agent.session.events) {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') return true
  }
  return false
}
