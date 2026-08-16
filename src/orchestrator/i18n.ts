/**
 * Supervisor i18n — locale resolution + user-facing notification strings.
 *
 * TaskSwarm's supervisor notifications (event headlines, ETA, stall warnings,
 * periodic reports) follow the project's bilingual standard (EN + 中文).
 * Which language a user gets is decided by {@link resolveLocale}:
 *
 *   1. explicit plugin config `locale` ('zh-CN' | 'en') wins;
 *   2. 'auto' (default) samples the batch-owner session's recent user
 *      messages and heuristically detects CJK vs Latin;
 *   3. fallback is 'zh-CN' (backward compatible with previous behavior).
 *
 * Detection is stable per engine (resolved once when the engine is created),
 * so a batch keeps one language for its whole lifetime. The operator can
 * switch the language at runtime by text (tswarm_supervisor_locale tool); the
 * choice is persisted to `<stateRoot>/config.json` so it survives restarts.
 * @module taskswarm/orchestrator/i18n
 */
export type Locale = 'zh-CN' | 'en'
export type LocaleConfig = 'auto' | Locale

/** Mutable locale holder shared by the engine ref and the supervisor tools. */
export interface LocaleState {
  value: Locale
}

export interface SupervisorMessages {
  batchStarted(id: string, total: number): string
  laneFailed(lane: number, taskId: string, error?: string): string
  laneRevise(lane: number, taskId: string): string
  waveComplete(wave: number, total: number, merged: number, failed: number): string
  batchComplete(id: string, merged: number, total: number, failed: number): string
  batchAborted(id: string): string
  etaLabel: string
  noBatchState: string
  stalled(id: string, minutes: number): string
  /** 会话活跃但 STATUS 长时间无 advance：worker 可能在攒批，进度显示滞后（B2）。 */
  progressStalled(lane: number, taskId: string, minutes: number): string
  periodicReport(minutes: number): string
  reportIntervalOn(minutes: number): string
  reportIntervalOff: string
  invalidInterval(minutes: number): string
  /** 定时汇报/状态简报第二行：当前执行波次（wave x/y）。 */
  waveHeader(current: number, total: number): string
  // estimateEta fragments
  etaDone: string
  etaEstimating: string
  etaBaseOne(seconds: number): string
  etaBaseMany(count: number, seconds: number): string
  etaFmt(minutes: number, base: string, seconds: number, remaining: number, parallel: number): string
  // locale tool
  localeCurrent(locale: Locale): string
  localeSwitchedTo(locale: Locale, configPath: string): string
  /** 波次执行期间自动拉起 dashboard 成功后的通知（含链接）。 */
  dashboardUrl(url: string): string
  /** 每次通知附带的该批次 worker 会话磁盘占用。 */
  sessionsUsage(bytes: string): string
  /** 批次全成功后的清理提醒（是否删除该批次 worker 会话历史）。 */
  cleanupOffer(bytes: string): string
}

const zhCN: SupervisorMessages = {
  // 通知消息体统一英文极简（省 token）；supervisor 会按当前会话语言向用户解释。
  batchStarted: (id, total) => `[TS started] ${id} · ${total} tasks`,
  laneFailed: (lane, taskId, error) => `[TS lane failed] L${lane} ${taskId}${error ? ` · ${error.slice(0, 80)}` : ''}`,
  laneRevise: (lane, taskId) => `[TS revise] L${lane} ${taskId} (reviewer REVISE)`,
  waveComplete: (wave, total, merged, failed) => `[TS wave ${wave}/${total} done] ${merged} merged · ${failed} failed`,
  batchComplete: (id, merged, total, failed) => `[TS batch complete] ${merged}/${total} merged · ${failed} failed`,
  batchAborted: (id) => `[TS aborted] ${id}`,
  etaLabel: 'ETA ',
  noBatchState: '(no batch state)',
  stalled: (id, minutes) =>
    `[TS stalled] ${id} no lane changes ~${minutes}m and session logs stale. Inspect with tswarm_supervisor_status, then wait / pause / abort.`,
  progressStalled: (lane, taskId, minutes) =>
    `[TS 🐢 progress] L${lane} ${taskId} active but no advance ~${minutes}m — worker may be batching; remind it to \`advance\` after each checkbox.`,
  periodicReport: (minutes) => `[TS report · every ${minutes}m]`,
  reportIntervalOn: (minutes) => `Periodic reports on: every ${minutes} min.`,
  reportIntervalOff: 'Periodic reports off.',
  invalidInterval: (minutes) => `Invalid interval: ${minutes} min (integer ≥ 0; 0 = off)`,
  waveHeader: (current, total) => `W${current}/${total}`,
  etaDone: 'done',
  etaEstimating: 'estimating',
  etaBaseOne: (seconds) => `1 lane ${seconds}s`,
  etaBaseMany: (count, seconds) => `${count} lanes avg ${seconds}s`,
  etaFmt: (minutes, base, _seconds, remaining, parallel) => `~${minutes}m (${base} × ${remaining} lanes ÷ ${parallel})`,
  localeCurrent: (locale) =>
    `当前 supervisor 语言：${locale === 'en' ? '英文 (en)' : '中文 (zh-CN)'}（说"用英文"/"用中文"可切换；"自动"恢复按会话语言检测）`,
  localeSwitchedTo: (locale, configPath) =>
    `已切换为${locale === 'en' ? '英文' : '中文'}，通知与 supervisor 提示词即时生效，并已写入 ${configPath}。`,
  dashboardUrl: (url) => `📊 Dashboard: ${url}`,
  sessionsUsage: (bytes) => `💾 ${bytes}`,
  cleanupOffer: (bytes) =>
    `✅ All merged. Delete this batch's worker session history (${bytes})? Reply "keep" or "delete".`,
}

