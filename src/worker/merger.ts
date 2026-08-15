/**
 * Merger spawner — creates an LLM merge agent (optionally on a different
 * model route) that resolves a failed lane merge inside the orch worktree.
 * Adapts TaskPlane's LLM merge agent
 * (extensions/taskplane/merge.ts, github.com/HenryLach/taskplane, MIT) to
 * DSH-native agents: instead of `git merge` failing on textual conflicts, the
 * agent reads both sides' intent and edits files to produce a semantically
 * correct merge.
 * @module taskswarm/worker/merger
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountStandardTools, grantWorkerFullAccess } from './worker-tools.ts'
import { lastAssistantText, type ReviewerDeps } from './reviewer.ts'

export interface MergeRequest {
  /** The orch integration worktree where the failed merge is in progress. */
  orchWorktree: string
  /** Lane branch whose merge into orch failed (source of the conflicting work). */
  laneBranch: string
  taskId: string
  repoRoot: string
  /** Optional verification commands to run after a successful merge (P2). */
  verifyCommands?: string[]
}

export type MergeStatus = 'SUCCESS' | 'CONFLICT_RESOLVED' | 'CONFLICT_UNRESOLVED'

export interface MergeResult {
  status: MergeStatus
  summary: string
}

/**
 * Build a merger spawner bound to a process's agents service. Used by the
 * in-process worker host (and available to headless hosts that implement it).
 */
export function createMergerSpawner(
  deps: ReviewerDeps,
  mergerModel?: string,
): (request: MergeRequest) => Promise<MergeResult> {
  return async (request) => {
    const selection = deps.agentDefaultModel.currentSelection()
    const model = mergerModel ?? selection.model
    const { agent, dispose } = await deps.agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      // cwd = orch worktree so the agent lands inside the in-progress merge.
      meta: { cwd: request.orchWorktree, origin: 'subagent' },
      agentOptions: { provider: selection.provider, model },
      setup: (agentCtx) => {
        // The merger edits files and runs git: grant full access like workers.
        grantWorkerFullAccess(agentCtx as unknown as Context)
        mountStandardTools(agentCtx as unknown as Context)
      },
    })
    try {
      await agent.whenIdle()
      const prompt = buildMergePrompt(request)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      const text = lastAssistantText(agent)
      const resolved = /\bCONFLICT_RESOLVED\b/i.test(text)
      const success = /\bSUCCESS\b/i.test(text)
      const status: MergeStatus = resolved ? 'CONFLICT_RESOLVED' : success ? 'SUCCESS' : 'CONFLICT_UNRESOLVED'
      return { status, summary: text.slice(0, 2000) }
    } finally {
      // Tear the merger session down once the verdict is produced.
      try {
        await dispose?.()
      } catch {
        // disposal failure must not mask the merge result
      }
    }
  }
}

/** Build the merge-agent mission prompt (adapted from TaskPlane buildMergeRequest). */
export function buildMergePrompt(request: MergeRequest): string {
  const verify = request.verifyCommands?.length
    ? request.verifyCommands.map((cmd) => `\`\`\`bash\n${cmd}\n\`\`\``).join('\n')
    : '(none)'
  return [
    '# Merge Resolution Task',
    '',
    `A lane merge into the integration branch failed with conflicts for task ${request.taskId}.`,
    'You are the LLM merge agent: resolve them semantically instead of giving up.',
    '',
    '## Situation',
    '',
    `- You are inside an isolated merge worktree (the orch integration worktree): ${request.orchWorktree}`,
    `- A \`git merge\` of branch \`${request.laneBranch}\` (task ${request.taskId}) is in progress and has conflicts (MERGE_HEAD exists).`,
    '- Do NOT checkout or create any other branch. Stay in this worktree.',
    '',
    '## Steps',
    '',
    '1. Inspect the state: `git status` and `git diff --name-only --diff-filter=U` to list conflicted files.',
    '2. Read each conflicted file and understand BOTH sides:',
    `   - HEAD side = what is already merged into the integration branch (previous tasks' output)`,
    `   - ${request.laneBranch} side = the worker's implementation of task ${request.taskId}`,
    '3. Resolve each conflict by editing the files. Keep complementary changes from BOTH sides; when',
    '   they genuinely conflict, prefer the worker task implementation unless it breaks existing',
    '   merged functionality.',
    '4. `git add <files>` after resolving each file.',
    '5. When all conflicts are resolved, run `git commit --no-edit` to complete the merge.',
    '6. Run the verification commands below after a successful merge.',
    '',
    '## Rules',
    '',
    '- Never delete a worker\'s completed implementation of the task unless it is provably broken.',
    '- Never overwrite previously merged work from other tasks unless the worker change intentionally supersedes it.',
    '- Keep the merge commit; do not amend or squash.',
    `- HARD: do NOT run \`git merge ${request.laneBranch}\` again — the merge is ALREADY in progress`,
    '  (MERGE_HEAD exists) and the lane branch is preserved only as a reference. Resolve the conflicts',
    '  in the working tree, `git add` the resolved files, and `git commit --no-edit` to conclude the merge.',
    '- HARD: do NOT abort the in-progress merge (no `git merge --abort`) unless resolution is impossible;',
    '  if you cannot resolve it, leave the merge state untouched and report CONFLICT_UNRESOLVED.',
    '',
    '## Verification Commands',
    '',
    verify,
    '',
    '## Response',
    '',
    'Finish with a line:',
    '- `CONFLICT_RESOLVED` — conflicts were resolved and the merge was committed.',
    '- `CONFLICT_UNRESOLVED` — you could not resolve the conflicts; leave the merge in progress for manual handling.',
    '- `SUCCESS` — the merge completed with no conflicts.',
    'followed by a short summary of what you did.',
  ].join('\n')
}
