/**
 * Lane runtime + bridge tools shared by the in-process worker host and the
 * headless worker bundle. Replaces TaskPlane's `agent-bridge-extension.ts`
 * (github.com/HenryLach/taskplane, MIT License), which registered
 * notify_supervisor / escalate_to_supervisor / request_segment_expansion /
 * review_step for every spawned worker.
 * @module taskswarm/worker/lane-tools
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  parsePrompt, ensureStatusFile, advanceStep, markTaskDone, setTaskStatus,
  appendExecutionLog, appendAmendment, taskStatusFilePath, promptFilePath,
  parseStatusFile,
} from '../core/task.ts'
import { SUPERVISOR_SESSION, sessionInboxDir, writeMailboxMessage } from '../core/mailbox.ts'
import { checkpointCommit } from '../core/worktree.ts'

export interface LaneRuntime {
  taskDir: string
  worktree: string
  repoRoot: string
  batchId: string
  stateRoot: string
  lane: number
  reviewerModel?: string
  /** Optional reviewer spawner; when absent, review_step records a pending note. */
  spawnReviewer?: (request: { worktree: string; taskDir: string; taskId: string; step: string; type: string }) => Promise<{
    verdict: 'PASS' | 'REVISE'
    summary: string
  }>
}

/** Mission text handed to a worker agent. */
export function buildWorkerMission(taskDir: string, worktree: string, lane: number, taskId: string): string {
  return [
    `You are a TaskSwarm worker (lane ${lane}) executing task ${taskId} in an isolated git worktree.`,
    `- Worktree (cwd, where code changes go): ${worktree}`,
    `- Task packet: ${taskDir}/PROMPT.md (mission, steps, constraints) and ${taskDir}/STATUS.md (progress).`,
    `- Your lane worktree is based on taskswarm/orch: the output of ALL previously merged tasks is already in it. REUSE it — do not recreate shared files that already exist. If the task depends on work merged after your lane started, run \`git merge taskswarm/orch --no-edit\` in the worktree first (resolve any conflicts yourself).`,
    'Drive the task with the task_runner tool: `show` to read the packet, `advance` to tick the next',
    'checkbox and checkpoint-commit, `done` when the completion criteria are met, `blocked` with a',
    'reason if you cannot proceed. Call review_step at step boundaries. Use notify_supervisor to',
    'report progress and escalate_to_supervisor for issues you cannot resolve.',
    '',
    'HARD RULES on progress reporting (non-negotiable):',
    '- `advance` IMMEDIATELY after completing EACH checkbox — one `advance` per completed item, never batch them.',
    '- NEVER accumulate work and check all boxes at the end: the progress display and crash recovery depend on',
    '  incremental `advance` calls (each one checkpoint-commits your work, so a crash never loses progress).',
    '- If a step has several checkboxes, call `advance` after each one as soon as it is done, in order.',
    '- Only call `done` when ALL Completion Criteria in PROMPT.md are actually satisfied.',
    '- Do NOT edit STATUS.md by hand — it is updated exclusively through task_runner `advance` / `done`.',
  ].join('\n')
}

/**
 * Register the four bridge tools on an agent-scoped (or plain) tool context.
 * `ctx` must expose `tools.register` (agent.ctx or a plain plugin context).
 */

/** 当前任务步数进度 `checked/total`（工蜂→蜂王通知附带，让 supervisor 一眼看到跑了多少步）。 */
function currentStepProgress(taskDir: string): string {
  try {
    if (!existsSync(taskStatusFilePath(taskDir))) return ''
    const info = parseStatusFile(taskDir)
    return info.total ? `${info.checked}/${info.total}` : ''
  } catch {
    return ''
  }
}

/**
 * 当前 worker 累计执行步数（会话事件 `step` 字段最大值）——工蜂→蜂王通知附带。
 * worker 每执行一个动作（工具调用/回复）step 递增，比 checkbox 步骤细得多。
 * 读 `~/.dsh/sessions/--<worktree>--/` 下 JSONL(.zstd)，取最大 step；失败返回 ''。
 */
function workerStepCount(lane: LaneRuntime): string {
  const worktree = lane.worktree
  if (!worktree) return ''
  try {
    const dirName = `--${worktree.replace(/^\//, '').replace(/\//g, '-')}--`
    const dir = join(homedir(), '.dsh', 'sessions', dirName)
    let sessions: string[] = []
    try {
      sessions = readdirSync(dir)
    } catch {
      return ''
    }
    let maxStep = 0
    for (const sessionId of sessions) {
      let files: string[] = []
      try {
        files = readdirSync(join(dir, sessionId)).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'))
      } catch {
        continue
      }
      for (const f of files) {
        const full = join(dir, sessionId, f)
        let text = ''
        try {
          if (f.endsWith('.zstd')) {
            text = execFileSync('zstd', ['-dc', full], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: 5000 })
          } else {
            text = readFileSync(full, 'utf8')
          }
        } catch {
          continue
        }
        for (const m of text.matchAll(/"step":(\d+)/g)) {
          const n = Number(m[1])
          if (Number.isFinite(n) && n > maxStep) maxStep = n
        }
      }
    }
    return maxStep > 0 ? String(maxStep) : ''
  } catch {
    return ''
  }
}

