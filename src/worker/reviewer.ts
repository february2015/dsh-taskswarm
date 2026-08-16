/**
 * Reviewer spawner — creates an independent reviewer agent (optionally on a
 * different model route) that inspects the lane worktree diff and returns a
 * PASS / REVISE verdict. Replaces TaskPlane's reviewer extension
 * (github.com/HenryLach/taskplane, MIT License) with DSH-native agents.
 * @module taskswarm/worker/reviewer
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountStandardTools, grantWorkerFullAccess } from './worker-tools.ts'

export interface ReviewerDeps {
  agents: {
    create(options: {
      sessionId: unknown
      meta: { cwd: string; origin?: 'subagent' }
      agentOptions: { provider: string; model: string }
      setup?: (agentCtx: unknown) => void
    }): Promise<{ agent: ReviewerAgent; dispose?(): Promise<void> | void }>
  }
  agentDefaultModel: {
    currentSelection(): { provider: string; model: string }
  }
}

export interface ReviewerAgent {
  session: {
    seq: number
    events: readonly SessionEvent[]
  }
  whenIdle(): Promise<void>
  followup(message: unknown): void
  cancel?(cause?: string): void | Promise<void>
}

export interface ReviewRequest {
  worktree: string
  taskDir: string
  taskId: string
  step: string
  type: string
}

export interface ReviewResult {
  verdict: 'PASS' | 'REVISE'
  summary: string
}

/** Last non-empty assistant text block from an agent's session events. */
export function lastAssistantText(agent: ReviewerAgent): string {
  let text = ''
  for (const event of agent.session.events) {
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
  }
  return text
}

/**
 * Build a reviewer spawner bound to a process's agents service. Used by the
 * in-process worker host and the headless worker runner alike.
 */
export function createReviewerSpawner(
  deps: ReviewerDeps,
  reviewerModel?: string,
): (request: ReviewRequest) => Promise<ReviewResult> {
  return async (request) => {
    const selection = deps.agentDefaultModel.currentSelection()
    const model = reviewerModel ?? selection.model
    const { agent, dispose } = await deps.agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: request.worktree, origin: 'subagent' },
      agentOptions: { provider: selection.provider, model },
      setup: (agentCtx) => {
        // Reviewer 也是内部 agent：必须 full access + approvals off（2026-08-16 修复——
        // 此前漏了 grantWorkerFullAccess，reviewer 会话保持默认 workspace-write + ask，
        // 会触发授权提醒）。
        grantWorkerFullAccess(agentCtx as unknown as Context)
        mountStandardTools(agentCtx as unknown as Context)
      },
    })
    try {
      await agent.whenIdle()
      const prompt = [
        `You are an independent reviewer for task ${request.taskId}, step ${request.step} (${request.type}).`,
        `Inspect the worktree at ${request.worktree}: run \`git diff\` against the parent branch to see the changes.`,
        `Check the changes against the mission, steps, and completion criteria in ${request.taskDir}/PROMPT.md.`,
        'Respond with a verdict line: PASS or REVISE, followed by a short findings summary.',
      ].join('\n')
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      const text = lastAssistantText(agent)
      const verdict: 'PASS' | 'REVISE' = /\bREVISE\b/i.test(text) ? 'REVISE' : 'PASS'
      return { verdict, summary: text.slice(0, 2000) }
    } finally {
      // Tear the reviewer session down once the verdict is produced.
      try {
        await dispose?.()
      } catch {
        // disposal failure must not mask the verdict
      }
    }
  }
}
