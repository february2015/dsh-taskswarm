/**
 * Batch / lane status persistence — the durable state /orch-status and a
 * future dashboard read from. JSON files under `<stateRoot>/batches/`.
 * Adapted from TaskPlane's status/snapshot conventions
 * (github.com/HenryLach/taskplane, MIT License).
 * @module taskswarm/core/status
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type LanePhase = 'pending' | 'running' | 'review' | 'merged' | 'failed' | 'skipped'
export type BatchPhase = 'planning' | 'running' | 'paused' | 'aborted' | 'complete'

export interface LaneState {
  lane: number
  taskId: string
  phase: LanePhase
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

/** Update one lane of a batch by id, then persist. */
export function updateLane(stateRoot: string, batchId: string, lane: LaneState): BatchState | null {
  const state = readBatchState(stateRoot, batchId)
  if (!state) return null
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
  for (const lane of state.lanes) {
    const verdict = lane.reviewVerdict && lane.reviewVerdict !== 'none' ? ` review=${lane.reviewVerdict}` : ''
    const error = lane.error ? ` error=${lane.error.slice(0, 120)}` : ''
    lines.push(`  lane ${lane.lane} [${lane.phase}] ${lane.taskId}${verdict}${error}`)
  }
  return lines.join('\n')
}

function completedLanes(state: BatchState): number {
  return state.lanes.filter((l) => l.phase === 'merged' || l.phase === 'failed' || l.phase === 'skipped').length
}
