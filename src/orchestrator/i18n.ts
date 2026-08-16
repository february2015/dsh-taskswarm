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
  /** 最后一波完成时被暂停（无更多 pending 波，批次停在 paused 等用户处置）。 */
  wavePaused(wave: number, total: number, merged: number, failed: number): string
  batchComplete(id: string, merged: number, total: number, failed: number): string
  batchAborted(id: string): string
  etaLabel: string
  noBatchState: string
  stalled(id: string, minutes: number): string
  /** 会话活跃但 STATUS 长时间无 advance：worker 可能在攒批，进度显示滞后（B2）。 */
  progressStalled(lane: number, taskId: string, minutes: number): string
  /** 每条通知附带的嘱咐：无需翻译/复述，只判断异常（省 token）。 */
  noRestate: string
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
  // 通知用完善的本地化语言（用户直接可读，supervisor 无需翻译/复述——提示词已明确）。
  batchStarted: (id, total) => `[TaskSwarm] 批次已启动：${id}，共 ${total} 个任务`,
  laneFailed: (lane, taskId, error) => `[TaskSwarm] ⚠️ lane ${lane} ${taskId} 失败${error ? `：${error.slice(0, 100)}` : ''}`,
  laneRevise: (lane, taskId) => `[TaskSwarm] 🟡 lane ${lane} ${taskId} 待修订（reviewer REVISE）`,
  waveComplete: (wave, total, merged, failed) => `[TaskSwarm] 🌊 波次 ${wave}/${total} 完成：${merged} 个成功合并，${failed} 个失败`,
  wavePaused: (wave, total, merged, failed) => `[TaskSwarm] ⏸️ 已执行完波次 ${wave}/${total} 后暂停：${merged} 个成功合并，${failed} 个失败（等待处置）`,
  batchComplete: (id, merged, total, failed) => `[TaskSwarm] ✅ 批次完成：${merged}/${total} 成功合并，${failed} 个失败`,
  batchAborted: (id) => `[TaskSwarm] ⛔ 批次已中止：${id}`,
  etaLabel: '预计剩余：',
  noBatchState: '(无批次)',
  stalled: (id, minutes) =>
    `[TaskSwarm] ⏱️ 疑似卡住：${id} 已约 ${minutes} 分钟无变化且 worker 会话日志超时。` +
    '用 tswarm_supervisor_status 查证，决定继续等待 / 暂停 / 中止。',
  progressStalled: (lane, taskId, minutes) =>
    `[TaskSwarm] 🐢 进度停滞：lane ${lane} ${taskId} 会话活跃但约 ${minutes} 分钟未 advance——` +
    'worker 可能在攒批，提醒它每完成一步就 advance（进度显示与崩溃恢复依赖增量检查点）。',
  noRestate: '（收到后无需翻译或复述，只需判断有无异常/需要动作；无异常保持安静或一句话确认即可）',
  periodicReport: (minutes) => `[TaskSwarm] ⏱️ 定时汇报（每 ${minutes} 分钟）：`,
  reportIntervalOn: (minutes) => `定时汇报已开启：每 ${minutes} 分钟一次。`,
  reportIntervalOff: '定时汇报已关闭。',
  invalidInterval: (minutes) => `无效间隔：${minutes} 分钟（需要 ≥0 的整数，0=关闭）`,
  waveHeader: (current, total) => `当前波次：${current}/${total}`,
  etaDone: '已完成',
  etaEstimating: '估算中（尚无已完成 lane）',
  etaBaseOne: (seconds) => `1 个 lane 用时 ${seconds}s`,
  etaBaseMany: (count, seconds) => `${count} 个 lane 平均 ${seconds}s`,
  etaFmt: (minutes, base, _seconds, remaining, parallel) => `约 ${minutes} 分钟（${base} × ${remaining} 个剩余 lane ÷ 并行 ${parallel}）`,
  localeCurrent: (locale) =>
    `当前 supervisor 语言：${locale === 'en' ? '英文 (en)' : '中文 (zh-CN)'}（说"用英文"/"用中文"可切换；"自动"恢复按会话语言检测）`,
  localeSwitchedTo: (locale, configPath) =>
    `已切换为${locale === 'en' ? '英文' : '中文'}，通知与 supervisor 提示词即时生效，并已写入 ${configPath}。`,
  dashboardUrl: (url) => `📊 Dashboard 已启动：${url}`,
  sessionsUsage: (bytes) => `💾 本批次 worker 会话磁盘占用：${bytes}`,
  cleanupOffer: (bytes) =>
    `✅ 全部任务已成功合并。要清理本批次 worker 的会话历史（${bytes}）吗？回复「保留」或「删除」。`,
}

