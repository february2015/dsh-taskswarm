/**
 * Demo runner — boots inside a real `dsh --profile` composition and runs a
 * full Buju batch against a scratch git repo with a non-LLM lane host,
 * printing the batch status. Purpose: verify the plugin mounts and the engine
 * runs end-to-end inside a genuine DSH process (no GUI, no LLM needed).
 *
 * Sandbox profile: bundles [dsh-base, dsh-buju], patch inserts
 * `- id: buju-demo-runner, name: 'dsh-buju/demo'`.
 * @module buju/demo
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BujuEngine } from './orchestrator/engine.ts'
import { runGit } from './core/git.ts'
import { checkpointCommit } from './core/worktree.ts'
import { markTaskDone } from './core/task.ts'
import { formatBatchStatus, type BatchState } from './core/status.ts'
import type { LaneSpec, WorkerHost, WorkerResult } from './orchestrator/worker-host.ts'

export const name = 'buju-demo-runner'
export const inject: string[] = []

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Non-LLM lane host: writes a file, checkpoint-commits, marks the task done. */
class DemoWorkerHost implements WorkerHost {
  readonly kind = 'demo'
  async spawn(spec: LaneSpec): Promise<WorkerResult> {
    await sleep(300)
    writeFileSync(join(spec.worktree, `${spec.task.id}.txt`), `${spec.task.id} done\n`, 'utf-8')
    checkpointCommit(spec.worktree, `feat(${spec.task.id}): demo worker`)
    markTaskDone(spec.task.folder)
    return { exitCode: 0, text: `${spec.task.id} complete` }
  }
}

function writeTask(tasksRoot: string, id: string, name: string, deps: string[]): void {
  const dir = join(tasksRoot, `${id}-${name.toLowerCase()}`)
  mkdirSync(dir, { recursive: true })
  const prompt = [
    `# Task: ${id} — ${name}`,
    '',
    '**Size:** S',
    '',
    '## Dependencies',
    ...(deps.length ? deps.map((d) => `- ${d}`) : ['- **None**']),
    '',
    '## Mission',
    `Create ${id}.txt with content "${id} done".`,
    '',
    '## File Scope',
    `- ${id}.txt`,
    '',
    '## Steps',
    '',
    '### Step 0: Work',
    '',
    `- [ ] Create ${id}.txt`,
    '',
    '### Step 1: Delivery',
    '',
    `- [ ] Mark ${id} done`,
    '',
    '## Completion Criteria',
    '',
    `- [ ] ${id}.txt exists`,
    '',
    '---',
  ].join('\n')
  writeFileSync(join(dir, 'PROMPT.md'), prompt, 'utf-8')
  writeFileSync(join(dir, 'STATUS.md'), `# ${id}: ${name} — Status\n\n**Status:** 🔵 Ready for Execution\n**Current Step:** Not Started\n`, 'utf-8')
}

async function runDemo(ctx: Context, exit: (code: number) => void): Promise<void> {
  await ctx.get('loader')?.await()
  const root = mkdtempSync(join(tmpdir(), 'buju-demo-'))
  try {
    runGit(['init', '-q'], root)
    runGit(['config', 'user.email', 'demo@buju.local'], root)
    runGit(['config', 'user.name', 'demo'], root)
    writeFileSync(join(root, 'README.md'), '# buju demo\n', 'utf-8')
    runGit(['add', '-A'], root)
    runGit(['commit', '-m', 'init'], root)

    const tasksRoot = join(root, 'tasks')
    writeTask(tasksRoot, 'A-001', 'Alpha', [])
    writeTask(tasksRoot, 'B-002', 'Beta', [])
    writeTask(tasksRoot, 'C-003', 'Gamma', ['A-001'])

    const engine = new BujuEngine({
      repoRoot: root,
      tasksRoot,
      stateRoot: join(root, '.buju'),
      host: new DemoWorkerHost(),
    })
    const plan = engine.plan('all')
    console.log(`Buju demo: ${plan.count} tasks in ${plan.waves.waves.length} waves`)
    engine.run('all')

    const deadline = Date.now() + 30_000
    let state: BatchState | null = engine.status()
    while (state && (state.phase === 'running' || state.phase === 'planning')) {
      if (Date.now() > deadline) break
      await sleep(200)
      state = engine.status()
    }
    console.log('=== Buju batch status ===')
    console.log(state ? formatBatchStatus(state) : '(no batch state)')

    // Command plane: execute the /orch-family commands through the real
    // ctx.commands service with a real (but not LLM-driven) agent.
    try {
      const agents = ctx.get('agents') as {
        create(options: unknown): Promise<{ agent: { session: { meta: { cwd?: string } } } }>
      } | undefined
      const defaultModel = ctx.get('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } } | undefined
      const commands = ctx.get('commands') as
        | { execute(agent: unknown, line: string, signal: AbortSignal): Promise<unknown> } | undefined
      if (agents && defaultModel && commands) {
        const selection = defaultModel.currentSelection()
        const { agent } = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: root },
          agentOptions: { provider: selection.provider, model: selection.model },
        })
        console.log(`(agent session meta: ${JSON.stringify((agent as unknown as { session: { meta?: unknown } }).session.meta)})`)
        console.log('=== Command plane (real ctx.commands) ===')
        for (const line of ['/buju-init', '/orch-plan', '/orch-status']) {
          const execution = await commands.execute(agent, line, new AbortController().signal) as
            | { result?: { kind: string; text: string } } | undefined
          const result = execution?.result
          console.log(`$ ${line}`)
          console.log(result ? `${result.kind}: ${result.text}` : '(no result)')
        }

        // Real /orch with LLM-backed workers (needs DEEPSEEK_API_KEY in env).
        try {
          console.log('=== /orch all (real LLM workers) ===')
          const startExecution = await commands.execute(agent, '/orch all', new AbortController().signal) as
            | { result?: { kind: string; text: string } } | undefined
          const startResult = startExecution?.result
          console.log(startResult ? `${startResult.kind}: ${startResult.text}` : '(no result)')
          const deadline = Date.now() + 150_000
          let live = engine.status()
          while (live && (live.phase === 'running' || live.phase === 'planning')) {
            if (Date.now() > deadline) break
            await sleep(1000)
            live = engine.status()
          }
          console.log('--- final /orch-status ---')
          console.log(live ? formatBatchStatus(live) : '(no state)')
          exit(live?.phase === 'complete' ? 0 : 1)
          return
        } catch (err) {
          console.log(`(/orch skipped: ${err instanceof Error ? err.message : String(err)})`)
        }
      } else {
        console.log('(command plane skipped: agents/agentDefaultModel/commands not all present)')
      }
    } catch (err) {
      console.log(`(command plane skipped: ${err instanceof Error ? err.message : String(err)})`)
    }

    exit(state?.phase === 'complete' ? 0 : 1)
  } catch (err) {
    console.error(`buju-demo failed: ${err instanceof Error ? err.message : String(err)}`)
    rmSync(root, { recursive: true, force: true })
    exit(1)
  }
}

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) {
    console.error('buju-demo-runner: launcher must provide ctx.appExit')
    process.exit(1)
    return
  }
  void runDemo(ctx, exit)
}
