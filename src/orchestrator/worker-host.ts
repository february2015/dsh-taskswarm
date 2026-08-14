/**
 * Worker host — how a lane's worker agent gets created and driven.
 * Replaces TaskPlane's `spawnAgent()` (which spawned `pi --mode rpc`
 * subprocesses) with DSH-native backends:
 *
 *   - `in-process` (default): `ctx.agents.create()` inside the orchestrator
 *     process, per-agent cwd = lane worktree, bridge tools registered on the
 *     agent's scoped context.
 *   - `headless`: spawn `dsh --profile taskswarm-worker <mission>` as a child
 *     process with the lane environment (worktree cwd, mailbox, state root).
 *     The `taskswarm-worker` profile composes dsh-base + the worker bundle.
 * @module taskswarm/orchestrator/worker-host
 */
import { spawn } from 'node:child_process'
import type { TaskPacket } from '../core/task.ts'
import { ORCH_BRANCH } from '../core/worktree.ts'

export interface LaneSpec {
  lane: number
  task: TaskPacket
  worktree: string
  batchId: string
  stateRoot: string
  repoRoot: string
  model?: string
  reviewerModel?: string
  /** Extra environment for headless workers. */
  env?: Record<string, string>
}

export interface WorkerResult {
  exitCode: number
  text: string
  error?: string
}

export interface WorkerHost {
  readonly kind: string
  spawn(spec: LaneSpec): Promise<WorkerResult>
  /** Best-effort cancel of a running lane (abort). */
  abort?(lane: number): void
}

/**
 * Backend that shells out to a `dsh --profile taskswarm-worker` process per lane.
 * The worker bundle (taskswarm/worker) provides startup + runner + bridge tools.
 */
export class HeadlessWorkerHost implements WorkerHost {
  readonly kind = 'headless'
  private readonly dshBin: string
  private readonly profile: string
  private readonly running = new Map<number, ReturnType<typeof spawn> | undefined>()

  constructor(options: { dshBin?: string; profile?: string } = {}) {
    this.dshBin = options.dshBin ?? 'dsh'
    this.profile = options.profile ?? 'taskswarm-worker'
  }

  spawn(spec: LaneSpec): Promise<WorkerResult> {
    const mission = [
      `You are a TaskSwarm worker (lane ${spec.lane}) executing task ${spec.task.id} in an isolated git worktree.`,
      `Use the task_runner tool to drive steps (show/advance/done), review_step at step boundaries,`,
      `and notify_supervisor / escalate_to_supervisor to talk to the supervisor.`,
      `Worktree: ${spec.worktree}. Task folder: ${spec.task.folder}.`,
    ].join(' ')

    return new Promise<WorkerResult>((resolve) => {
      const env: Record<string, string> = {
        ...process.env,
        TASKSWARM_WORKER_TASK_DIR: spec.task.folder,
        TASKSWARM_WORKER_WORKTREE: spec.worktree,
        TASKSWARM_WORKER_BATCH_ID: spec.batchId,
        TASKSWARM_WORKER_STATE_ROOT: spec.stateRoot,
        TASKSWARM_WORKER_LANE: String(spec.lane),
        TASKSWARM_WORKER_REPO_ROOT: spec.repoRoot,
        ...(spec.model ? { TASKSWARM_WORKER_MODEL: spec.model } : {}),
        ...(spec.reviewerModel ? { TASKSWARM_WORKER_REVIEWER_MODEL: spec.reviewerModel } : {}),
        ...(spec.env ?? {}),
      }
      const proc = spawn(this.dshBin, ['--profile', this.profile, mission], {
        cwd: spec.worktree,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: false,
      })
      this.running.set(spec.lane, proc)
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on('error', (err) => {
        this.running.delete(spec.lane)
        resolve({ exitCode: 1, text: '', error: `spawn dsh failed: ${err.message}` })
      })
      proc.on('close', (code) => {
        this.running.delete(spec.lane)
        const text = stdout.trim()
        resolve({ exitCode: code ?? 1, text, error: stderr.trim() ? stderr.trim() : undefined })
      })
    })
  }

  abort(lane: number): void {
    const proc = this.running.get(lane)
    if (proc) proc.kill('SIGTERM')
  }
}

/** Convenience alias so callers don't depend on the branch constant. */
export { ORCH_BRANCH }