export function registerLaneTools(ctx: { tools: { register(def: unknown): unknown } }, lane: LaneRuntime): void {
  const taskId = lane.taskDir.split(/[\\/]/).pop()!.split('-').slice(0, 2).join('-').toUpperCase()

  ctx.tools.register(defineTool({
    name: 'task_runner',
    description: 'Drive the TaskSwarm task packet: show (read PROMPT/STATUS), advance (tick the next checkbox of a step and checkpoint-commit), done (mark complete), blocked (report a blocker), amend (add an amendment), log (append an execution-log row).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['show', 'advance', 'done', 'blocked', 'amend', 'log'],
        description: 'Which task_runner operation to perform.',
      },
      step: { type: 'integer', description: 'Step index (0-based) for advance; defaults to the current step.' },
      message: { type: 'string', description: 'Message: checkpoint label for advance, blocker reason for blocked, amendment text for amend, log row for log.' },
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
      const action = args.action as string
      const message = (args.message as string | undefined) ?? ''
      try {
        switch (action) {
          case 'show': {
            const prompt = existsSync(promptFilePath(lane.taskDir)) ? readFileSync(promptFilePath(lane.taskDir), 'utf-8') : '(missing PROMPT.md)'
            const status = existsSync(taskStatusFilePath(lane.taskDir)) ? readFileSync(taskStatusFilePath(lane.taskDir), 'utf-8') : '(missing STATUS.md)'
            return { ok: true, text: `=== PROMPT.md ===\n${prompt}\n\n=== STATUS.md ===\n${status}` }
          }
          case 'advance': {
            const packet = parsePrompt(promptFilePath(lane.taskDir), lane.taskDir, '')
            if (!packet) return { ok: false, text: `cannot parse PROMPT.md at ${lane.taskDir}` }
            ensureStatusFile(packet)
            const stepIndex = args.step as number | undefined
            const step = stepIndex !== undefined
              ? packet.steps.find((s) => s.index === stepIndex)
              : packet.steps.find((s) => s.items.some((i) => !i.checked)) ?? packet.steps[packet.steps.length - 1]
            if (!step) return { ok: false, text: 'task has no steps' }
            const result = advanceStep(packet, step.index)
            const cp = checkpointCommit(lane.worktree, `taskswarm: ${taskId} advance step ${step.index} ${message ? `— ${message}` : ''}`)
            appendExecutionLog(lane.taskDir, `advance step ${step.index}`, cp.summary)
            return {
              ok: true,
              text: result.item
                ? `Checked: ${result.item} (${result.remaining} remaining in step ${step.index})`
                : `Step ${step.index} (${step.title}) complete`,
            }
          }
          case 'done': {
            markTaskDone(lane.taskDir)
            const cp = checkpointCommit(lane.worktree, `taskswarm: ${taskId} done${message ? ` — ${message}` : ''}`)
            appendExecutionLog(lane.taskDir, 'done', cp.summary)
            return { ok: true, text: `Task ${taskId} marked done. Checkpoint: ${cp.summary}` }
          }
          case 'blocked': {
            if (!message) return { ok: false, text: 'blocked requires a message (the blocker reason)' }
            setTaskStatus(lane.taskDir, 'blocked', { blockedReason: message })
            appendExecutionLog(lane.taskDir, 'blocked', message)
            writeMailboxMessage(sessionInboxDir(lane.stateRoot, lane.batchId, SUPERVISOR_SESSION), `lane-${lane.lane}`, SUPERVISOR_SESSION, 'escalate', { taskId, reason: message })
            return { ok: true, text: `Task ${taskId} marked blocked: ${message}` }
          }
          case 'amend': {
            if (!message) return { ok: false, text: 'amend requires a message' }
            appendAmendment(lane.taskDir, message)
            return { ok: true, text: 'Amendment appended to PROMPT.md' }
          }
          case 'log': {
            appendExecutionLog(lane.taskDir, 'worker', message || '—')
            return { ok: true, text: 'Log row appended' }
          }
          default:
            return { ok: false, text: `unknown action ${action}` }
        }
      } catch (err) {
        return { ok: false, text: `task_runner failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'review_step',
    description: 'Request an independent review of the current step. Spawns a reviewer agent (different model when configured) that inspects the worktree diff; writes a review file under .reviews/ and returns the verdict.',
    parameters: {
      step: { type: 'integer', required: true, description: 'Step index being reviewed.' },
      type: { type: 'string', enum: ['plan', 'code'], description: 'Review kind; defaults to code.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', required: true, enum: ['PASS', 'REVISE', 'pending'] },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `review_step: ${value.verdict} — ${value.summary}` }],
    },
    async execute(args): Promise<{ verdict: 'PASS' | 'REVISE' | 'pending'; summary: string }> {
      const step = args.step as number
      const type = (args.type as string | undefined) ?? 'code'
      const reviewsDir = join(lane.taskDir, '.reviews')
      mkdirSync(reviewsDir, { recursive: true })
      const seq = (existsSync(reviewsDir) ? readFileSync(join(reviewsDir, '.seq'), 'utf-8') : '0').trim()
      const nextSeq = Number(seq || 0) + 1
      writeFileSync(join(reviewsDir, '.seq'), String(nextSeq), 'utf-8')

      if (!lane.spawnReviewer) {
        const file = join(reviewsDir, `R${String(nextSeq).padStart(3, '0')}-${type}-step${step}.md`)
        writeFileSync(file, `# Review ${nextSeq} — ${type} step ${step}\n\n**Verdict:** pending (no reviewer configured)\n`, 'utf-8')
        return { verdict: 'pending', summary: 'no reviewer configured — recorded pending review' }
      }

      try {
        const result = await lane.spawnReviewer({ worktree: lane.worktree, taskDir: lane.taskDir, taskId, step: String(step), type })
        const file = join(reviewsDir, `R${String(nextSeq).padStart(3, '0')}-${type}-step${step}.md`)
        writeFileSync(file, `# Review ${nextSeq} — ${type} step ${step}\n\n**Verdict:** ${result.verdict}\n\n${result.summary}\n`, 'utf-8')
        appendExecutionLog(lane.taskDir, `review_step ${type} ${step}`, result.verdict)
        return { verdict: result.verdict, summary: result.summary }
      } catch (err) {
        const summary = `reviewer failed: ${err instanceof Error ? err.message : String(err)}`
        appendExecutionLog(lane.taskDir, `review_step ${type} ${step}`, summary)
        return { verdict: 'REVISE', summary }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'notify_supervisor',
    description: 'Send a progress note to the batch supervisor (written to the file mailbox).',
    parameters: {
      message: { type: 'string', required: true, description: 'Progress note text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const message = args.message as string
      // 工蜂→蜂王通知附带步数：STATUS 步数进度 + 会话累计步数，让 supervisor 一眼看到跑了多少步。
      const progress = currentStepProgress(lane.taskDir)
      const steps = workerStepCount(lane)
      const suffix = [progress && `steps ${progress}`, steps && `${steps} steps executed`].filter(Boolean).join(' · ')
      const body = suffix ? `${message}（${suffix}）` : message
      writeMailboxMessage(sessionInboxDir(lane.stateRoot, lane.batchId, SUPERVISOR_SESSION), `lane-${lane.lane}`, SUPERVISOR_SESSION, 'notify', { taskId, message: body, steps: steps || undefined, progress: progress || undefined })
      return { ok: true, text: `Notified supervisor: ${body}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'escalate_to_supervisor',
    description: 'Escalate an issue the worker cannot resolve to the batch supervisor.',
    parameters: {
      issue: { type: 'string', required: true, description: 'The issue being escalated.' },
      context: { type: 'string', description: 'Optional surrounding context.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const issue = args.issue as string
      const context = (args.context as string | undefined) ?? ''
      const progress = currentStepProgress(lane.taskDir)
      const steps = workerStepCount(lane)
      const suffix = [progress && `steps ${progress}`, steps && `${steps} steps executed`].filter(Boolean).join(' · ')
      const issueBody = suffix ? `${issue}（${suffix}）` : issue
      writeMailboxMessage(sessionInboxDir(lane.stateRoot, lane.batchId, SUPERVISOR_SESSION), `lane-${lane.lane}`, SUPERVISOR_SESSION, 'escalate', { taskId, issue: issueBody, context, steps: steps || undefined, progress: progress || undefined })
      return { ok: true, text: `Escalated to supervisor: ${issueBody}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'request_segment_expansion',
    description: 'Request that the supervisor add a segment to the dependency map (polyrepo expansion). Recorded to the mailbox; this build has no dynamic segment expansion.',
    parameters: {
      repoId: { type: 'string', required: true, description: 'Repository/segment id.' },
      description: { type: 'string', required: true, description: 'Why the segment is needed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const repoId = args.repoId as string
      const description = args.description as string
      writeMailboxMessage(sessionInboxDir(lane.stateRoot, lane.batchId, SUPERVISOR_SESSION), `lane-${lane.lane}`, SUPERVISOR_SESSION, 'request', { taskId, repoId, description })
      return { ok: true, text: `Segment expansion request recorded for ${repoId} (not supported in this build).` }
    },
  }))
}
