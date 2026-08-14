/**
 * Git command runner.
 * Ported from TaskPlane `extensions/taskplane/git.ts`
 * (github.com/HenryLach/taskplane, MIT License).
 * @module taskswarm/core/git
 */
import { execFileSync } from 'node:child_process'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Run a git command synchronously with consistent error handling.
 * @param args - git subcommand arguments (e.g. ["worktree", "add", ...])
 * @param cwd  - working directory to run the command in (defaults to process.cwd())
 * @param env  - extra environment variables (defaults to process.env)
 */
export function runGit(args: string[], cwd?: string, env?: Record<string, string>): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      encoding: 'utf-8',
      timeout: 60_000,
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(env ?? {}) } as Record<string, string>,
    }).trim()
    return { ok: true, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string }
    return {
      ok: false,
      stdout: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? e.message ?? 'unknown error').trim(),
    }
  }
}

/** Current branch name, or null when HEAD is detached or git fails. */
export function getCurrentBranch(cwd?: string): string | null {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (!result.ok || !result.stdout.trim() || result.stdout.trim() === 'HEAD') return null
  return result.stdout.trim()
}

/** True when `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  return runGit(['rev-parse', '--is-inside-work-tree'], cwd).stdout.trim() === 'true'
}

/** Root of the git repository containing `cwd`. */
export function gitRoot(cwd: string): string | null {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd)
  return result.ok && result.stdout ? result.stdout.trim() : null
}

/**
 * Ensure a git identity exists locally (commits fail without one).
 * Prefers existing config; falls back to a neutral "taskswarm" identity.
 */
export function ensureGitIdentity(cwd: string): GitResult {
  const name = runGit(['config', 'user.name'], cwd)
  const email = runGit(['config', 'user.email'], cwd)
  const needName = !name.ok || !name.stdout.trim()
  const needEmail = !email.ok || !email.stdout.trim()
  if (needName) runGit(['config', 'user.name', 'tswarm'], cwd)
  if (needEmail) runGit(['config', 'user.email', 'taskswarm@localhost'], cwd)
  return { ok: true, stdout: '', stderr: needName || needEmail ? 'set local taskswarm identity' : '' }
}
