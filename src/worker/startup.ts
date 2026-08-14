/**
 * TaskSwarm worker startup provider — publishes the lane environment as a Cordis
 * service. The worker runner consumes it; values come from environment
 * variables set by the orchestrator's HeadlessWorkerHost.
 * Mirrors `@deepseek-ai/dsh-headless/startup` (DeepSeek Harness, MIT).
 * @module taskswarm/worker/startup
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'taskswarm-worker-startup'

/** Service provided by this plugin and injected by the worker runner. */
export const TASKSWARM_WORKER_STARTUP_SERVICE = 'taskswarmWorkerStartup'

export interface TaskSwarmWorkerStartupValues {
  taskDir: string
  worktree: string
  batchId: string
  stateRoot: string
  repoRoot: string
  lane: number
  model?: string
  reviewerModel?: string
}

function env(name: string): string {
  return process.env[name] ?? ''
}

export function apply(ctx: Context): void {
  const lane = Number(env('TASKSWARM_WORKER_LANE'))
  const startup: TaskSwarmWorkerStartupValues = {
    taskDir: env('TASKSWARM_WORKER_TASK_DIR'),
    worktree: env('TASKSWARM_WORKER_WORKTREE'),
    batchId: env('TASKSWARM_WORKER_BATCH_ID'),
    stateRoot: env('TASKSWARM_WORKER_STATE_ROOT'),
    repoRoot: env('TASKSWARM_WORKER_REPO_ROOT'),
    lane: Number.isFinite(lane) && lane > 0 ? lane : 1,
    ...(env('TASKSWARM_WORKER_MODEL') ? { model: env('TASKSWARM_WORKER_MODEL') } : {}),
    ...(env('TASKSWARM_WORKER_REVIEWER_MODEL') ? { reviewerModel: env('TASKSWARM_WORKER_REVIEWER_MODEL') } : {}),
  }
  ctx.provide(TASKSWARM_WORKER_STARTUP_SERVICE, startup)
}
