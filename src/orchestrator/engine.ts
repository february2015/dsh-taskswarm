/**
 * Buju engine — wave/lane execution.
 * Adapted from TaskPlane's orchestrator (waves.ts / lane-runner.ts /
 * execution.ts, github.com/HenryLach/taskplane, MIT License). Cordis-free:
 * DSH services arrive through the `WorkerHost` seam, so the engine is
 * testable without an agent loop.
 *
 * Lifecycle: plan() → run() (async, wave by wave, lanes in parallel) →
 * status() reads the durable BatchState. pause()/abort() are cooperative:
 * they take effect at wave boundaries; abort also kills running lanes via the
 * host. Task packets (PROMPT.md/STATUS.md) live in the main repo's tasks
 * root; lane worktrees are where workers make code changes.
 * @module buju/orchestrator/engine
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanTasks, resolveScope, buildWaves, type WavePlan } from '../core/discover.ts'
import { ensureStatusFile, setTaskStatus, markTaskDone, parseStatusFile, appendExecutionLog } from '../core/task.ts'
import {
  ensureOrchWorktree, createLaneWorktree, checkpointCommit, mergeLane,
  worktreePaths, removeAllLaneWorktrees, type WorktreePaths,
} from '../core/worktree.ts'
import {
  writeBatchState, readBatchState, updateLane, laneLog, latestBatch,
  type BatchState, type LaneState,
} from '../core/status.ts'
import { runGit } from '../core/git.ts'
import { SUPERVISOR_SESSION, drainInbox, sessionInboxDir, writeMailboxMessage } from '../core/mailbox.ts'
import type { WorkerHost, LaneSpec } from './worker-host.ts'

export interface EngineConfig {
  repoRoot: string
  tasksRoot: string
  stateRoot: string
  host: WorkerHost
  workerModel?: string
  reviewerModel?: string
  includeDoneTasks?: boolean
}

export interface RunHandle {
  batchId: string
}

interface RunContext {
  batchId: string
  config: EngineConfig
  paths: WorktreePaths
  paused: boolean
  aborted: boolean
}

export class BujuEngine {
  private readonly active = new Map<string, RunContext>()

  constructor(private readonly config: EngineConfig) {}

  /** Latest durable batch state, or null. */
  status(): BatchState | null {
    // Prefer the most recent active batch; fall back to the newest on disk.
    for (const id of [...this.active.keys()].reverse()) {
      const state = readBatchState(this.config.stateRoot, id)
      if (state) return state
    }
    return latestBatch(this.config.stateRoot)
  }

  /** Discover tasks and compute the wave plan for a scope. */
  plan(scope: string): { waves: WavePlan; count: number } {
    const selected = this.select(scope)
    const waves = buildWaves(selected.map((t) => t.task))
    return { waves, count: selected.length }
  }

  private select(scope: string) {
    const discovered = scanTasks(this.config.tasksRoot, this.config.includeDoneTasks ?? false)
    return resolveScope(scope, this.config.repoRoot, discovered).filter((t) => t.selected)
  }

  /**
   * Run a batch. Returns immediately with a batch id; execution continues in
   * the background. Monitor via status().
   */
  run(scope: string): RunHandle {
    const selected = this.select(scope)
    if (selected.length === 0) throw new Error('no tasks match the requested scope')
    const waves = buildWaves(selected.map((t) => t.task))
    const batchId = `b-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    const paths = worktreePaths(this.config.repoRoot, this.config.stateRoot)
    const state: BatchState = {
      id: batchId,
      repoRoot: this.config.repoRoot,
      tasksRoot: this.config.tasksRoot,
      stateRoot: this.config.stateRoot,
      phase: 'planning',
      scope,
      startedAt: new Date().toISOString(),
      waves: waves.waves.length,
      lanes: [],
    }
    let laneNumber = 0
    for (const wave of waves.waves) {
      for (const task of wave) {
        laneNumber++
        state.lanes.push({ lane: laneNumber, taskId: task.id, phase: 'pending', log: [] })
      }
    }
    writeBatchState(state)
    const ctx: RunContext = { batchId, config: this.config, paths, paused: false, aborted: false }
    this.active.set(batchId, ctx)
    void this.execute(ctx, waves, state).finally(() => this.active.delete(batchId))
    return { batchId }
  }

  private async execute(ctx: RunContext, waves: WavePlan, state: BatchState): Promise<void> {
    const { config, paths, batchId } = ctx
    state.phase = 'running'
    writeBatchState(state)

    const orch = ensureOrchWorktree(config.repoRoot, paths)
    if (!orch.ok) {
      state.phase = 'aborted'
      writeBatchState(state)
      return
    }

    for (const wave of waves.waves) {
      while (ctx.paused && !ctx.aborted) await sleep(250)
      if (ctx.aborted) {
        state.phase = 'aborted'
        writeBatchState(state)
        return
      }
      const lanes = await Promise.all(wave.map((task) => this.runLane(ctx, state, task)))
      for (const lane of lanes) {
        const index = state.lanes.findIndex((l) => l.taskId === lane.taskId)
        if (index >= 0) state.lanes[index] = lane
      }
      writeBatchState(state)
    }

    state.phase = ctx.aborted ? 'aborted' : 'complete'
    state.endedAt = new Date().toISOString()
    writeBatchState(state)
    const supervisorInbox = sessionInboxDir(config.stateRoot, batchId, SUPERVISOR_SESSION)
    writeMailboxMessage(supervisorInbox, 'engine', SUPERVISOR_SESSION, 'notify', { batchId, phase: state.phase })
    void drainInbox(supervisorInbox)
  }

  /** Run one lane: worktree → status → worker → review → merge. */
  private async runLane(ctx: RunContext, state: BatchState, task: WavePlan['tasks'][number]): Promise<LaneState> {
    const { config, paths, batchId } = ctx
    const existing = state.lanes.find((l) => l.taskId === task.id)
    const lane: LaneState = {
      lane: existing?.lane ?? state.lanes.length + 1,
      taskId: task.id,
      phase: 'running',
      startedAt: new Date().toISOString(),
      log: [`starting ${task.id}`],
    }
    writeBatchState(state)

    ensureStatusFile(task)
    setTaskStatus(task.folder, 'running')
    appendExecutionLog(task.folder, 'Lane started', `lane ${lane.lane}`)

    const wt = createLaneWorktree(config.repoRoot, paths, task.id)
    if (!wt) {
      lane.phase = 'failed'
      lane.error = 'could not create lane worktree'
      updateLane(state.stateRoot, batchId, lane)
      return lane
    }
    lane.worktree = wt.dir
    updateLane(state.stateRoot, batchId, lane)

    const spec: LaneSpec = {
      lane: lane.lane,
      task,
      worktree: wt.dir,
      batchId,
      stateRoot: config.stateRoot,
      repoRoot: config.repoRoot,
      model: config.workerModel,
      reviewerModel: config.reviewerModel,
    }

    const result = await config.host.spawn(spec)
    lane.exitCode = result.exitCode
    if (result.error) lane.error = result.error
    laneLog(lane, `worker exited ${result.exitCode}${result.error ? ` (${result.error})` : ''}`)

    checkpointCommit(wt.dir, `buju: ${task.id} worker exit`)
    const verdict = this.readLatestVerdict(task.folder)
    lane.reviewVerdict = verdict

    const taskStatus = parseStatusFile(task.folder)
    const workerFailed = result.exitCode !== 0
    const notFinished = taskStatus.status !== 'done' && taskStatus.status !== 'blocked'
    if (workerFailed || notFinished) {
      lane.phase = 'failed'
      lane.error = lane.error ?? (workerFailed ? `worker exited ${result.exitCode}` : 'task not marked done')
    } else if (verdict === 'REVISE') {
      lane.phase = 'review'
      lane.error = 'reviewer requested revisions'
    } else {
      lane.phase = 'merged'
      markTaskDone(task.folder)
      const merged = mergeLane(config.repoRoot, paths, wt)
      if (!merged.ok) {
        lane.phase = 'failed'
        lane.error = `merge failed: ${merged.stderr.slice(0, 200)}`
      }
    }
    lane.endedAt = new Date().toISOString()
    laneLog(lane, `lane ${lane.phase}`)
    updateLane(state.stateRoot, batchId, lane)
    return lane
  }

  private readLatestVerdict(taskFolder: string): 'PASS' | 'REVISE' | 'none' {
    const reviewsDir = join(taskFolder, '.reviews')
    if (!existsSync(reviewsDir)) return 'none'
    const files = readdirSync(reviewsDir).filter((f) => f.endsWith('.md')).sort()
    if (files.length === 0) return 'none'
    const latest = readFileSync(join(reviewsDir, files[files.length - 1]!), 'utf-8')
    if (latest.includes('REVISE')) return 'REVISE'
    if (latest.includes('PASS')) return 'PASS'
    return 'none'
  }

  /** Pause after the current wave (cooperative). */
  pause(): boolean {
    const ctx = this.activeContext()
    if (!ctx) return false
    ctx.paused = true
    const state = readBatchState(this.config.stateRoot, ctx.batchId)
    if (state) {
      state.phase = 'paused'
      writeBatchState(state)
    }
    return true
  }

  /** Resume a paused batch. */
  resume(): boolean {
    const ctx = this.activeContext()
    if (!ctx) return false
    ctx.paused = false
    const state = readBatchState(this.config.stateRoot, ctx.batchId)
    if (state) {
      state.phase = 'running'
      writeBatchState(state)
    }
    return true
  }

  /** Abort: stop after the current wave and kill running lanes. */
  abort(): boolean {
    const ctx = this.activeContext()
    if (!ctx) return false
    ctx.aborted = true
    const state = readBatchState(this.config.stateRoot, ctx.batchId)
    if (state) {
      state.phase = 'aborted'
      writeBatchState(state)
    }
    ctx.config.host.abort?.(-1)
    removeAllLaneWorktrees(ctx.config.repoRoot, ctx.paths)
    return true
  }

  /** Merge the orch branch into the current branch (integration). */
  integrate(): { ok: boolean; message: string } {
    const result = runGit(['merge', '--no-edit', 'buju/orch'], this.config.repoRoot)
    return result.ok ? { ok: true, message: result.stdout } : { ok: false, message: result.stderr }
  }

  private activeContext(): RunContext | undefined {
    if (this.active.size === 0) return undefined
    return [...this.active.values()].pop()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
