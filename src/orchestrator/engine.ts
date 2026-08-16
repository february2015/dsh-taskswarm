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
import { ensureStatusFile, ensureStatusStructure, setTaskStatus, markTaskRunning, markTaskDone, parseStatusFile, appendExecutionLog, scaffoldTask } from '../core/task.ts'
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
import type { MergeResult } from '../worker/merger.ts'
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
  /** Present on wave events with unresolved merge conflicts (B3#3). */
  conflict?: number
  total?: number
}

export interface EngineConfig {
  repoRoot: string
  tasksRoot: string
  stateRoot: string
  host: WorkerHost
  workerModel?: string
  reviewerModel?: string
  /** LLM merge agent 用的模型（独立 reviewer/merger 路由，默认跟随当前会话模型）。 */
  mergerModel?: string
  /** Merge 完成后运行的验证命令（P2：merge verify，如 ["npm test"]）。 */
  mergeVerifyCommands?: string[]
  /** LLM merge agent 看门狗超时（分钟）：卡住无结果 → 超时返回 unresolved 保留现场
   *  （只报告不杀——不阻塞后续 merge 队列，agent 会话由 spawner 的 finally 收尾）。
   *  默认 10（借鉴 TaskPlane merge.timeout_minutes）。0 = 不启用。 */
  mergerTimeoutMinutes?: number
  /** 波次内出现 failed lane 时，该波其余 lane 跑完后自动暂停批次等 supervisor 处置
   *  （默认 true——失败不能直接滚到下一 wave）。 */
  pauseOnLaneFailure?: boolean
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
  /** 由 abort() resolve；runLaneWorker 用它立即中断在途 worker/merger await。 */
  abortWaiter?: Promise<void>
  resolveAbort?: () => void
  /** per-lane 停止信号：stopLane(taskId) 对指定 lane resolve，runLaneWorker 立即中断
   *  （主动停掉卡住的 lane，不等看门狗超时）。key = lane number。 */
  laneStopWaiters: Map<number, Promise<void>>
  laneStopResolvers: Map<number, () => void>
}