const en: SupervisorMessages = {
  batchStarted: (id, total) => `[TS started] ${id} · ${total} tasks`,
  laneFailed: (lane, taskId, error) => `[TS lane failed] L${lane} ${taskId}${error ? ` · ${error.slice(0, 80)}` : ''}`,
  laneRevise: (lane, taskId) => `[TS revise] L${lane} ${taskId} (reviewer REVISE)`,
  waveComplete: (wave, total, merged, failed) => `[TS wave ${wave}/${total} done] ${merged} merged · ${failed} failed`,
  batchComplete: (id, merged, total, failed) => `[TS batch complete] ${merged}/${total} merged · ${failed} failed`,
  batchAborted: (id) => `[TS aborted] ${id}`,
  etaLabel: 'ETA ',
  noBatchState: '(no batch state)',
  stalled: (id, minutes) =>
    `[TS stalled] ${id} no lane changes ~${minutes}m and session logs stale. Inspect with tswarm_supervisor_status, then wait / pause / abort.`,
  progressStalled: (lane, taskId, minutes) =>
    `[TS 🐢 progress] L${lane} ${taskId} active but no advance ~${minutes}m — worker may be batching; remind it to \`advance\` after each checkbox.`,
  periodicReport: (minutes) => `[TS report · every ${minutes}m]`,
  reportIntervalOn: (minutes) => `Periodic reports on: every ${minutes} min.`,
  reportIntervalOff: 'Periodic reports off.',
  invalidInterval: (minutes) => `Invalid interval: ${minutes} min (integer ≥ 0; 0 = off)`,
  waveHeader: (current, total) => `W${current}/${total}`,
  etaDone: 'done',
  etaEstimating: 'estimating',
  etaBaseOne: (seconds) => `1 lane ${seconds}s`,
  etaBaseMany: (count, seconds) => `${count} lanes avg ${seconds}s`,
  etaFmt: (minutes, base, _seconds, remaining, parallel) => `~${minutes}m (${base} × ${remaining} lanes ÷ ${parallel})`,
  localeCurrent: (locale) =>
    `Current supervisor language: ${locale === 'en' ? 'English (en)' : 'Chinese (zh-CN)'} (say "use English"/"use Chinese" to switch; "auto" re-detects from your session)`,
  localeSwitchedTo: (locale, configPath) =>
    `Switched to ${locale === 'en' ? 'English' : 'Chinese'} — notifications and the supervisor prompt take effect immediately, and the choice is saved to ${configPath}.`,
  dashboardUrl: (url) => `📊 Dashboard: ${url}`,
  sessionsUsage: (bytes) => `💾 ${bytes}`,
  cleanupOffer: (bytes) =>
    `✅ All merged. Delete this batch's worker session history (${bytes})? Reply "keep" or "delete".`,
}

const dictionaries: Record<Locale, SupervisorMessages> = { 'zh-CN': zhCN, en }

/** Message strings for a locale. */
export function messages(locale: Locale): SupervisorMessages {
  return dictionaries[locale]
}

/** Ratio of CJK / CJK-punctuation characters in the text (0..1). */
export function cjkRatio(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const total = text.replace(/\s/g, '').length
  return total === 0 ? 0 : cjk / total
}

/** Heuristic: strongly CJK text → zh-CN, otherwise en. */
export function detectLocaleFromText(text: string): Locale {
  return cjkRatio(text) > 0.2 ? 'zh-CN' : 'en'
}

interface LocaleSessionLike {
  surface?: {
    deriveMessages?(): Array<{
      role?: string
      content?: Array<{ type?: string; text?: string }>
      source?: { kind?: string }
    }>
  }
}

/**
 * Detect the user's language from a session's recent user messages.
 * Samples the last 12 derived messages, keeps user-origin text, and uses the
 * combined CJK ratio. Returns 'zh-CN' when there is no usable signal.
 */
export function detectLocaleFromSession(sessions: unknown, sessionId?: string): Locale {
  if (!sessionId) return 'zh-CN'
  try {
    const store = sessions as { get?(id: string): LocaleSessionLike | undefined } | undefined
    const session = store?.get?.(sessionId)
    const msgs = session?.surface?.deriveMessages?.() ?? []
    const texts: string[] = []
    for (const m of msgs.slice(-12)) {
      if (m.role !== 'user') continue
      if (m.source?.kind && m.source.kind !== 'user') continue
      for (const block of m.content ?? []) {
        if (block.type === 'text' && block.text) texts.push(block.text)
      }
    }
    const sample = texts.join('\n').trim()
    if (!sample) return 'zh-CN'
    return cjkRatio(sample) > 0.15 ? 'zh-CN' : 'en'
  } catch {
    return 'zh-CN'
  }
}

/** Resolve the effective locale: explicit config wins; 'auto' detects; fallback zh-CN. */
export function resolveLocale(configLocale: LocaleConfig | undefined, sessions: unknown, sessionId?: string): Locale {
  if (configLocale === 'zh-CN' || configLocale === 'en') return configLocale
  return detectLocaleFromSession(sessions, sessionId)
}

