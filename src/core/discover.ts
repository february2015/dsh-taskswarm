/**
 * Task discovery, dependency resolution, and wave planning.
 * Adapted from TaskPlane `extensions/taskplane/discovery.ts` and
 * `extensions/taskplane/waves.ts` (github.com/HenryLach/taskplane, MIT License).
 *
 * A wave is a set of tasks whose dependencies are all satisfied by earlier
 * waves; tasks within one wave run in parallel lanes. Waves are computed by
 * topological layering over the dependency DAG.
 * @module taskswarm/core/discover
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { parsePrompt, extractTaskIdFromFolderName, type TaskPacket, type TaskStatusInfo, parseStatusFile } from './task.ts'

export interface DiscoveredTask {
  task: TaskPacket
  status: TaskStatusInfo
  /** Absolute path when the task matches the requested scope, else undefined. */
  selected: boolean
}

export interface WavePlan {
  tasks: TaskPacket[]
  waves: TaskPacket[][]
  /** taskId → ids it depends on that are not present in the scan. */
  unresolvedDeps: Map<string, string[]>
}

export function defaultTasksRoot(repoRoot: string): string {
  return join(repoRoot, 'tasks')
}

/**
 * Scan a tasks root for task packets (directories containing PROMPT.md).
 * @param tasksRoot   - absolute path to the tasks root
 * @param includeDone - when false, tasks with a `.DONE` marker are excluded
 */
export function scanTasks(tasksRoot: string, includeDone = false): DiscoveredTask[] {
  if (!existsSync(tasksRoot)) return []
  const found: DiscoveredTask[] = []
  for (const entry of readdirSync(tasksRoot).sort()) {
    const folder = join(tasksRoot, entry)
    if (!statSync(folder).isDirectory()) continue
    const promptPath = join(folder, 'PROMPT.md')
    if (!existsSync(promptPath)) continue
    if (!includeDone && existsSync(join(folder, '.DONE'))) continue
    const areaName = entry.includes('-') ? entry.split('-')[0]!.toLowerCase() : 'tasks'
    const task = parsePrompt(promptPath, folder, areaName)
    if (!task) continue
    found.push({ task, status: parseStatusFile(folder), selected: true })
  }
  return found
}

/**
 * Resolve a scope argument ('all' | '' | task id | path) into selected tasks.
 * Paths may be relative to `repoRoot` or absolute; ids match task ids or
 * folder names.
 */
export function resolveScope(scope: string, repoRoot: string, tasks: DiscoveredTask[]): DiscoveredTask[] {
  const trimmed = (scope || 'all').trim()
  if (trimmed === '' || trimmed === 'all') return tasks.map((t) => ({ ...t, selected: true }))
  const wanted = new Set(
    trimmed.split(/\s+/).map((token) => {
      if (isAbsolute(token)) return resolve(token)
      if (token.includes('/') || token.includes('\\')) return resolve(repoRoot, token)
      return token.toUpperCase()
    }),
  )
  return tasks.map((t) => {
    const path = resolve(t.task.folder)
    const id = t.task.id.toUpperCase()
    const folderName = path.split(/[\\/]/).pop()!.toUpperCase()
    const selected = [...wanted].some((w) => path === w || id === w || folderName.includes(w) || (w.includes('/') && path.startsWith(w)))
    return { ...t, selected }
  })
}

/**
 * Build the wave plan: topological layers over the dependency DAG.
 * Unknown dependency ids are reported (and treated as satisfied) rather than
 * failing the whole plan.
 */
export function buildWaves(tasks: TaskPacket[]): WavePlan {
  const byId = new Map<string, TaskPacket>()
  for (const task of tasks) byId.set(task.id, task)

  const unresolved = new Map<string, string[]>()
  const done = new Set<string>()
  const waves: TaskPacket[][] = []
  const remaining = new Set(tasks.map((t) => t.id))

  while (remaining.size > 0) {
    const wave: TaskPacket[] = []
    for (const id of remaining) {
      const task = byId.get(id)!
      const deps = task.deps.filter((dep) => byId.has(dep))
      const missing = task.deps.filter((dep) => !byId.has(dep))
      if (missing.length > 0) unresolved.set(id, missing)
      if (deps.every((dep) => done.has(dep))) wave.push(task)
    }
    if (wave.length === 0) {
      // Dependency cycle — break it by emitting the remaining tasks in order.
      for (const id of remaining) {
        const task = byId.get(id)!
        if (!waves.flat().some((t) => t.id === task.id)) wave.push(task)
      }
      if (wave.length === 0) break
    }
    for (const task of wave) {
      done.add(task.id)
      remaining.delete(task.id)
    }
    waves.push(wave)
  }
  return { tasks, waves, unresolvedDeps: unresolved }
}

/** Format a wave plan for display (used by /orch-plan). */
export function formatWavePlan(plan: WavePlan): string {
  const lines: string[] = []
  for (const [index, wave] of plan.waves.entries()) {
    lines.push(`Wave ${index + 1} (${wave.length} task${wave.length === 1 ? '' : 's'}):`)
    for (const task of wave) {
      const depNote = task.deps.length > 0 ? `  ← ${task.deps.join(', ')}` : ''
      lines.push(`  - ${task.id} ${task.name}${depNote}`)
    }
  }
  if (plan.unresolvedDeps.size > 0) {
    lines.push('')
    lines.push('Unresolved dependency references:')
    for (const [id, deps] of plan.unresolvedDeps) lines.push(`  - ${id} → ${deps.join(', ')}`)
  }
  return lines.join('\n')
}

/** Derive a display name for a task id (id + folder slug). */
export function taskDisplayId(task: TaskPacket): string {
  const folderName = task.folder.split(/[\\/]/).pop()!
  return extractTaskIdFromFolderName(folderName) === task.id ? folderName : task.id
}