export class TaskSwarmEngine {
  private readonly active = new Map<string, RunContext>()
  /** batchId → 发起该 batch 的会话 agent（事件只回发给它，避免跨会话串消息）。 */
  private readonly batchOwners = new Map<string, unknown>()
  /** pauseOnLaneFailure 暂停的批次 id：resume 时应跳过 failed lane（丢弃），而非重跑。
   *  与"崩溃恢复"的 paused 批次区分——后者 failed lane 需重跑续接（KI-007）。 */
  private pausedOnFailureBatch: string | null = null
  /**
   * Merge mutex：同一 wave 的多个 lane 并行完成，但 orch worktree 的
   * `git merge` 必须串行——并发 merge 会被 git 锁拒绝（stderr 为空，
   * "another git process seems to be running" 类错误）。用 promise 链
   * 把每个 lane 的 merge（含 merger agent 解决）串起来。
   */
  private mergeQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly config: EngineConfig) {}

  /** 串行化 orch merge：排队执行 fn，前面的 merge 完成后再跑下一个。 */
  private serializedMerge<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mergeQueue.then(fn, fn)
    // 链上保持"最终值"而非"结果"，避免 reject 打断后续排队。
    this.mergeQueue = next.catch(() => undefined)
    return next
  }

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

  /** 暴露当前仍在运行中的批次快照（供其它插件如 dsh-dingo 读取）。 */
  activeBatches(): Array<{
    batchId: string
    phase: string
    lanes: Array<{ lane: number; taskId: string; phase: string }>
    ownerSessionId?: string
  }> {
    const result: Array<{
      batchId: string
      phase: string
      lanes: Array<{ lane: number; taskId: string; phase: string }>
      ownerSessionId?: string
    }> = []
    for (const [batchId, ctx] of this.active) {
      if (ctx.aborted) continue
      const state = readBatchState(this.config.stateRoot, batchId)
      if (!state) continue
      const owner = this.batchOwners.get(batchId) as { session?: { id?: string } } | undefined
      result.push({
        batchId,
        phase: state.phase,
        lanes: state.lanes.map((lane) => ({ lane: lane.lane, taskId: lane.taskId, phase: lane.phase })),
        ownerSessionId: owner?.session?.id,
      })
    }
    return result
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
   * 并发保护（2026-08-15，bug-batch-state-write 报告次因）：本实例仍有**未 abort** 的
   * execute 上下文时拒绝启动新批次——否则新旧批次并发跑在同一个 TaskSwarmEngine 实例上，
   * 共用 worktree 路径与 task 目录，互相覆盖。已 abort 的 ctx 允许立刻 start：abort 已
   * resolveAbort() 中断在途 await，旧 execute 快速收尾（runLane 有 abort 检查、updateLane
   * 有终态防御，不会写旧文件/建新 worktree）。
   */
  run(scope: string, owner?: unknown): RunHandle {
    const live = [...this.active.values()].filter((c) => !c.aborted)
    if (live.length > 0) {
      const who = live.map((c) => c.batchId).join(', ')
      throw new Error(`another batch is still running (${who}); abort it first or resume the existing one`)
    }
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
    const ctx = this.makeRunContext(batchId, paths)
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

  /** 构造带 abort waiter 的 RunContext（abort 时 resolveAbort() 可中断在途 await）。 */
  private makeRunContext(batchId: string, paths: WorktreePaths): RunContext {
    let resolveAbort: (() => void) | undefined
    const abortWaiter = new Promise<void>((resolve) => { resolveAbort = resolve })
    return {
      batchId, config: this.config, paths, paused: false, aborted: false,
      abortWaiter, resolveAbort,
      laneStopWaiters: new Map(), laneStopResolvers: new Map(),
    }
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
      // 2026-08-15（bug-batch-state-write）：波次写回前尊重磁盘终态——abort() 在波次
      // 执行途中把磁盘 phase 写成 aborted，这里用内存里陈旧的 'running' 整份覆盖会
      // 复活终态批次（mtime 变化 + updateLane 终态防御失效）。磁盘已终态则直接返回，
      // 不再写盘（aborted 文件不该被续写任何内容）。
      const diskState = readBatchState(config.stateRoot, batchId)
      if (diskState && (diskState.phase === 'aborted' || diskState.phase === 'complete')) {
        return
      }
      writeBatchState(state)
      // Wave boundary report (supervisor wakes on wave-complete, not lane-done).
      const conflicted = lanes.filter((l) => l.phase === 'conflict').length
      this.emit({
        type: 'wave-complete',
        batchId,
        waveIndex: waveIndex + 1,
        totalWaves: waves.waves.length,
        merged: lanes.filter((l) => l.phase === 'merged').length,
        failed: lanes.filter((l) => l.phase === 'failed').length,
        conflict: conflicted,
        total: lanes.length,
      })
      // B3#3：本波有 merge 冲突未解决 → 自动暂停，等 supervisor 处置（人工修复后 resume，
      // 或决定重跑）。避免批次带着冲突 lane 继续跑、supervisor 手工介入与后台重试竞态。
      // 2026-08-16 扩展：pauseOnLaneFailure（默认开）时，failed lane 同样触发——失败不能
      // 直接滚到下一 wave，先停下来让 supervisor 处置（重跑 / 丢弃 / 继续）。
      const failedCount = lanes.filter((l) => l.phase === 'failed').length
      const shouldPause = conflicted > 0 || (failedCount > 0 && (config.pauseOnLaneFailure ?? true))
      if (shouldPause && !ctx.aborted) {
        ctx.paused = true
        state.phase = 'paused'
        writeBatchState(state)
        // 失败导致的暂停：记录批次 id，resume 时跳过 failed lane（丢弃），避免重跑再失败死循环。
        if (failedCount > 0) this.pausedOnFailureBatch = batchId
        // 波次完成后立即退出执行循环（下一波由 resume 重新调度）。
        return
      }
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
    // 方案 A（KI-007）：续跑/恢复时跳过**已完成** lane（仅 merged 才算完成，防止恢复时重跑）；
    // failed 不跳过——失败 lane 需要重跑续接（检查点保留在分支，worker 从 STATUS 继续）。
    // （2026-08-14 修正：原先 merged||failed 都跳过，导致重跑失败 lane 被错误跳过。）
    if (existing && existing.phase === 'merged') {
      laneLog(existing, 'skipped (already merged)')
      return existing
    }
    // abort 后不再启动新工作：不建 worktree、不 spawn worker，直接收尾。
    // （2026-08-15 修复：abort 后在途 runLane 仍会 createLaneWorktree 重建已被删的 worktree
    //   并 spawn 新 worker，最终用旧 batchId 把完成状态写进已 abort 的旧批次文件——
    //   bug-batch-state-write 报告主因。）
    if (ctx.aborted) {
      const abortedLane: LaneState = {
        lane: existing?.lane ?? state.lanes.length + 1,
        taskId: task.id,
        phase: 'failed',
        error: 'aborted before lane start',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        log: [`aborted before lane start`],
      }
      laneLog(abortedLane, 'aborted before lane start')
      return abortedLane
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
    // 2026-08-16：任务包创建方可能只写 Status 头 + Execution Log 而缺 `### Step N:` 段，
    // 引擎的 advance/进度统计依赖 Step 段——启动 lane 时确保 STATUS.md 与 PROMPT 结构一致。
    ensureStatusStructure(task)
    // B4 fix：启动 lane 时同步更新 Current Step / Step 1 状态，STATUS.md 自洽
    // （否则 worker 首次 advance 之前 dashboard 一直显示 "Not Started"）。
    setTaskStatus(task.folder, 'running')
    markTaskRunning(task.folder, task)
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

    // abort 在 worktree 建好后、worker spawn 前触发：不 spawn，直接收尾。
    if (ctx.aborted) {
      lane.phase = 'failed'
      lane.error = 'aborted before worker spawn'
      lane.endedAt = new Date().toISOString()
      laneLog(lane, 'aborted before worker spawn')
      return lane
    }

    const result = await this.runLaneWorker(ctx, lane, spec)
    lane.exitCode = result.exitCode
    if (result.error) lane.error = result.error
    laneLog(lane, `worker exited ${result.exitCode}${result.error ? ` (${result.error})` : ''}`)

    // stopLane 竞态防护：该 lane 被 /tswarm-stop-lane 标记 failed 后，即使 worker 后续
    // 正常返回，也保持 failed（stop 的语义是"丢弃此 lane"，不因收尾而复活为 merged）。
    try {
      const disk = readBatchState(config.stateRoot, batchId)
      const dl = disk?.lanes?.find((x) => x.taskId === task.id)
      if (dl && dl.phase === 'failed' && dl.error?.includes('stopped by operator')) {
        lane.phase = 'failed'
        lane.error = 'stopped by operator'
        lane.endedAt = new Date().toISOString()
        laneLog(lane, 'lane stopped by operator — keeping failed')
        updateLane(state.stateRoot, batchId, lane)
        return lane
      }
    } catch {
      // 磁盘不可读时按正常收尾
    }

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
      markTaskDone(task.folder)
      // orch merge 必须串行（同一 wave 多 lane 并行完成，并发 git merge 会被锁拒绝）。
      const merged = await this.serializedMerge(async () => {
        const first = mergeLane(config.repoRoot, paths, wt)
        if (first.ok) return first
        // merge 失败：现场已保留（lane worktree/branch + orch 冲突状态，P0）。
        // 尝试 LLM merger agent 语义化解冲突（P1，借鉴 TaskPlane merge agent）；
        // agent 不可用（headless host 未实现 spawnMerger）或仍失败 → failed 保留现场。
        const merger = config.host.spawnMerger
        if (!merger) return first
        laneLog(lane, `merge failed (${first.stderr.slice(0, 120).trim() || 'git lock/state error'}) — spawning merger agent`)
        // merger 卡住时不能阻塞 serializedMerge 队列：看门狗超时（P3，借鉴 TaskPlane
        // merge timeout）。超时 = 保留现场返回 unresolved，agent 会话由 spawner finally 收尾。
        const mergerTimeoutMin = config.mergerTimeoutMinutes ?? 10
        const mergerPromise = (async () => {
          // 必须绑定 host：方法解引用后 this 会丢（ES class 方法）。
          return merger.call(config.host, {
            orchWorktree: paths.orchWorktree,
            laneBranch: wt.branch,
            taskId: task.id,
            repoRoot: config.repoRoot,
            verifyCommands: config.mergeVerifyCommands,
          })
        })()
        let mr: MergeResult
        if (mergerTimeoutMin > 0) {
          const timer = new Promise<MergeResult>((resolve) => {
            setTimeout(() => {
              laneLog(lane, `merger agent timed out after ${mergerTimeoutMin} min — preserving merge state`)
              resolve({ status: 'CONFLICT_UNRESOLVED', summary: `merger agent timed out after ${mergerTimeoutMin} min` })
            }, mergerTimeoutMin * 60_000).unref?.()
          })
          mr = await Promise.race([mergerPromise, timer])
        } else {
          mr = await mergerPromise
        }
        try {
          if (mr.status === 'SUCCESS' || mr.status === 'CONFLICT_RESOLVED') {
            // Merger 已解决冲突并 commit 进 orch：清理 lane worktree/branch。
            const removeWt = runGit(['worktree', 'remove', '--force', wt.dir], config.repoRoot)
            if (!removeWt.ok) runGit(['worktree', 'prune'], config.repoRoot)
            runGit(['branch', '-d', wt.branch], config.repoRoot)
            laneLog(lane, `merge resolved by merger agent (${mr.status}): ${mr.summary.slice(0, 160)}`)
            return { ...first, ok: true }
          }
          // B3#3：merge 冲突且 merger 未解决 → conflict 态（待 supervisor 处置），
          // 不再直接 failed 静默收场：现场保留，批次将暂停等待处置（见 execute 波次边界）。
          lane.phase = 'conflict'
          lane.error = `merge conflict unresolved: ${first.stderr.slice(0, 150)}; merger agent: ${mr.summary.slice(0, 150)}`
          return first
        } catch (e) {
          lane.phase = 'conflict'
          lane.error = `merge failed: ${first.stderr.slice(0, 200)}; merger agent error: ${e instanceof Error ? e.message : String(e)}`
          return first
        }
      })
      if (merged.ok) {
        lane.phase = 'merged'
      } else if (lane.phase !== 'failed' && lane.phase !== 'conflict') {
        // 兜底：merger 不可用且 merge 失败（merger 分支内部已置 failed/conflict 的不再覆盖）。
        lane.phase = 'conflict'
        lane.error = `merge conflict unresolved (no merger agent): ${merged.stderr.slice(0, 200)}`
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
   *  failed 结果，runLane 正常收尾，wave 继续推进。
   *  2026-08-15（bug-batch-state-write）：abort 也要能中断在途 spawn await——否则 abort 后
   *  旧 execute 仍等 worker 跑完，用旧 batchId 写旧批次文件。 */
  private async runLaneWorker(ctx: RunContext, lane: LaneState, spec: LaneSpec): Promise<WorkerResult> {
    const { config } = ctx
    // abort 信号：abort() resolve 后立即中断在途 await，避免旧批次 worker 继续跑。
    const abortNow = ctx.abortWaiter
      ? ctx.abortWaiter.then(() => ({ exitCode: 1, text: '', error: 'aborted' } satisfies WorkerResult))
      : undefined
    // per-lane 停止信号：stopLane(taskId) resolve → 立即中断该 lane 的 worker（主动停卡住 lane）。
    let resolveStop: (() => void) | undefined
    const stopNow = new Promise<WorkerResult>((resolve) => {
      resolveStop = () => resolve({ exitCode: 1, text: '', error: 'stopped by operator' } satisfies WorkerResult)
    })
    ctx.laneStopResolvers.set(spec.lane, () => resolveStop?.())
    try {
      const timeoutMin = config.laneTimeoutMinutes ?? 0
      if (!(timeoutMin > 0)) {
        return Promise.race([config.host.spawn(spec), stopNow, ...(abortNow ? [abortNow] : [])])
      }

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
      return await Promise.race([config.host.spawn(spec), timeout, stopNow, ...(abortNow ? [abortNow] : [])])
    } finally {
      ctx.laneStopResolvers.delete(spec.lane)
      ctx.laneStopWaiters.delete(spec.lane)
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
    // pauseOnLaneFailure 暂停的批次：跳过 failed lane（丢弃失败工作），避免重跑再失败死循环。
    const skipFailed = this.pausedOnFailureBatch === latestBatch(this.config.stateRoot)?.id
    const ok = this.recoverPendingBatch(skipFailed)
    if (ok) this.pausedOnFailureBatch = null
    return ok
  }

  /**
   * 方案 A（KI-007）：引擎重启/崩溃后，把磁盘上 phase ∈ running/planning/paused 的
   * 批次重新挂回执行（跳过已完成 lane）。这样失联/重启不再需要手动开新批次重排剩余任务。
   * @param skipFailed 为 true 时跳过已 failed 的 lane（pauseOnLaneFailure 暂停后 resume =
   *   丢弃失败工作继续；false = 崩溃恢复，failed lane 需重跑续接）。
   */
  private recoverPendingBatch(skipFailed = false): boolean {
    const state = latestBatch(this.config.stateRoot)
    if (!state) return false
    if (state.phase !== 'running' && state.phase !== 'planning' && state.phase !== 'paused') return false
    if (this.active.has(state.id)) return false
    // select() 默认排除已 done 任务（.DONE 标记）→ wave plan 只含剩余任务。
    let selected = this.select(state.scope)
    if (skipFailed) {
      const failedIds = new Set(state.lanes.filter((l) => l.phase === 'failed').map((l) => l.taskId))
      selected = selected.filter((t) => !failedIds.has(t.task.id))
    }
    if (selected.length === 0) return false
    const waves = buildWaves(selected.map((t) => t.task))
    const paths = worktreePaths(this.config.repoRoot, this.config.stateRoot)
    const ctx = this.makeRunContext(state.id, paths)
    this.active.set(state.id, ctx)
    void this.execute(ctx, waves, state).finally(() => this.active.delete(state.id))
    return true
  }

  /** Abort: stop after the current wave and kill running lanes. */
  abort(): boolean {
    const ctx = this.activeContext()
    if (!ctx) return false
    ctx.aborted = true
    // 唤醒所有在途 await（runLaneWorker 的 Promise.race 会立即走 abort 分支收尾）。
    ctx.resolveAbort?.()
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

  /**
   * 主动停掉指定 lane（/tswarm-stop-lane）：中断其 worker（不等看门狗），标记 failed，
   * worktree/分支保留供排查或抢救。同波其他 lane 不受影响；若本波出现 failed 且
   * pauseOnLaneFailure 开启，该波跑完后批次自动暂停等处置。
   * @returns { ok, message } —— ok=false 表示找不到该 taskId 或不在运行中。
   */
  stopLane(taskId: string): { ok: boolean; message: string } {
    const ctx = this.activeContext()
    if (!ctx) return { ok: false, message: 'no running batch' }
    const state = readBatchState(this.config.stateRoot, ctx.batchId)
    const lane = state?.lanes.find((l) => l.taskId === taskId)
    if (!lane) return { ok: false, message: `task ${taskId} not found in batch ${ctx.batchId}` }
    if (lane.phase !== 'running' && lane.phase !== 'review') {
      return { ok: false, message: `lane ${lane.lane} (${taskId}) is ${lane.phase}, not running` }
    }
    // 先 abort worker 进程/agent，再 resolve per-lane 停止信号让 runLaneWorker 快速收尾。
    try {
      ctx.config.host.abort?.(lane.lane)
    } catch {
      // best-effort
    }
    const resolve = ctx.laneStopResolvers.get(lane.lane)
    if (resolve) resolve()
    laneLog(lane, 'stopped by operator (tswarm-stop-lane)')
    // 标记磁盘 failed（runLane 的收尾会再写一次，这里先落盘保证即时可见）。
    lane.phase = 'failed'
    lane.error = 'stopped by operator'
    lane.endedAt = new Date().toISOString()
    writeBatchState(state!)
    return { ok: true, message: `lane ${lane.lane} (${taskId}) stopped; worktree/checkpoints preserved` }
  }

  private activeContext(): RunContext | undefined {
    if (this.active.size === 0) return undefined
    return [...this.active.values()].pop()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
