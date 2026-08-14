/**
 * TaskSwarm engine — wave/lane execution.
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
 * @module taskswarm/orchestrator/engine
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanTasks, resolveScope, buildWaves, type WavePlan } from '../core/discover.ts'
import { ensureStatusFile, setTaskStatus, markTaskDone, parseStatusFile, appendExecutionLog, scaffoldTask } from '../core/task.ts'
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
import type { WorkerHost, LaneSpec, WorkerResult } from './worker-host.ts'

export interface TaskSwarmEvent {
  type: 'batch-started' | 'lane-done' | 'lane-failed' | 'lane-revise' | 'wave-complete' | 'batch-complete' | 'batch-aborted'
  batchId: string
  /** Present on lane events. */
  lane?: number
  taskId?: string
  phase?: string
  error?: string
  /** Present on wave events. */
  waveIndex?: number
  totalWaves?: number
  /** Present on wave/batch events. */
  merged?: number
  failed?: number
  total?: number
}

export interface EngineConfig {
  repoRoot: string
  tasksRoot: string
  stateRoot: string
  host: WorkerHost
  workerModel?: string
  reviewerModel?: string
  includeDoneTasks?: boolean
  /** 单 lane 看门狗超时（分钟）：worker 超过该时长无完成事件 → 强制结束该 lane（failed，
   *  worktree/分支保留可排查），避免失联 worker 永久卡住当前 wave（KI-007 方案 B）。
   *  0/缺省 = 不启用（不建议，会退回"只能重启引擎"的假死状态）。 */
  laneTimeoutMinutes?: number
  /** Structured batch-lifecycle events + the owning session agent (who started the batch). */
  onEvent?: (event: TaskSwarmEvent, owner?: unknown) => void
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

export class TaskSwarmEngine {
  private readonly active = new Map<string, RunContext>()
  /** batchId → 发起该 batch 的会话 agent（事件只回发给它，避免跨会话串消息）。 */
  private readonly batchOwners = new Map<string, unknown>()

  constructor(private readonly config: EngineConfig) {}

  /** Fire a structured lifecycle event through the configured hook (non-fatal). */
  private emit(event: TaskSwarmEvent): void {
    try {
      this.config.onEvent?.(event, this.batchOwners.get(event.batchId))
    } catch {
      // A failing event consumer must never break batch execution.
    }
  }

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
   * 自动初始化兜底：任务包为空（all/空 scope）时，从包内模板 scaffold 两个示例任务，
   * 让"启动"永不因空项目失败。用户无需知道"初始化"这一内部动作。
   * @returns 本次实际新建的任务数。
   */
  private autoInitIfEmpty(scope: string): number {
    const trimmed = (scope || 'all').trim()
    if (trimmed !== '' && trimmed !== 'all') return 0 // 显式 scope 不做自动初始化
    if (scanTasks(this.config.tasksRoot, true).length > 0) return 0 // 已有任务包
    const templatesDir = fileURLToPath(new URL('../../templates/tasks/', import.meta.url))
    mkdirSync(this.config.tasksRoot, { recursive: true })
    const create = (templateName: string, id: string, slug: string): string | null =>
      scaffoldTask(this.config.tasksRoot, join(templatesDir, templateName), id, slug)
    const a = create('EXAMPLE-001-hello-world', 'EXAMPLE-001', 'hello-world')
    const b = create('EXAMPLE-002-parallel-smoke', 'EXAMPLE-002', 'parallel-smoke')
    return [a, b].filter(Boolean).length
  }

