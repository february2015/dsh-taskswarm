/**
 * Repository-level settings — persisted in `<stateRoot>/config.json`.
 *
 * Operator-facing, runtime-settable settings for a repo, written by the
 * conversational supervisor ("用英文汇报", "每隔 15 分钟汇报一次", ...).
 * JSON merge-write: unknown/other keys are preserved, so the file can grow
 * new settings without breaking older readers.
 *
 * Precedence for any setting: repo config file (runtime, latest intent) >
 * plugin `Config` (installer default) > built-in default.
 *
 * Current keys:
 *   - locale: 'auto' | 'zh-CN' | 'en'  (supervisor notifications/prompt language)
 *   - reportIntervalMinutes: number ≥ 0 (periodic progress report interval; 0 = off)
 *
 * Candidate future keys (design slots, applied at engine creation):
 *   - supervisorMode: 'off' | 'interactive' | 'supervised' | 'autonomous'
 *   - workerModel / reviewerModel: model overrides
 *   - includeDoneTasks: boolean
 * @module taskswarm/orchestrator/settings
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RepoSettings {
  /** 仅接受具体语言；'auto' 通过移除该键表达（回落到插件 config / 自动检测）。 */
  locale?: 'zh-CN' | 'en'
  reportIntervalMinutes?: number
}

export function repoConfigPath(stateRoot: string): string {
  return join(stateRoot, 'config.json')
}

/** Raw config object, tolerant of missing/corrupt files. */
function readRawConfig(stateRoot: string): Record<string, unknown> {
  try {
    const raw = readFileSync(repoConfigPath(stateRoot), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Full settings view (only known keys; unknown keys ignored). */
export function readSettings(stateRoot: string): RepoSettings {
  const raw = readRawConfig(stateRoot)
  const out: RepoSettings = {}
  const locale = raw.locale
  if (locale === 'zh-CN' || locale === 'en') out.locale = locale
  const minutes = raw.reportIntervalMinutes
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) out.reportIntervalMinutes = minutes
  return out
}

/** Per-key value validation: invalid values are never persisted. */
function validValue(key: keyof RepoSettings, value: unknown): boolean {
  switch (key) {
    case 'locale':
      return value === 'zh-CN' || value === 'en'
    case 'reportIntervalMinutes':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
    default:
      return true
  }
}

/** Merge-write a single setting (other keys preserved); invalid values ignored. */
export function writeSetting(stateRoot: string, key: keyof RepoSettings, value: unknown): void {
  if (!validValue(key, value)) return
  mkdirSync(stateRoot, { recursive: true })
  const config = readRawConfig(stateRoot)
  config[key] = value
  writeFileSync(repoConfigPath(stateRoot), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/** Remove a single setting; deletes the file when it becomes empty. */
export function removeSetting(stateRoot: string, key: keyof RepoSettings): void {
  const config = readRawConfig(stateRoot)
  if (!(key in config)) return
  delete config[key]
  try {
    if (Object.keys(config).length === 0) {
      rmSync(repoConfigPath(stateRoot), { force: true })
    } else {
      writeFileSync(repoConfigPath(stateRoot), JSON.stringify(config, null, 2) + '\n', 'utf-8')
    }
  } catch {
    // best-effort
  }
}

/** True when the repo config file exists (diagnostic helper). */
export function hasRepoConfig(stateRoot: string): boolean {
  return existsSync(repoConfigPath(stateRoot))
}
