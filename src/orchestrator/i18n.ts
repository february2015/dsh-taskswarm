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
}

const zhCN: SupervisorMessages = {
  batchStarted: (id, total) => `[TaskSwarm supervisor] Batch ${id} 已启动（${total} 个任务）`,
  laneFailed: (lane, taskId, error) => `[TaskSwarm supervisor] ⚠️ lane ${lane} ${taskId} 失败${error ? `：${error}` : ''}`,
  laneRevise: (lane, taskId) => `[TaskSwarm supervisor] 🟡 lane ${lane} ${taskId} 待修订（reviewer REVISE）`,
  waveComplete: (wave, total, merged, failed) => `[TaskSwarm supervisor] 🌊 Wave ${wave}/${total} 完成：${merged} 成功 / ${failed} 失败`,
  batchComplete: (id, merged, total, failed) => `[TaskSwarm supervisor] ✅ Batch ${id} 完成：${merged}/${total} 成功，${failed} 失败`,
  batchAborted: (id) => `[TaskSwarm supervisor] ⛔ Batch ${id} 已中止`,
  etaLabel: '预计剩余：',
  noBatchState: '(no batch state)',
  stalled: (id, minutes) =>
    `[TaskSwarm supervisor] ⏱️ 疑似卡住：批次 ${id} 已约 ${minutes} 分钟无任何 lane 变化，且 worker 会话日志同样超时。` +
    '请用 tswarm_supervisor_status / 只读工具查证 lane 日志，判断是继续等待、pause 还是 abort。',
  periodicReport: (minutes) => `[TaskSwarm supervisor] ⏱️ 定时汇报（每 ${minutes} 分钟）：`,
  reportIntervalOn: (minutes) => `定时进度汇报已开启：每 ${minutes} 分钟汇报一次。`,
  reportIntervalOff: '定时进度汇报已关闭。',
  invalidInterval: (minutes) => `无效间隔：${minutes} 分钟（需要 ≥0 的整数，0=关闭）`,
  waveHeader: (current, total) => `当前 Wave: ${current}/${total}`,
  etaDone: '已完成',
  etaEstimating: '估算中（尚无已完成 lane）',
  etaBaseOne: (seconds) => `已完成 1 个 lane 用时 ${seconds}s`,
  etaBaseMany: (count, seconds) => `已完成 ${count} 个 lane 平均用时 ${seconds}s`,
  etaFmt: (minutes, base, _seconds, remaining, parallel) => `约 ${minutes} 分钟（${base} × ${remaining} 个剩余 lane ÷ 并行度 ${parallel}）`,
  localeCurrent: (locale) =>
    `当前 supervisor 语言：${locale === 'en' ? '英文 (en)' : '中文 (zh-CN)'}（说"用英文"/"用中文"可切换；"自动"恢复按会话语言检测）`,
  localeSwitchedTo: (locale, configPath) =>
    `已切换为${locale === 'en' ? '英文' : '中文'}，通知与 supervisor 提示词即时生效，并已写入 ${configPath}。`,
  dashboardUrl: (url) => `📊 Dashboard 已启动：${url}（浏览器打开即可查看实时进度）`,
}

const en: SupervisorMessages = {
  batchStarted: (id, total) => `[TaskSwarm supervisor] Batch ${id} started (${total} tasks)`,
  laneFailed: (lane, taskId, error) => `[TaskSwarm supervisor] ⚠️ lane ${lane} ${taskId} failed${error ? `: ${error}` : ''}`,
  laneRevise: (lane, taskId) => `[TaskSwarm supervisor] 🟡 lane ${lane} ${taskId} awaiting revision (reviewer REVISE)`,
  waveComplete: (wave, total, merged, failed) => `[TaskSwarm supervisor] 🌊 Wave ${wave}/${total} complete: ${merged} merged / ${failed} failed`,
  batchComplete: (id, merged, total, failed) => `[TaskSwarm supervisor] ✅ Batch ${id} complete: ${merged}/${total} merged, ${failed} failed`,
  batchAborted: (id) => `[TaskSwarm supervisor] ⛔ Batch ${id} aborted`,
  etaLabel: 'ETA: ',
  noBatchState: '(no batch state)',
  stalled: (id, minutes) =>
    `[TaskSwarm supervisor] ⏱️ Possibly stalled: batch ${id} has seen no lane changes for ~${minutes} minutes and worker session logs are stale too. ` +
    'Inspect lane logs with tswarm_supervisor_status / read-only tools, then decide: keep waiting, pause, or abort.',
  periodicReport: (minutes) => `[TaskSwarm supervisor] ⏱️ Periodic report (every ${minutes} min):`,
  reportIntervalOn: (minutes) => `Periodic progress reports enabled: every ${minutes} minutes.`,
  reportIntervalOff: 'Periodic progress reports disabled.',
  invalidInterval: (minutes) => `Invalid interval: ${minutes} minutes (must be an integer ≥ 0; 0 = off)`,
  waveHeader: (current, total) => `Current Wave: ${current}/${total}`,
  etaDone: 'Complete',
  etaEstimating: 'Estimating (no completed lanes yet)',
  etaBaseOne: (seconds) => `1 lane done in ${seconds}s`,
  etaBaseMany: (count, seconds) => `${count} lanes done, avg ${seconds}s`,
  etaFmt: (minutes, base, _seconds, remaining, parallel) => `~${minutes} min (${base} × ${remaining} remaining lanes ÷ parallelism ${parallel})`,
  localeCurrent: (locale) =>
    `Current supervisor language: ${locale === 'en' ? 'English (en)' : 'Chinese (zh-CN)'} (say "use English"/"use Chinese" to switch; "auto" re-detects from your session)`,
  localeSwitchedTo: (locale, configPath) =>
    `Switched to ${locale === 'en' ? 'English' : 'Chinese'} — notifications and the supervisor prompt take effect immediately, and the choice is saved to ${configPath}.`,
  dashboardUrl: (url) => `📊 Dashboard started: ${url} (open it in your browser for live progress)`,
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

