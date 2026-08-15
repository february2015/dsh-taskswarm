/**
 * Git worktree isolation, checkpoint commits, and merge-back.
 * Adapted from TaskPlane `extensions/taskplane/worktree.ts`
 * (github.com/HenryLach/taskplane, MIT License) — lean re-implementation.
 *
 * Model:
 *   - `taskswarm/orch`  — dedicated integration branch (created once, never checked
 *     out in the main working tree).
 *   - one lane worktree per task: `git worktree add -b taskswarm/<taskId> <laneDir> taskswarm/orch`
 *     (lane baselines on the orch HEAD — it inherits every previously merged task's
 *     output, instead of starting from the working branch and re-inventing shared code)
 *   - worker checkpoints: `git add -A && git commit -m "checkpoint: <msg>"`
 *   - merge-back: merge the lane branch into `taskswarm/orch` inside the orch
 *     worktree, then remove the lane worktree and delete the lane branch.
 * @module taskswarm/core/worktree
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runGit, ensureGitIdentity, type GitResult } from './git.ts'
import { sanitizeNameComponent } from './naming.ts'

export const ORCH_BRANCH = 'taskswarm/orch'

export interface WorktreePaths {
  stateRoot: string
  worktreesDir: string
  orchWorktree: string
}

export function worktreePaths(repoRoot: string, stateRoot: string): WorktreePaths {
  const worktreesDir = join(stateRoot, 'worktrees')
  return { stateRoot, worktreesDir, orchWorktree: join(worktreesDir, '_orch') }
}

/** Ensure the orch branch and its worktree exist. Returns the orch worktree path. */
export function ensureOrchWorktree(repoRoot: string, paths: WorktreePaths): GitResult {
  mkdirSync(paths.worktreesDir, { recursive: true })
  ensureGitIdentity(repoRoot)
  const hasBranch = runGit(['rev-parse', '--verify', `refs/heads/${ORCH_BRANCH}`], repoRoot).ok
  if (!hasBranch) {
    runGit(['branch', ORCH_BRANCH], repoRoot)
  }
  if (!existsSync(paths.orchWorktree)) {
    const added = runGit(['worktree', 'add', '-B', ORCH_BRANCH, paths.orchWorktree], repoRoot)
    if (!added.ok && !added.stderr.includes('already exists')) {
      return added
    }
  }
  return { ok: true, stdout: '', stderr: '' }
}

export interface LaneWorktree {
  dir: string
  branch: string
}

/** Create an isolated lane worktree for a task. */
export function createLaneWorktree(repoRoot: string, paths: WorktreePaths, taskId: string): LaneWorktree | null {
  const branch = `taskswarm/${sanitizeNameComponent(taskId, 48)}`
  const dir = join(paths.worktreesDir, sanitizeNameComponent(taskId, 48))
  // Leftovers from a killed process or an aborted batch must not block the
  // next batch: remove a stale worktree dir, and attach an existing branch
  // instead of `-b` (which fails when the branch already exists).
  if (existsSync(dir)) {
    const removed = runGit(['worktree', 'remove', '--force', dir], repoRoot)
    if (!removed.ok) runGit(['worktree', 'prune'], repoRoot)
  }
  const hasBranch = runGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot).ok
  const hasOrch = runGit(['rev-parse', '--verify', `refs/heads/${ORCH_BRANCH}`], repoRoot).ok
  // git worktree add 语法：`add <path> [<commit-ish>]`——path 在前。
  // 新分支：`worktree add -b <branch> <dir> [<commit-ish>]`。
  // 已存在分支：`worktree add <dir> <branch>`（附着）。
  // （2026-08-14 修正：原 `add <branch> <dir>` 参数顺序颠倒，git 把 branch 当 path → 无效引用，
  //   导致"已存在分支"的 lane 重跑 always "could not create lane worktree"，如 JM-337。）
  // （2026-08-15 修正：新 lane 显式以 taskswarm/orch HEAD 为基线——此前从工作分支出发，
  //   lane 看不到已合并任务的产物，全靠 worker 自觉 `git merge taskswarm/orch` 补基线；
  //   若 worker 未意识到依赖即产出残缺/重复实现，merge 回 orch 时互相冲突。）
  const result = hasBranch
    ? runGit(['worktree', 'add', dir, branch], repoRoot)
    : hasOrch
      ? runGit(['worktree', 'add', '-b', branch, dir, ORCH_BRANCH], repoRoot)
      : runGit(['worktree', 'add', '-b', branch, dir], repoRoot)
  if (!result.ok) return null
  // 续跑（附着既有分支）：把 orch 最新合并产物并入 lane，让重跑从最新状态继续
  // （旧检查点保留；合并冲突时 abort，worker 可在任务中自行 merge orch）。
  if (hasBranch && hasOrch) {
    const sync = runGit(['merge', '--no-edit', ORCH_BRANCH], dir)
    if (!sync.ok) runGit(['merge', '--abort'], dir)
  }
  return { dir, branch }
}