  /**
   * Run a batch. Returns immediately with a batch id; execution continues in
   * the background. Monitor via status().
   */
  run(scope: string, owner?: unknown): RunHandle {
    const initialized = this.autoInitIfEmpty(scope)
    const selected = this.select(scope)
    if (selected.length === 0) throw new Error('no tasks match the requested scope')
    const waves = buildWaves(selected.map((t) => t.task))
    const batchId = `b-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    this.batchOwners.set(batchId, owner)
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
    this.emit({
      type: 'batch-started',
      batchId,
      total: selected.length,
      taskId: scope,
    })
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

    for (const [waveIndex, wave] of waves.waves.entries()) {
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
      // Wave boundary report (supervisor wakes on wave-complete, not lane-done).
      this.emit({
        type: 'wave-complete',
        batchId,
        waveIndex: waveIndex + 1,
        totalWaves: waves.waves.length,
        merged: lanes.filter((l) => l.phase === 'merged').length,
        failed: lanes.filter((l) => l.phase === 'failed').length,
        total: lanes.length,
      })
    }

    state.phase = ctx.aborted ? 'aborted' : 'complete'
    state.endedAt = new Date().toISOString()
    writeBatchState(state)
    const done = state.lanes.filter((l) => l.phase === 'merged').length
    const failed = state.lanes.filter((l) => l.phase === 'failed').length
    this.emit({
      type: state.phase === 'aborted' ? 'batch-aborted' : 'batch-complete',
      batchId,
      phase: state.phase,
      merged: done,
      failed,
      total: state.lanes.length,
    })
    const supervisorInbox = sessionInboxDir(config.stateRoot, batchId, SUPERVISOR_SESSION)
    writeMailboxMessage(supervisorInbox, 'engine', SUPERVISOR_SESSION, 'notify', { batchId, phase: state.phase })
    void drainInbox(supervisorInbox)
  }

  /** Run one lane: worktree → status → worker → review → merge. */
  private async runLane(ctx: RunContext, state: BatchState, task: WavePlan['tasks'][number]): Promise<LaneState> {
    const { config, paths, batchId } = ctx
    const existing = state.lanes.find((l) => l.taskId === task.id)
    // 方案 A（KI-007）：续跑/恢复时跳过已完成 lane（磁盘状态为准，防止重跑已 merged/failed 任务）。
    if (existing && (existing.phase === 'merged' || existing.phase === 'failed')) {
      laneLog(existing, `skipped (already ${existing.phase})`)
      return existing
    }
    const lane: LaneState = {
      lane: existing?.lane ?? state.lanes.length + 1,
      taskId: task.id,
      phase: 'running',
      startedAt: new Date().toISOString(),
      log: [`starting ${task.id}`],
    }
    // NOTE: no `writeBatchState(state)` here — `state.lanes` still holds the
    // planning snapshot for sibling lanes, so a full-state write from a
    // concurrent runLane clobbers their updateLane() disk writes (KI-003).
    // Persistence for this lane goes through updateLane() below, which is a
    // single-lane targeted write and race-free.

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

    const result = await this.runLaneWorker(ctx, lane, spec)
    lane.exitCode = result.exitCode
    if (result.error) lane.error = result.error
    laneLog(lane, `worker exited ${result.exitCode}${result.error ? ` (${result.error})` : ''}`)

    checkpointCommit(wt.dir, `taskswarm: ${task.id} worker exit`)
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
    this.emit({
      type: lane.phase === 'merged'
        ? 'lane-done'
        : lane.phase === 'review'
          ? 'lane-revise'
          : 'lane-failed',
      batchId,
      lane: lane.lane,
      taskId: task.id,
      phase: lane.phase,
      ...(lane.error ? { error: lane.error.slice(0, 300) } : {}),
    })
    return lane
  }

  /** Spawn a lane worker under a watchdog timeout (KI-007 方案 B).
   *  worker 失联/事件丢失时 `host.spawn()` 的 await 永不返回，会把 execute() 卡死在当前
   *  wave、后续 wave 永不启动（此前只能靠重启引擎恢复）。超时后 abort worker 并返回
   *  failed 结果，runLane 正常收尾，wave 继续推进。 */
  private async runLaneWorker(ctx: RunContext, lane: LaneState, spec: LaneSpec): Promise<WorkerResult> {
    const { config } = ctx
    const timeoutMin = config.laneTimeoutMinutes ?? 0
    if (!(timeoutMin > 0)) return config.host.spawn(spec)

    const timeoutMs = timeoutMin * 60_000
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<WorkerResult>((resolve) => {
      timer = setTimeout(() => {
        // 看门狗触发前先查磁盘：若该 lane 已被手动收尾（supervisor 标记 merged/failed、
        // 代码已并入分支），则跳过不覆盖——避免看门狗把已完成的 lane 误标 failed
        // （2026-08-14 JM-334 实测：手动收尾后 90 分钟超时仍覆盖为 failed）。
        try {
          const disk = readBatchState(config.stateRoot, ctx.batchId)
          const dl = disk?.lanes?.find((x) => x.taskId === spec.task.id)
          if (dl && (dl.phase === 'merged' || dl.phase === 'failed')) {
            laneLog(lane, `watchdog skipped (lane already ${dl.phase} on disk — manual finalize)`)
            resolve({ exitCode: 0, text: '', error: undefined })
            return
          }
        } catch {
          // 磁盘不可读时按常规超时处理
        }
        // 先 abort 僵尸 worker，再以 failed 收尾（worktree/分支保留供排查）。
        try {
          config.host.abort?.(spec.lane)
        } catch {
          // best-effort
        }
        laneLog(lane, `lane timeout after ${timeoutMin} min (watchdog)`)
        resolve({ exitCode: 1, text: '', error: `lane timeout after ${timeoutMin} min（worker 无完成事件，看门狗强制结束；检查点保留在 taskswarm/${spec.task.id} 分支）` })
      }, timeoutMs)
    })
    try {
      return await Promise.race([config.host.spawn(spec), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
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
    if (ctx) {
      ctx.paused = false
      const state = readBatchState(this.config.stateRoot, ctx.batchId)
      if (state) {
        state.phase = 'running'
        writeBatchState(state)
      }
      return true
    }
    // 引擎重启后 active 为空：从磁盘恢复未完成批次续跑（方案 A，KI-007）。
    // 已 merged/failed 的 lane 由 runLane 跳过；剩余 pending 任务按新 wave plan 继续。
    return this.recoverPendingBatch()
  }

  /**
   * 方案 A（KI-007）：引擎重启/崩溃后，把磁盘上 phase ∈ running/planning/paused 的
   * 批次重新挂回执行（跳过已完成 lane）。这样失联/重启不再需要手动开新批次重排剩余任务。
   */
  private recoverPendingBatch(): boolean {
    const state = latestBatch(this.config.stateRoot)
    if (!state) return false
    if (state.phase !== 'running' && state.phase !== 'planning' && state.phase !== 'paused') return false
    if (this.active.has(state.id)) return false
    // select() 默认排除已 done 任务（.DONE 标记）→ wave plan 只含剩余任务。
    const selected = this.select(state.scope)
    if (selected.length === 0) return false
    const waves = buildWaves(selected.map((t) => t.task))
    const paths = worktreePaths(this.config.repoRoot, this.config.stateRoot)
    const ctx: RunContext = { batchId: state.id, config: this.config, paths, paused: false, aborted: false }
    this.active.set(state.id, ctx)
    void this.execute(ctx, waves, state).finally(() => this.active.delete(state.id))
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
    const result = runGit(['merge', '--no-edit', 'taskswarm/orch'], this.config.repoRoot)
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