const en: SupervisorMessages = {
  // Complete, human-readable notifications (no translation/restating needed — prompt says so).
  batchStarted: (id, total) => `[TaskSwarm] Batch started: ${id}, ${total} tasks`,
  laneFailed: (lane, taskId, error) => `[TaskSwarm] ⚠️ lane ${lane} ${taskId} failed${error ? `: ${error.slice(0, 100)}` : ''}`,
  laneRevise: (lane, taskId) => `[TaskSwarm] 🟡 lane ${lane} ${taskId} awaiting revision (reviewer REVISE)`,
  waveComplete: (wave, total, merged, failed) => `[TaskSwarm] 🌊 Wave ${wave}/${total} complete: ${merged} merged, ${failed} failed`,
  wavePaused: (wave, total, merged, failed) => `[TaskSwarm] ⏸️ Paused after wave ${wave}/${total}: ${merged} merged, ${failed} failed (awaiting decision)`,
  batchComplete: (id, merged, total, failed) => `[TaskSwarm] ✅ Batch complete: ${merged}/${total} merged, ${failed} failed`,
  batchAborted: (id) => `[TaskSwarm] ⛔ Batch aborted: ${id}`,
  etaLabel: 'ETA: ',
  noBatchState: '(no batch)',
  stalled: (id, minutes) =>
    `[TaskSwarm] ⏱️ Possibly stalled: ${id} has seen no lane changes for ~${minutes} minutes and worker session logs are stale. ` +
    'Check with tswarm_supervisor_status, then decide: keep waiting / pause / abort.',
  progressStalled: (lane, taskId, minutes) =>
    `[TaskSwarm] 🐢 Progress stalled: lane ${lane} ${taskId} is active but has not advanced for ~${minutes} minutes — ` +
    'the worker may be batching; remind it to `advance` after each checkbox (progress display and crash recovery depend on incremental checkpoints).',
  noRestate: '（On receipt: do NOT translate or restate this message; judge only whether there is an anomaly or an action needed — if none, stay quiet or acknowledge in one short line.）',
  periodicReport: (minutes) => `[TaskSwarm] ⏱️ Periodic report (every ${minutes} minutes):`,
  reportIntervalOn: (minutes) => `Periodic reports enabled: every ${minutes} minutes.`,
  reportIntervalOff: 'Periodic reports disabled.',
  invalidInterval: (minutes) => `Invalid interval: ${minutes} minutes (must be an integer ≥ 0; 0 = off)`,
  waveHeader: (current, total) => `Current wave: ${current}/${total}`,
  etaDone: 'Complete',
  etaEstimating: 'Estimating (no completed lanes yet)',
  etaBaseOne: (seconds) => `1 lane in ${seconds}s`,
  etaBaseMany: (count, seconds) => `${count} lanes, avg ${seconds}s`,
  etaFmt: (minutes, base, _seconds, remaining, parallel) => `~${minutes} min (${base} × ${remaining} lanes ÷ parallel ${parallel})`,
  localeCurrent: (locale) =>
    `Current supervisor language: ${locale === 'en' ? 'English (en)' : 'Chinese (zh-CN)'} (say "use English"/"use Chinese" to switch; "auto" re-detects from your session)`,
  localeSwitchedTo: (locale, configPath) =>
    `Switched to ${locale === 'en' ? 'English' : 'Chinese'} — notifications and the supervisor prompt take effect immediately, and the choice is saved to ${configPath}.`,
  dashboardUrl: (url) => `📊 Dashboard started: ${url}`,
  sessionsUsage: (bytes) => `💾 Worker session disk usage (this batch): ${bytes}`,
  cleanupOffer: (bytes) =>
    `✅ All tasks merged successfully. Delete this batch's worker session history (${bytes})? Reply "keep" or "delete".`,
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

