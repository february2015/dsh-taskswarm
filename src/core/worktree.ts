/**
 * Git worktree isolation, checkpoint commits, and merge-back.
 * Adapted from TaskPlane `extensions/taskplane/worktree.ts`
 * (github.com/HenryLach/taskplane, MIT License) — lean re-implementation.
 *
 * Model:
 *   - `taskswarm/orch`  — dedicated integration branch (created once, never checked
 *     out in the main working tree).
 *   - one lane worktree per task: `git worktree add -b taskswarm/<taskId> <laneDir>`
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
  // git worktree add 语法：`add <path> [<commit-ish>]`——path 在前。
  // 已存在分支时 `worktree add <dir> <branch>`（附着）；新分支 `worktree add -b <branch> <dir>`。
  // （2026-08-14 修正：原 `add <branch> <dir>` 参数顺序颠倒，git 把 branch 当 path → 无效引用，
  //   导致"已存在分支"的 lane 重跑 always "could not create lane worktree"，如 JM-337。）
  const result = hasBranch
    ? runGit(['worktree', 'add', dir, branch], repoRoot)
    : runGit(['worktree', 'add', '-b', branch, dir], repoRoot)
  if (!result.ok) return null
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
 */
export function mergeLane(repoRoot: string, paths: WorktreePaths, lane: LaneWorktree): GitResult {
  ensureGitIdentity(repoRoot)
  const merged = runGit(['merge', '--no-edit', lane.branch], paths.orchWorktree)
  const removeWt = runGit(['worktree', 'remove', '--force', lane.dir], repoRoot)
  if (!removeWt.ok) runGit(['worktree', 'prune'], repoRoot)
  runGit(['branch', '-d', lane.branch], repoRoot)
  if (!merged.ok) {
    // Surface the merge failure but keep cleanup semantics: the lane branch
    // still exists for inspection when the merge failed.
    runGit(['branch', '-D', lane.branch], repoRoot)
  }
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
