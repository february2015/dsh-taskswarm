/**
 * Naming contract helpers for collision-resistant identifiers.
 * Ported from TaskPlane `extensions/taskplane/naming.ts`
 * (github.com/HenryLach/taskplane, MIT License), with the OrchestratorConfig
 * dependency removed.
 * @module taskswarm/core/naming
 */
import { basename, resolve } from 'node:path'
import { userInfo } from 'node:os'

/**
 * Sanitize a raw string into a safe naming component.
 * Lowercase; non-alphanumeric (except hyphens) become hyphens; consecutive
 * hyphens collapse; truncated to `maxLen`. Safe for lane session IDs, git
 * branch refs, and filesystem paths.
 */
export function sanitizeNameComponent(raw: string, maxLen: number = 16): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
}

/**
 * Resolve the operator identifier used in lane/session naming.
 * Resolution order: TASKSWARM_OPERATOR_ID env → explicit override → OS username → "op".
 */
export function resolveOperatorId(
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const candidates = [env.TASKSWARM_OPERATOR_ID, override]
  for (const raw of candidates) {
    if (raw && raw.trim()) {
      const sanitized = sanitizeNameComponent(raw.trim(), 12)
      if (sanitized) return sanitized
    }
  }
  try {
    const username = userInfo().username
    if (username && username.trim()) {
      const sanitized = sanitizeNameComponent(username.trim(), 12)
      if (sanitized) return sanitized
    }
  } catch {
    /* userInfo() can throw on some platforms */
  }
  return 'op'
}

/** Derive a repo slug from the repository root directory name. */
export function resolveRepoSlug(repoRoot: string): string {
  const dirName = basename(resolve(repoRoot))
  if (!dirName) return 'repo'
  return sanitizeNameComponent(dirName, 16) || 'repo'
}
