/**
 * Batch / lane status persistence — the durable state /orch-status and a
 * future dashboard read from. JSON files under `<stateRoot>/batches/`.
 * Adapted from TaskPlane's status/snapshot conventions
 * (github.com/HenryLach/taskplane, MIT License).
 * @module taskswarm/core/status
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanTasks } from './discover.ts'
import { parseStatusFile } from './task.ts'

export type LanePhase = 'pending' | 'running' | 'review' | 'conflict' | 'merged' | 'failed' | 'skipped'
export type BatchPhase = 'planning' | 'running' | 'paused' | 'aborted' | 'complete'

export interface LaneState {
  lane: number
  taskId: string
  phase: LanePhase
  wave?: number
  worktree?: string
  startedAt?: string
  endedAt?: string
  exitCode?: number
  error?: string
  reviewVerdict?: 'PASS' | 'REVISE' | 'none'
  log: string[]
}

export interface BatchState {
  id: string
  repoRoot: string
  tasksRoot: string
  stateRoot: string
  phase: BatchPhase
  scope: string
  startedAt: string
  endedAt?: string
  waves: number
  /**
   * 批次启动时确定的 wave plan（每 wave 一个 taskId 数组），持久化——
   * 暂停/恢复/崩溃恢复时**原样复用**，绝不在中途重算（2026-08-16 修复：
   * 恢复时重新 buildWaves 会把已完成 wave 的任务排除，wave 数变化、
   * lane.wave 错位，dingo 的 Wave 分段数据也随之错乱）。
   */
  wavePlan: string[][]
  lanes: LaneState[]
}

export function batchStateDir(stateRoot: string): string {
  return join(stateRoot, 'batches')
}

export function batchStatePath(stateRoot: string, batchId: string): string {
  return join(batchStateDir(stateRoot), `${batchId}.json`)
}

export function readBatchState(stateRoot: string, batchId: string): BatchState | null {
  const path = batchStatePath(stateRoot, batchId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as BatchState
  } catch {
    return null
  }
}

export function writeBatchState(state: BatchState): void {
  const dir = batchStateDir(state.stateRoot)
  mkdirSync(dir, { recursive: true })
  writeFileSync(batchStatePath(state.stateRoot, state.id), JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Update one lane of a batch by id, then persist.
 * 终态防御（2026-08-15）：`aborted` / `complete` 批次拒绝再写 lane 状态——
 * 否则 abort 后仍在途的旧 execute() 会用旧 batchId 把完成状态续写进已终态的旧批次文件
 * （bug-batch-state-write 报告放大因素）。
 */
export function updateLane(stateRoot: string, batchId: string, lane: LaneState): BatchState | null {
  const state = readBatchState(stateRoot, batchId)
  if (!state) return null
  if (state.phase === 'aborted' || state.phase === 'complete') return state
  const index = state.lanes.findIndex((l) => l.lane === lane.lane && l.taskId === lane.taskId)
  if (index === -1) state.lanes.push(lane)
  else state.lanes[index] = lane
  writeBatchState(state)
  return state
}

/** Latest batch state across the state root, or null. */
export function latestBatch(stateRoot: string): BatchState | null {
  const dir = batchStateDir(stateRoot)
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  if (names.length === 0) return null
  return readBatchState(stateRoot, names[names.length - 1]!.replace(/\.json$/, ''))
}

export function removeBatchState(stateRoot: string, batchId: string): void {
  const path = batchStatePath(stateRoot, batchId)
  if (existsSync(path)) rmSync(path, { force: true })
}

export function laneLog(lane: LaneState, entry: string): void {
  lane.log.push(entry)
  if (lane.log.length > 200) lane.log.splice(0, lane.log.length - 200)
}

/** Text rendering of a batch for /orch-status. */
export function formatBatchStatus(state: BatchState): string {
  const lines: string[] = [
    `Batch ${state.id} — ${state.phase} (${completedLanes(state)}/${state.lanes.length} lanes done)`,
    `Started: ${state.startedAt}  Scope: ${state.scope}`,
    '',
  ]
  // KI-008: taskId → task folder 映射（读 STATUS.md 的步数进度）。
  const byId = new Map(scanTasks(state.tasksRoot, true).map((d) => [d.task.id, d.task.folder]))
  for (const lane of state.lanes) {
    const verdict = lane.reviewVerdict && lane.reviewVerdict !== 'none' ? ` review=${lane.reviewVerdict}` : ''
    const error = lane.error ? ` error=${lane.error.slice(0, 120)}` : ''
    const folder = byId.get(lane.taskId)
    let progress = ''
    if (folder) {
      const info = parseStatusFile(folder)
      if (info.total) progress = ` ${info.checked}/${info.total}`
    }
    lines.push(`  lane ${lane.lane} [${lane.phase}] ${lane.taskId}${progress}${verdict}${error}`)
  }
  return lines.join('\n')
}

function completedLanes(state: BatchState): number {
  // 2026-08-17 修复：只有 merged 才算"完成"——failed/skipped 是终结态但不是完成，
  // 计入会误导（如"1/6 done"实为 1 失败 5 未开始）。失败数由调用方另行展示。
  return state.lanes.filter((l) => l.phase === 'merged').length
}
