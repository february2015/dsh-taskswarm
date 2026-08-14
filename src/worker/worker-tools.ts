/**
 * Standard tool mounting for programmatic worker/reviewer agents.
 *
 * The web profile disables the root-level tool rows (the `dsh-web-app` bundle
 * patch sets tool-bash/tool-fs/tool-fs-search/... `disabled: true`) and mounts
 * them per session in code. Programmatic agents created from the plugin root
 * context therefore inherit NO shell/filesystem tools there — exactly the
 * `Missing shell/file tooling` escalations from the first web-profile batch.
 *
 * This module mounts the minimal standard tool set (bash, fs, fs-search,
 * str-replace-editor) directly on an agent-scoped context, and no-ops when the
 * ambient profile already provides them (plain `dsh-base` profiles like
 * `taskswarm-worker` / `taskswarm-verify`), avoiding duplicate registration.
 * @module taskswarm/worker/worker-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as toolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'

interface ToolPlugin {
  name: string
  apply(ctx: Context, config?: unknown): void
  inject?: string[]
  Config?: unknown
}

const STANDARD_TOOLS: ToolPlugin[] = [
  toolBash as unknown as ToolPlugin,
  toolFs as unknown as ToolPlugin,
  toolFsSearch as unknown as ToolPlugin,
  toolStrReplaceEditor as unknown as ToolPlugin,
]

export interface ToolsServiceLike {
  schemas(scope?: unknown): { name: string }[]
}

/**
 * Mount the standard shell/filesystem tool plugins on an agent-scoped context
 * when the ambient scope does not already provide them.
 * @param agentCtx - the agent's scoped context (from `agents.create` setup).
 * @returns the number of plugins mounted (0 when the context already exposes
 *   `bash`, e.g. in plain `dsh-base` profiles).
 */
export function mountStandardTools(agentCtx: Context): number {
  const tools = agentCtx.get('tools') as ToolsServiceLike | undefined
  if (tools) {
    try {
      if (tools.schemas().some((s) => s.name === 'bash')) return 0
    } catch {
      // Registry not yet readable — treat as absent and mount below.
    }
  }
  let mounted = 0
  for (const plugin of STANDARD_TOOLS) {
    try {
      // Cast through unknown: cordis accepts a plugin descriptor object; the
      // namespace import shape is close enough and validated at runtime.
      agentCtx.plugin(plugin as never, {} as never)
      mounted++
    } catch {
      // A duplicate or incompatible mount must not break lane setup.
    }
  }
  return mounted
}

/**
 * Grant a programmatic worker/reviewer session full sandbox access with
 * approvals pinned to `never` — the same mechanism DSH's subagent delegation
 * uses (`sandbox/mode` + `approval/policy` session events), applied directly
 * on the worker's own session so it is full-access regardless of the GUI
 * session's policy or the deployment environment. The GUI session and the
 * global profile configuration are untouched.
 * @param agentCtx - the agent's scoped creation context (from `agents.create`
 *   setup); the unpublished child session is reached via `agentCtx.agent.session`.
 */
export function grantWorkerFullAccess(agentCtx: Context): void {
  const session = (agentCtx as unknown as {
    agent?: { session?: { append?(type: string, data: unknown): unknown } }
  }).agent?.session
  if (!session?.append) return
  try {
    session.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' })
    session.append('approval/policy', { policy: 'never', source: 'delegation' })
  } catch {
    // Non-fatal: the worker still runs under the ambient policy.
  }
}
