/**
 * Buju worker startup provider — publishes the lane environment as a Cordis
 * service. The worker runner consumes it; values come from environment
 * variables set by the orchestrator's HeadlessWorkerHost.
 * Mirrors `@deepseek-ai/dsh-headless/startup` (DeepSeek Harness, MIT).
 * @module buju/worker/startup
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'buju-worker-startup'

/** Service provided by this plugin and injected by the worker runner. */
export const BUJU_WORKER_STARTUP_SERVICE = 'bujuWorkerStartup'

export interface BujuWorkerStartupValues {
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
  const lane = Number(env('BUJU_WORKER_LANE'))
  const startup: BujuWorkerStartupValues = {
    taskDir: env('BUJU_WORKER_TASK_DIR'),
    worktree: env('BUJU_WORKER_WORKTREE'),
    batchId: env('BUJU_WORKER_BATCH_ID'),
    stateRoot: env('BUJU_WORKER_STATE_ROOT'),
    repoRoot: env('BUJU_WORKER_REPO_ROOT'),
    lane: Number.isFinite(lane) && lane > 0 ? lane : 1,
    ...(env('BUJU_WORKER_MODEL') ? { model: env('BUJU_WORKER_MODEL') } : {}),
    ...(env('BUJU_WORKER_REVIEWER_MODEL') ? { reviewerModel: env('BUJU_WORKER_REVIEWER_MODEL') } : {}),
  }
  ctx.provide(BUJU_WORKER_STARTUP_SERVICE, startup)
}