/**
 * Checkpoint commit inside a lane worktree. No-ops when there is nothing to
 * commit. Returns the commit summary or 'no changes'.
 */
export function checkpointCommit(worktreeDir: string, message: string): { ok: boolean; summary: string } {
  const add = runGit(['add', '-A'], worktreeDir)
  if (!add.ok) return { ok: false, summary: add.stderr }
  const status = runGit(['status', '--porcelain'], worktreeDir)
  if (!status.ok || status.stdout.trim() === '') return { ok: true, summary: 'no changes' }
  const commit = runGit(['commit', '-m', message], worktreeDir)
  if (!commit.ok) {
    if (commit.stderr.includes('nothing to commit')) return { ok: true, summary: 'no changes' }
    return { ok: false, summary: commit.stderr }
  }
  const short = commit.stdout.match(/\[([^\]]+)\]/)
  return { ok: true, summary: short ? short[1] : commit.stdout.slice(0, 60) }
}

/**
 * Merge a completed lane branch into the orch branch (via the orch worktree),
 * then clean up the lane worktree and branch.
 *
 * On success: the lane worktree and branch are removed.
 * On failure: **everything is preserved** — the lane worktree, the lane
 * branch, and the in-progress merge state inside the orch worktree. A failed
 * merge means a conflict (or git error) that needs inspection: the worker's
 * work must not be destroyed by a `branch -D`, or the merge state cannot be
 * handed to a merge agent / manual resolution. Callers decide how to recover
 * (merge agent, supervisor intervention, manual resolve) and then clean up.
 */
export function mergeLane(repoRoot: string, paths: WorktreePaths, lane: LaneWorktree): GitResult {
  ensureGitIdentity(repoRoot)
  const merged = runGit(['merge', '--no-edit', lane.branch], paths.orchWorktree)
  if (!merged.ok) {
    // Preserve the merge failure state: do NOT remove the lane worktree,
    // do NOT delete the lane branch, and leave the orch merge in progress
    // (conflict markers intact) for inspection / merge-agent resolution.
    return merged
  }
  const removeWt = runGit(['worktree', 'remove', '--force', lane.dir], repoRoot)
  if (!removeWt.ok) runGit(['worktree', 'prune'], repoRoot)
  runGit(['branch', '-d', lane.branch], repoRoot)
  return merged
}

/** List active lane worktrees (dirs under the worktrees root, minus orch). */
export function listLaneWorktrees(paths: WorktreePaths): string[] {
  if (!existsSync(paths.worktreesDir)) return []
  return readdirSync(paths.worktreesDir)
    .filter((name) => !name.startsWith('_'))
    .map((name) => join(paths.worktreesDir, name))
}

/** Remove all lane worktrees (batch teardown / abort). */
export function removeAllLaneWorktrees(repoRoot: string, paths: WorktreePaths): void {
  for (const dir of listLaneWorktrees(paths)) {
    runGit(['worktree', 'remove', '--force', dir], repoRoot)
  }
  runGit(['worktree', 'prune'], repoRoot)
}
