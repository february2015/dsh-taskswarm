/**
 * Conversational supervisor — ported from TaskPlane
 * `extensions/taskplane/supervisor.ts` (github.com/HenryLach/taskplane, MIT).
 *
 * TaskPlane's supervisor shares the operator's session: after `/orch` it
 * activates to monitor the batch, reports significant events, classifies
 * every recovery action (diagnostic / tier0_known / destructive), and asks
 * the operator before destructive actions unless autonomy allows otherwise.
 *
 * DSH adaptation: the operator's session agent IS the supervisor. The
 * orchestrator registers a supervisor persona section + two tools
 * (`tswarm_supervisor_status` diagnostic, `tswarm_supervisor_control` actions) on
 * the invoking session agent, and wakes it with a `[TaskSwarm supervisor]` event
 * report whenever the engine emits a decision-worthy lifecycle event. The
 * agent then inspects state (read/status tools), classifies its next action,
 * and either acts or asks the operator — per {@link requiresConfirmation}.
 *
 * Ported verbatim: {@link requiresConfirmation}, {@link ACTION_CLASSIFICATION_EXAMPLES},
 * the supervisor prompt structure (Identity / Context / Capabilities /
 * Standing Orders / Classification / Autonomy). Rewritten for DSH: event
 * contract (engine onEvent), tools, `.taskswarm` state paths.
 *
 * Deferred from the full port (supervisor.ts ~4.7k lines): audit-trail JSONL,
 * branch-protection detection, CI/PR lifecycle, rich batch-summary markdown.
 * @module taskswarm/orchestrator/supervisor
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { TaskSwarmEvent, TaskSwarmEngine } from './engine.ts'
import type { DashboardManager } from './dashboard.ts'
import { formatBatchStatus, type BatchState, type LaneState } from '../core/status.ts'
import { formatWavePlan, scanTasks, buildWaves } from '../core/discover.ts'
import { parsePrompt, promptFilePath, type TaskPacket } from '../core/task.ts'
import { messages, detectLocaleFromSession, type Locale, type LocaleState } from './i18n.ts'
import { writeSetting, removeSetting, repoConfigPath } from './settings.ts'

/**
 * 粗估批次剩余时长。基于已完成 lane 的平均耗时 × 剩余 lane 数 ÷ 当前并行度。
 * 无已完成 lane 时返回"估算中"。纯启发式，供 supervisor 汇报 ETA 用。
 * 文案随 locale 双语。
 */
export function estimateEta(state: BatchState, locale: Locale): string {
  const m = messages(locale)
  const done = state.lanes.filter((l) => l.phase === 'merged' || l.phase === 'failed' || l.phase === 'skipped')
  const remaining = state.lanes.filter((l) => l.phase === 'pending' || l.phase === 'running' || l.phase === 'review' || l.phase === 'conflict')
  if (remaining.length === 0) return m.etaDone
  const durations = done
    .map((l) => (l.endedAt && l.startedAt ? Date.parse(l.endedAt) - Date.parse(l.startedAt) : NaN))
    .filter((d) => Number.isFinite(d) && d > 0)
  if (durations.length === 0) return m.etaEstimating
  const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length
  const parallel = Math.max(1, state.lanes.filter((l) => l.phase === 'running').length)
  const etaMs = (remaining.length * avgMs) / parallel
  const mins = Math.max(1, Math.round(etaMs / 60_000))
  const avgSec = Math.round(avgMs / 1000)
  const base = durations.length === 1 ? m.etaBaseOne(avgSec) : m.etaBaseMany(durations.length, avgSec)
  return m.etaFmt(mins, base, avgSec, remaining.length, parallel)
}

/** Supervisor autonomy levels (ported from TaskPlane `SupervisorAutonomyLevel`). */
export type SupervisorAutonomyLevel = 'interactive' | 'supervised' | 'autonomous'
/** Plugin-level toggle: 'off' disables the supervisor entirely. */
export type SupervisorMode = 'off' | SupervisorAutonomyLevel

/** Recovery action classification (ported from TaskPlane). */
export type RecoveryActionClassification = 'diagnostic' | 'tier0_known' | 'destructive'

export interface SupervisorEngineRef {
  engine: TaskSwarmEngine
  repoRoot: string
  tasksRoot: string
  stateRoot: string
  /** 会话语言状态（可变；supervisor 工具可文字切换并持久化到 config.json）。 */
  locale: LocaleState
}

/**
 * Whether an action of the given classification needs operator confirmation
 * under the given autonomy level. Ported verbatim from TaskPlane
 * `requiresConfirmation` (supervisor.ts:102).
 * - diagnostics never require confirmation
 * - autonomous never asks
 * - interactive asks for everything non-diagnostic
 * - supervised auto-acts on tier0_known, asks for destructive
 */
export function requiresConfirmation(classification: RecoveryActionClassification, autonomy: SupervisorAutonomyLevel): boolean {
  if (classification === 'diagnostic') return false
  if (autonomy === 'autonomous') return false
  if (autonomy === 'interactive') return true
  return classification === 'destructive'
}

/**
 * Example actions per classification, used by the system prompt to guide the
 * supervisor. Ported from TaskPlane `ACTION_CLASSIFICATION_EXAMPLES`
 * (supervisor.ts:127), paths/tools adapted to DSH/TaskSwarm.
 */
export const ACTION_CLASSIFICATION_EXAMPLES: Readonly<Record<RecoveryActionClassification, readonly string[]>> = {
  diagnostic: [
    'Reading .taskswarm/batches/*.json, tasks/*/STATUS.md, lane logs',
    'Running git status / git log / git diff / git worktree list',
    'Running test suites (npm test / node --test)',
    'Inspecting lanes and worktrees (tswarm_supervisor_status)',
    'Reading any file for diagnostics',
  ],
  tier0_known: [
    'Retrying a failed or timed-out merge',
    'Resuming a paused batch (tswarm_supervisor_control resume)',
    'Pausing after the current wave (tswarm_supervisor_control pause)',
    'Clearing a git lock file (.git/index.lock)',
    'Cleaning up stale worktrees before a retry',
  ],
  destructive: [
    'Aborting the batch (tswarm_supervisor_control abort)',
    'Merging taskswarm/orch into the working branch (tswarm_supervisor_control integrate)',
    'Running git reset / git checkout -B / git branch -D',
    'Removing worktrees (git worktree remove)',
    'Modifying STATUS.md / .DONE / batch-state files',
    'Skipping tasks or waves',
  ],
}

function autonomyDescription(autonomy: SupervisorAutonomyLevel): string {
  switch (autonomy) {
    case 'interactive':
      return 'Interactive: you must ask the operator before any non-diagnostic action (including resume/pause); only pure diagnostics run automatically.'
    case 'autonomous':
      return 'Autonomous: act on your own for every classification; after acting, report what you did and why.'
    default:
      return 'Supervised: diagnostics and tier0_known recovery run automatically; destructive actions (abort, integrate, branch/worktree mutations) require a one-line confirmation from the operator first.'
  }
}

/** 自主度一句话规则（供精简提示词复用）。双语。 */
export function autonomyRule(autonomy: SupervisorAutonomyLevel, locale: Locale): string {
  if (locale === 'en') {
    switch (autonomy) {
      case 'interactive':
        return 'ask the operator before any non-diagnostic action.'
      case 'autonomous':
        return 'act on all actions yourself; report in one sentence afterwards.'
      default:
        return 'tier0_known runs automatically; destructive actions require a one-line confirmation from the operator first.'
    }
  }
  switch (autonomy) {
    case 'interactive':
      return '非 diagnostic 动作一律先征求确认。'
    case 'autonomous':
      return '所有动作自主执行，事后一句话汇报。'
    default:
      return 'tier0_known 自动执行；destructive 先征求一句确认。'
  }
}

/**
 * Supervisor system prompt — 精简版（结构源自 TaskPlane supervisor.ts:2335，
 * 已大幅压缩以降低每次唤醒的 token 成本）。批上下文在注册时填充；
 * 唤醒消息携带更新状态。文案随 locale 双语。
 */
export function buildSupervisorSystemPrompt(
  autonomy: SupervisorAutonomyLevel,
  context: { batchId?: string; phase?: string; progress?: string; stateRoot?: string },
  locale: Locale = 'zh-CN',
): string {
  const ctx = [
    `- **Batch:** ${context.batchId ?? '—'} | **Phase:** ${context.phase ?? 'idle'}`,
    context.progress ? `- **Progress:** ${context.progress}` : '',
    `- **State root:** ${context.stateRoot ?? '.taskswarm/'}`,
  ].filter(Boolean).join('\n')
  if (locale === 'en') {
    return `# TaskSwarm Supervisor

You are the batch supervisor, sharing this session with the operator (activated after /tswarm starts a batch). On a [TaskSwarm supervisor] event:
1. Verify state with tswarm_supervisor_status;
2. Classify actions: diagnostic (read-only checks, always allowed) / tier0_known (resume, pause, clearing locks, known recoveries) / destructive (abort, integrate, state changes);
3. Act per autonomy: ${autonomyRule(autonomy, 'en')}
4. For routine notices (wave complete / periodic report / stall without anomaly) reply in ≤2 sentences with no extra checks or lists; only expand into verification and handling on failure / REVISE / batch completion / a confirmed stall.
5. Standard procedures for cleanup / error recovery / work salvage are in the repo's docs/runbook.md — read it before handling.
6. Notifications are already in complete, human-readable language — do NOT translate or repeat them. Judge only whether there is an anomaly or an action needed: if yes, handle/report it briefly; if no, stay quiet or acknowledge in one short line. Never restate the batch status.

${ctx}

Normal user conversation is unaffected.`
  }
  return `# TaskSwarm Supervisor

你是 batch supervisor，与 operator 共享此会话（/tswarm 启动批次后激活）。收到 [TaskSwarm supervisor] 事件后：
1. 用 tswarm_supervisor_status 查证状态；
2. 分类动作：diagnostic（只读查证，永远可做）/ tier0_known（resume、pause、清锁等已知恢复）/ destructive（abort、integrate、改状态）；
3. 按自主度执行：${autonomyRule(autonomy, 'zh-CN')}
4. 常规提醒（wave 完成 / 定时汇报 / 卡住无异常）回复 ≤2 句，不做额外查证不列表；仅失败 / REVISE / batch 完成 / 确认真卡住才展开查证处理。
5. 清理残留 / 错误恢复 / 工作抢救的标准步骤见仓库 docs/runbook.zh-CN.md，处理前先读它。
6. 通知已是完善的、可直接阅读的语言——**不要翻译、不要复述**。只需判断是否有异常或需要动作：有异常就简要处理/汇报；无异常保持安静或一句话确认即可，绝不重述批次状态。

${ctx}

普通用户对话不受影响。`
}

/** Events that wake the supervisor agent. `lane-done` stays informational. */
export function shouldWake(event: TaskSwarmEvent): boolean {
  return event.type !== 'lane-done'
}

/** One-line event headline, shown first in the wake message. 双语。 */
export function eventHeadline(event: TaskSwarmEvent, locale: Locale): string {
  const m = messages(locale)
  switch (event.type) {
    case 'batch-started':
      return m.batchStarted(event.batchId, event.total ?? 0)
    case 'lane-failed':
      return m.laneFailed(event.lane ?? 0, event.taskId ?? '', event.error)
    case 'lane-revise':
      return m.laneRevise(event.lane ?? 0, event.taskId ?? '')
    case 'wave-complete':
      return m.waveComplete(event.waveIndex ?? 0, event.totalWaves ?? 0, event.merged ?? 0, event.failed ?? 0)
    case 'batch-complete':
      return m.batchComplete(event.batchId, event.merged ?? 0, event.total ?? 0, event.failed ?? 0)
    case 'batch-aborted':
      return m.batchAborted(event.batchId)
    default:
      return `[TaskSwarm supervisor] ${String(event.type)}`
  }
}

/** Wake message handed to the session agent（指引已由系统提示承载；状态用精简渲染+ETA）。 */
export function supervisorEventReport(event: TaskSwarmEvent, state: BatchState | null, locale: Locale): string {
  const m = messages(locale)
  const lines = [eventHeadline(event, locale), '']
  if (state) {
    lines.push(compactBatchStatus(state, locale))
    lines.push(`\n${m.etaLabel}${estimateEta(state, locale)}`)
    // 每次通知附带该批次 worker 会话磁盘占用（operator 要求）。
    const usage = m.sessionsUsage(formatBytes(sessionsBytes(state.lanes)))
    lines.push(usage)
    // 批次全成功（所有任务已合并）→ 提醒用户决定是否清理 worker 会话历史。
    if (event.type === 'batch-complete' && (event.failed ?? 0) === 0) {
      lines.push(m.cleanupOffer(formatBytes(sessionsBytes(state.lanes))))
    }
  } else {
    lines.push(m.noBatchState)
  }
  // 每条通知附带嘱咐：无需翻译/复述，只判断异常（省 token，防模型复述）。
  lines.push('', m.noRestate)
  return lines.join('\n')
}

/** 人类可读字节数（B/KB/MB/GB）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** lane worktree → ~/.dsh/sessions/--<path>--/ 目录（与 DSH 实际命名一致：去开头 /，其余 / 转 -，前后 --）。 */
export function laneSessionDir(worktree: string): string {
  const normalized = worktree.replace(/^\//, '').replace(/\//g, '-')
  return join(homedir(), '.dsh', 'sessions', `--${normalized}--`)
}

/** 该批次所有 lane 的 worker 会话目录（只含磁盘上真实存在的，去重）。 */
export function laneSessionDirs(lanes: LaneState[]): string[] {
  const dirs: string[] = []
  for (const l of lanes) {
    if (!l.worktree) continue
    const dir = laneSessionDir(l.worktree)
    if (existsSync(dir)) dirs.push(dir)
  }
  return [...new Set(dirs)]
}

/** 递归统计目录字节数。 */
function dirBytes(dir: string): number {
  let total = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      const st = statSync(full)
      total += st.isDirectory() ? dirBytes(full) : st.size
    } catch {
      // unreadable entry — skip
    }
  }
  return total
}

/** 该批次 worker 会话磁盘占用（字节）。 */
export function sessionsBytes(lanes: LaneState[]): number {
  return laneSessionDirs(lanes).reduce((acc, dir) => acc + dirBytes(dir), 0)
}

/** 删除该批次所有 lane 的 worker 会话目录。返回删除的目录数与释放字节数。 */
export function deleteLaneSessions(lanes: LaneState[]): { dirs: number; bytes: number } {
  let bytes = 0
  let dirs = 0
  for (const dir of laneSessionDirs(lanes)) {
    bytes += dirBytes(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
      dirs++
    } catch {
      // best-effort: 删不掉就跳过
    }
  }
  return { dirs, bytes }
}

/**
 * 从 batch lanes 重算波次计划（与 dashboard adapter 同源）：按 lane 的 taskId
 * 从 tasks root 扫描任务并拓扑分层，保证 wavePlan 与 batch.lanes 对齐。
 * 兜底：lanes 存在但任务根目录扫不到时，全部塞进单波保持可读。
 */
function recomputeWavePlan(state: BatchState): string[][] {
  // 2026-08-17 修复：优先用引擎持久化的原始 wave plan（v0.2.31 起批次启动时定死）——
  // 否则 paused + wave 内 failed 时会重算成错误的 wave 结构（如 3 波变 1 波），
  // 且 currentWaveIndex 会误判"已推进到下一波"（JM-406 场景：pause 后显示波次 2）。
  if (Array.isArray(state.wavePlan) && state.wavePlan.length > 0) return state.wavePlan
  const laneTaskIds = state.lanes.map((l) => l.taskId)
  const byTaskId = new Map(scanTasks(state.tasksRoot, true).map((d) => [d.task.id, d]))
  const batchTasks = laneTaskIds
    .map((tid) => byTaskId.get(tid)?.task)
    .filter((t): t is TaskPacket => !!t)
  let wavePlan = buildWaves(batchTasks).waves.map((wave) => wave.map((t) => t.id))
  if (wavePlan.length === 0 && laneTaskIds.length > 0) wavePlan = [[...laneTaskIds]]
  return wavePlan
}

/**
 * 当前执行波次索引（0-based）。优先含 running/review lane 的波（执行中）；
 * 无执行中 lane 时取第一个含 pending lane 的波（波次边界/即将执行）；
 * 全部完成时取最后一波。
 */
export function currentWaveIndex(wavePlan: string[][], lanes: LaneState[]): number {
  const byTask = new Map(lanes.map((l) => [l.taskId, l]))
  for (let i = 0; i < wavePlan.length; i++) {
    if (wavePlan[i].some((tid) => {
      const l = byTask.get(tid)
      return !!l && (l.phase === 'running' || l.phase === 'review' || l.phase === 'conflict')
    })) return i
  }
  for (let i = 0; i < wavePlan.length; i++) {
    if (wavePlan[i].some((tid) => {
      const l = byTask.get(tid)
      return !!l && l.phase === 'pending'
    })) return i
  }
  return Math.max(0, wavePlan.length - 1)
}

/**
 * 任务步骤进度 `checked/total`：已勾选数读 STATUS.md（worker 实时更新），
 * 总步数优先来自 PROMPT.md（任务包设计时写死，稳定存在），STATUS.md 缺 Step 段
 * （手工/旧模板）时用 PROMPT 的 checkbox 总数兜底——这样即使第一步还没完成，
 * 也显示 `0/N`，让用户知道任务一共 N 步。
 * 两者都拿不到时返回 ''（不展示）。
 */
export function laneProgress(lane: LaneState, taskFolders: Map<string, string>): string {
  const statusDir = lane.worktree && existsSync(join(lane.worktree, 'STATUS.md')) ? lane.worktree : taskFolders.get(lane.taskId)
  let checked = 0
  let total = 0
  if (statusDir) {
    try {
      const content = readFileSync(join(statusDir, 'STATUS.md'), 'utf-8')
      checked = (content.match(/- \[x\]/gi) || []).length
      total = checked + (content.match(/- \[ \]/g) || []).length
    } catch {
      // 读不到 STATUS 时走 PROMPT 兜底
    }
  }
  if (total === 0) {
    // STATUS.md 无 Step 段（手工/旧模板）：用 PROMPT.md 的 checkbox 总数兜底，
    // 已勾选视为 0（进度显示"还没动"但知道总步数）。
    const promptDir = taskFolders.get(lane.taskId)
    if (promptDir && existsSync(promptFilePath(promptDir))) {
      try {
        const packet = parsePrompt(promptFilePath(promptDir), promptDir, '')
        if (packet) total = packet.steps.reduce((n, s) => n + s.items.length, 0)
      } catch {
        // ignore
      }
    }
  }
  return total > 0 ? `${checked}/${total}` : ''
}

/**
 * 精简版批次状态（supervisor 消息用）：batch id + phase + 当前 Wave 行 +
 * 只列当前执行波次内的 lane（每行带步骤进度 checked/total），
 * 去掉完整时间戳/scope 冗余与未开始波次的 lane。
 */
export function compactBatchStatus(state: BatchState, locale: Locale = 'zh-CN'): string {
  // 2026-08-17 修复：done 只算 merged（真正完成）；failed 单独在行首展示，避免
  // "1/6 done" 实为 1 失败 5 未开始的误导。
  const merged = state.lanes.filter((l) => l.phase === 'merged').length
  const failed = state.lanes.filter((l) => l.phase === 'failed').length
  const done = merged
  const wavePlan = recomputeWavePlan(state)
  const waveIdx = currentWaveIndex(wavePlan, state.lanes)
  const phaseNames: Record<string, string> = {
    running: '运行中', review: '评审中', conflict: '冲突待处置', merged: '已合并',
    failed: '失败', pending: '等待中', skipped: '已跳过',
  }
  const failedNote = failed > 0 ? (locale === 'zh-CN' ? `，${failed} 失败` : `, ${failed} failed`) : ''
  // 2026-08-17 修复：paused 时明确"暂停于波次 N"（N = 下一个待执行波），而不是显示
  // "波次 N+1" 让人误以为已推进——JM-406 场景（wave1 failed + pause）曾误导 supervisor。
  // 但"暂停于波次 N 前"≠ 前面的波都成功了：必须检查已执行波里的 lane 是否都正常 merged
  // （有 failed/conflict 就明确标注），避免把"波次 1 有失败"误读成"波次 1 全部完成"。
  const paused = state.phase === 'paused'
  let waveLabel: string
  if (paused) {
    // 暂停点 = 第一个还有未终结 lane（pending/running/review/conflict）的波；全部终结
    // （最后波失败触发 pause）则没有"下一个波"——直接说明"已执行完全部波次"。
    const laneByTask = new Map(state.lanes.map((l) => [l.taskId, l]))
    const nextWave = wavePlan.findIndex((tids) => tids.some((tid) => {
      const l = laneByTask.get(tid)
      return !!l && l.phase !== 'merged' && l.phase !== 'failed' && l.phase !== 'skipped'
    }))
    const base = nextWave >= 0
      ? (locale === 'zh-CN'
          ? `，暂停于波次 ${nextWave + 1}/${wavePlan.length} 前`
          : `, paused before wave ${nextWave + 1}/${wavePlan.length}`)
      : (locale === 'zh-CN'
          ? `，暂停于全部波次执行完后`
          : `, paused after all waves executed`)
    // 引擎在波次边界暂停：暂停点之前的波已执行完，之后的波全是 pending（不可能 failed）。
    // 扫描全部波，凡有 failed/conflict lane 的波都列出——它们才是"没正常成功"的部分。
    const abnormal: string[] = []
    wavePlan.forEach((tids, i) => {
      const waveLanes = tids.map((tid) => laneByTask.get(tid)).filter((l): l is LaneState => !!l)
      const waveFailed = waveLanes.filter((l) => l.phase === 'failed').length
      const waveConflict = waveLanes.filter((l) => l.phase === 'conflict').length
      if (waveFailed === 0 && waveConflict === 0) return
      if (locale === 'zh-CN') {
        const bits: string[] = []
        if (waveFailed > 0) bits.push(waveFailed === 1 ? '失败任务' : `${waveFailed} 个失败任务`)
        if (waveConflict > 0) bits.push(waveConflict === 1 ? '冲突待处置' : `${waveConflict} 个冲突待处置`)
        abnormal.push(`波次 ${i + 1} 有${bits.join('、')}`)
      } else {
        const bits: string[] = []
        if (waveFailed > 0) bits.push(`${waveFailed} failed`)
        if (waveConflict > 0) bits.push(`${waveConflict} conflict`)
        abnormal.push(`wave ${i + 1} has ${bits.join(', ')}`)
      }
    })
    const abnormalNote = abnormal.length > 0
      ? (locale === 'zh-CN' ? `（${abnormal.join('；')}）` : ` (${abnormal.join('; ')})`)
      : ''
    waveLabel = base + abnormalNote
  } else {
    waveLabel = locale === 'zh-CN' ? `· 波次 ${waveIdx + 1}/${wavePlan.length}` : `· Wave ${waveIdx + 1}/${wavePlan.length}`
  }
  const lines = [
    locale === 'zh-CN'
      ? `批次 ${state.id} — ${state.phase}（已完成 ${done}/${state.lanes.length}${failedNote}）${waveLabel}`
      : `Batch ${state.id} — ${state.phase} (${done}/${state.lanes.length} done${failedNote})${waveLabel}`,
  ]
  const current = new Set(wavePlan[waveIdx] ?? [])
  const taskFolders = new Map(scanTasks(state.tasksRoot, true).map((d) => [d.task.id, d.task.folder]))
  for (const l of state.lanes) {
    // paused 时展示所有已终结的 lane（merged/failed/skipped）——引擎在波次边界暂停，
    // 已执行波全部终结、下一波全 pending；只按 current（下一波）过滤会把暂停原因
    // （failed/conflict lane）一起过滤掉，所以 paused 模式不按波过滤、只跳 pending。
    if (paused && l.phase === 'pending') continue
    if (!paused && !current.has(l.taskId)) continue
    const progress = laneProgress(l, taskFolders)
    const steps = l.worktree ? workerStepCountFromSessions(l.worktree) : 0
    const bits: string[] = []
    if (progress) bits.push(locale === 'zh-CN' ? `步骤 ${progress}` : `steps ${progress}`)
    if (steps > 0) bits.push(locale === 'zh-CN' ? `${steps} 步` : `${steps} steps`)
    const tail = bits.length > 0 ? ` · ${bits.join('，')}` : ''
    const phase = phaseNames[l.phase] ?? l.phase
    lines.push(`  lane ${l.lane} [${phase}] ${l.taskId}${tail}`)
  }
  return lines.join('\n')
}

/**
 * 读 lane worker 会话日志的最大 `step`（累计执行步数：每次工具调用/回复 +1）。
 * 会话目录 `~/.dsh/sessions/--<worktree>--/`；JSONL(.zstd) 解压后取最大 step。
 * 任何失败返回 0，不抛异常。
 */
function workerStepCountFromSessions(worktree: string): number {
  try {
    const dirName = `--${worktree.replace(/^\//, '').replace(/\//g, '-')}--`
    const dir = join(homedir(), '.dsh', 'sessions', dirName)
    let sessions: string[] = []
    try {
      sessions = readdirSync(dir)
    } catch {
      return 0
    }
    let maxStep = 0
    for (const sessionId of sessions) {
      let files: string[] = []
      try {
        files = readdirSync(join(dir, sessionId)).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'))
      } catch {
        continue
      }
      for (const f of files) {
        const full = join(dir, sessionId, f)
        let text = ''
        try {
          if (f.endsWith('.zstd')) {
            text = execFileSync('zstd', ['-dc', full], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: 5000 })
          } else {
            text = readFileSync(full, 'utf8')
          }
        } catch {
          continue
        }
        for (const m of text.matchAll(/"step":(\d+)/g)) {
          const n = Number(m[1])
          if (Number.isFinite(n) && n > maxStep) maxStep = n
        }
      }
    }
    return maxStep
  } catch {
    return 0
  }
}

/**
 * Register the supervisor persona + tools on a live session agent context.
 * Safe to call once per engine (the orchestrator guards by repo).
 */
export function registerSupervisor(
  agentCtx: Context,
  getRef: () => SupervisorEngineRef | { error: string } | undefined,
  autonomy: SupervisorAutonomyLevel,
  periodic?: PeriodicControl,
  /** 共享 dashboard 管理器（与 /tswarm 命令同源）；缺省时 dashboard 工具不可用。 */
  dashboards?: DashboardManager,
): void {
  // ── supervisor 提示词段：可热替换（dispose 旧段后按当前语言重注册）──
  let systemPromptService: { section?(opts: { name: string; order: number; text: string }): (() => void) | undefined } | undefined
  try {
    systemPromptService = agentCtx.get('systemPrompt') as typeof systemPromptService
  } catch {
    // non-fatal
  }
  let disposePrompt: (() => void) | undefined
  const registerPrompt = (promptLocale: Locale): void => {
    try {
      disposePrompt?.()
      disposePrompt = systemPromptService?.section?.({
        name: 'taskswarm:supervisor',
        order: 90,
        text: buildSupervisorSystemPrompt(autonomy, {}, promptLocale),
      }) ?? undefined
    } catch {
      disposePrompt = undefined
    }
  }
  const ref = getRef()
  registerPrompt(ref && 'locale' in ref ? (ref as SupervisorEngineRef).locale.value : 'zh-CN')
  const tools = agentCtx.get('tools') as { register(def: unknown): unknown } | undefined
  if (!tools) return
  const register = (def: unknown): void => {
    try {
      tools.register(def)
    } catch {
      // duplicate/incompatible registration must not break the session
    }
  }
  const refOf = (): SupervisorEngineRef | { error: string } | undefined => getRef()
  const uninitialized = { ok: false, text: 'TaskSwarm 引擎未初始化（先运行 /orch）' } as const
  // 注册该工具的会话 agent：作为 batch owner，让事件只回发到本会话（避免跨会话串消息）。
  const toolOwner = (agentCtx as unknown as { agent?: unknown }).agent
  const toolSessionId = (agentCtx as unknown as { agent?: { session?: { id?: string } } }).agent?.session?.id

  register(defineTool({
    name: 'tswarm_supervisor_status',
    description: 'TaskSwarm supervisor：查看当前 batch / lane 状态（.taskswarm 状态 + taskswarm/orch 分支）。诊断类动作，无需确认。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const state = ref.engine.status()
      return { ok: true, text: state ? formatBatchStatus(state) : 'No TaskSwarm batch yet.' }
    },
  }))

  register(defineTool({
    name: 'tswarm_supervisor_control',
    description: 'TaskSwarm supervisor 控制。动作分类：status=diagnostic；resume/pause=tier0_known；integrate/abort=destructive（按自主度可能需先征求 operator 确认）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'plan', 'start', 'integrate', 'resume', 'pause', 'abort'],
        description: '要执行的控制动作（plan=展示波次计划；start 用 scope 指定任务，如 WEB-006 / all；空项目会自动初始化示例任务）。',
      },
      scope: { type: 'string', description: 'start 动作的任务 scope（任务 ID / all / 路径），默认 all。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const { engine } = ref
      const action = args.action as string
      switch (action) {
        case 'status': {
          const s = engine.status()
          return { ok: true, text: s ? formatBatchStatus(s) : 'No TaskSwarm batch yet.' }
        }
        case 'plan': {
          const scope = (args.scope as string | undefined)?.trim() || 'all'
          const { waves, count } = engine.plan(scope)
          return {
            ok: true,
            text: count === 0
              ? `No tasks found under ${ref.tasksRoot}. 说需求让我先分析并生成任务包，或 start 会自动初始化示例任务。`
              : `${count} 个任务 / ${waves.waves.length} 个波次：\n${formatWavePlan(waves)}`,
          }
        }
        case 'start': {
          const running = engine.status()
          if (running && (running.phase === 'running' || running.phase === 'planning')) {
            return { ok: false, text: `批次 ${running.id} 正在运行，先等它结束或 abort 再启动新批次。` }
          }
          const scope = (args.scope as string | undefined)?.trim() || 'all'
          try {
            const handle = engine.run(scope, toolOwner)
            let text = `Batch ${handle.batchId} started (scope: ${scope})。`
            // 波次执行即自动拉起 dashboard 并把链接打印出来（正常跑着就想看状态）。
            if (dashboards) {
              const d = await dashboards.ensure(ref.repoRoot)
              text += d.ok ? `\n📊 Dashboard: ${d.url}` : `\n⚠️ Dashboard 启动失败：${d.text}`
            }
            return { ok: true, text }
          } catch (e) {
            return { ok: false, text: e instanceof Error ? e.message : String(e) }
          }
        }
        case 'integrate': {
          const r = engine.integrate()
          return { ok: r.ok, text: r.ok ? `Integrated: ${r.message}` : `Integration failed: ${r.message}` }
        }
        case 'resume': {
          // 传入调用者 agent（toolOwner）：重启后新对话续跑时，通知指向新对话而非旧 supervisorAgent。
          const ok = engine.resume(toolOwner)
          // 引擎重启后 resume 会从磁盘恢复未完成批次续跑（方案 A，KI-007）。
          return { ok, text: ok ? 'Batch resumed.' : 'No paused batch or recoverable batch to resume.' }
        }
        case 'pause': {
          const ok = engine.pause()
          return { ok, text: ok ? 'Batch will pause after the current wave.' : 'No running batch to pause.' }
        }
        case 'abort': {
          // abort 是批次级操作：scope 不生效，会终止整个批次（含未启动 lane）。
          // 带 scope 调用时先明确提示，避免 supervisor 误以为可以只 abort 单个 lane。
          const scope = (args.scope as string | undefined)?.trim()
          if (scope) {
            return {
              ok: false,
              text: `abort 是批次级操作：scope（${scope}）不生效，会终止整个批次（含所有未完成 lane）与运行中的 worker。确认要终止整个批次请不带 scope 再次执行 abort；仅想释放单个失联 lane 的调度槽，见 runbook §7.6（手动收尾 + 重启引擎，KI-007）。`,
            }
          }
          const ok = engine.abort()
          return { ok, text: ok ? 'Batch abort requested.' : 'No running batch to abort.' }
        }
        default:
          return { ok: false, text: `Unknown action: ${action}` }
      }
    },
  }))

  // ── tswarm_supervisor_locale：文字切换 supervisor 语言（写入 .taskswarm/config.json）──
  register(defineTool({
    name: 'tswarm_supervisor_locale',
    description: 'TaskSwarm supervisor 语言：查询/切换 supervisor 通知与提示词语言（zh-CN / en / auto 按会话自动检测）。operator 说"用英文汇报"/"用中文"等时调用；设置写入 .taskswarm/config.json 持久化。',
    parameters: {
      locale: {
        type: 'string',
        enum: ['zh-CN', 'en', 'auto'],
        description: '目标语言：zh-CN 中文 / en 英文 / auto 恢复为按会话语言自动检测。不传 = 查询当前。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const m = messages(ref.locale.value)
      const target = args.locale as 'zh-CN' | 'en' | 'auto' | undefined
      if (!target) {
        return { ok: true, text: m.localeCurrent(ref.locale.value) }
      }
      const resolved: Locale = target === 'auto'
        ? detectLocaleFromSession(agentCtx.get('sessions'), toolSessionId)
        : target
      ref.locale.value = resolved
      if (target === 'auto') {
        removeSetting(ref.stateRoot, 'locale')
      } else {
        writeSetting(ref.stateRoot, 'locale', resolved)
      }
      registerPrompt(resolved)
      return { ok: true, text: messages(resolved).localeSwitchedTo(resolved, repoConfigPath(ref.stateRoot)) }
    },
  }))

  if (periodic) {
    register(defineTool({
      name: 'tswarm_supervisor_report_interval',
      description: 'TaskSwarm supervisor 定时汇报：设置每隔 N 分钟汇报一次批次进度（minutes=0 关闭）。operator 要求"每隔 X 分钟汇报一次"时调用；不传参数则查询当前设置。设置写入 .taskswarm/config.json 持久化。',
      parameters: {
        minutes: { type: 'integer', description: '汇报间隔（分钟）。0 = 关闭定时汇报；不传 = 查询当前设置。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const ref = refOf()
        if (!ref || 'error' in ref) return uninitialized
        if (args.minutes === undefined) {
          return { ok: true, text: `当前定时汇报间隔：${periodic.getReportInterval()} 分钟（0 = 关闭）` }
        }
        const minutes = args.minutes as number
        const text = periodic.setReportInterval(minutes)
        // 持久化到仓库配置：跨重启生效（0 时移除键，回到默认关闭）
        if (minutes === 0) removeSetting(ref.stateRoot, 'reportIntervalMinutes')
        else writeSetting(ref.stateRoot, 'reportIntervalMinutes', minutes)
        return { ok: true, text: text }
      },
    }))
  }

  // ── tswarm_dashboard：文字指令启动 Web Dashboard（自动探测空闲端口；与 /tswarm 命令共享进程注册表）──
  register(defineTool({
    name: 'tswarm_dashboard',
    description: 'TaskSwarm Web Dashboard 管理：start（为当前仓库启动本地 dashboard server，自动探测空闲端口）/ status / stop。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'status', 'stop'],
        description: '操作：start 启动 / status 查询 / stop 停止。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      if (!dashboards) return { ok: false, text: 'dashboard 管理器未初始化。' }
      const repoRoot = ref.repoRoot
      const action = args.action as string
      if (action === 'status') {
        const s = dashboards.status(repoRoot)
        return { ok: true, text: s.running ? `Dashboard 运行中：${s.url}` : 'Dashboard 未启动（用 start 启动）。' }
      }
      if (action === 'stop') {
        return { ok: true, text: dashboards.stop(repoRoot).text }
      }
      // start
      const r = await dashboards.ensure(repoRoot)
      return r.ok
        ? { ok: true, text: `Dashboard 已启动：${r.url}（浏览器打开即可；stop 可停止）` }
        : { ok: false, text: `Dashboard 启动失败：${r.text}` }
    },
  }))

  // ── tswarm_supervisor_cleanup：批次 worker 会话历史清理（destructive，删除前需 operator 确认）──
  register(defineTool({
    name: 'tswarm_supervisor_cleanup',
    description: 'TaskSwarm 历史清理：status=估算当前批次 worker 会话磁盘占用；delete=删除该批次所有 lane 的 worker 对话历史文件（destructive，删除前先征求 operator 确认）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'delete'],
        description: 'status=仅估算占用；delete=删除当前批次所有 lane 的 worker 会话历史（含对话记录文件）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const ref = refOf()
      if (!ref || 'error' in ref) return uninitialized
      const state = ref.engine.status()
      if (!state) return { ok: true, text: 'No batch yet.' }
      const m = messages(ref.locale.value)
      const action = args.action as string
      if (action === 'delete') {
        const r = deleteLaneSessions(state.lanes)
        return { ok: true, text: `已删除 ${r.dirs} 个 worker 会话目录，释放 ${formatBytes(r.bytes)}。` }
      }
      return { ok: true, text: `${m.sessionsUsage(formatBytes(sessionsBytes(state.lanes)))}\n共 ${laneSessionDirs(state.lanes).length} 个 worker 会话目录。确认删除请用 action=delete（destructive，将不可恢复）。` }
    },
  }))
}

export interface PeriodicSupervisionOptions {
  /** 状态检查间隔（毫秒）。检查本身零成本（只读状态），默认 60s。 */
  checkIntervalMs?: number
  /** 距上次 lane 状态变化超过该时长仍无动静 → 唤醒一次"疑似卡住"提醒（默认 7 分钟）。 */
  stalledThresholdMs?: number
  /** 初始定时汇报间隔（分钟），来自 .taskswarm/config.json 的持久化设置（默认 0 = 关）。 */
  initialReportIntervalMinutes?: number
  /** 波次执行期间自动维持 dashboard：返回当前是否已在运行（只读，零成本）。 */
  dashboardStatus?: () => { running: boolean; url?: string }
  /** 波次执行期间 dashboard 未运行时拉起（幂等：已运行则直接返回链接）。 */
  ensureDashboard?: () => Promise<{ ok: boolean; url?: string; text?: string }>
}

export interface PeriodicControl {
  /** 设置定时进度汇报间隔（分钟）。0 = 关闭（默认）。返回给用户的确认文本。 */
  setReportInterval(minutes: number): string
  /** 当前定时汇报间隔（分钟），0 = 关闭。 */
  getReportInterval(): number
  /** 停止定时器。 */
  dispose(): void
}

/**
 * 定时检查/汇报（常驻）。
 *
 * **定时检查（总是开启）**：周期性读 batch 状态（零成本）。只做**卡住检测**——
 * 批次运行中距上次 lane 变化超过 `stalledThresholdMs` 仍无动静 → 唤醒一次
 * "疑似卡住"提醒（限一次，直到再次出现变化）。不做"有变化即汇报"。
 *
 * **定时汇报（默认关闭）**：通过 {@link PeriodicControl.setReportInterval} 设置
 * 间隔（分钟）后，每满一个间隔唤醒一次，汇报当前批次进度。默认 0（关），
 * 由 operator 要求时开启（"每隔 15 分钟汇报一次"）。
 *
 * batch 结束后自动重置，等待下一个 batch。进程级常驻定时器（cordis timer mixin
 * 无类型声明，用原生实现）。
 */
/**
 * 最近一次 worker 会话日志活动（毫秒时间戳）。把 lane worktree 绝对路径换算成
 * DSH 会话存储目录名（`/` → `-`，前后加 `--`，如
 * `--Users-robin-myProject-taskswarm-.taskswarm-worktrees-web-003--`），取其中
 * 会话子目录（前缀 `session-`）里 `session.jsonl(.zstd)` 的最新 mtime。找不到返回 0。
 */
export function latestSessionActivity(worktree: string): number {
  const dirName = `--${worktree.replace(/^\//, '').replace(/\//g, '-')}--`
  const sessionsRoot = join(homedir(), '.dsh', 'sessions')
  const dir = join(sessionsRoot, dirName)
  let latest = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let files: string[] = []
    try {
      files = readdirSync(full).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        latest = Math.max(latest, statSync(join(full, f)).mtimeMs)
      } catch {
        // ignore unreadable files
      }
    }
  }
  return latest
}

export function startPeriodicSupervision(
  getRef: () => SupervisorEngineRef | { error: string } | undefined,
  wake: (text: string) => void,
  options: PeriodicSupervisionOptions = {},
): PeriodicControl {
  const checkIntervalMs = options.checkIntervalMs ?? 60_000
  const stalledThresholdMs = options.stalledThresholdMs ?? 420_000
  const ensureDashboard = options.ensureDashboard
  const dashboardStatus = options.dashboardStatus
  // 定时汇报默认关闭；可用 settings 里的 reportIntervalMinutes 初始化为持久值
  const initialMinutes = options.initialReportIntervalMinutes ?? 0
  let reportIntervalMs = Math.round(initialMinutes * 60_000)
  let lastSnapshot = ''
  let lastChangeAt = 0
  let lastReportAt = initialMinutes > 0 ? Date.now() : 0
  let stalledWarned = false
  /** B2：progress-stall 检测——taskId → 上次 STATUS.md mtime（advance 会更新它）。
   *  会话活跃但 STATUS 长时间不动 → worker 可能在攒批，进度显示滞后。 */
  const statusMtimes = new Map<string, number>()
  const progressStalledWarned = new Set<string>()
  /** 本批次是否已通知过 dashboard 链接（自动拉起成功时只通知一次）。 */
  let dashboardNotifiedBatch: string | null = null

  /** 当前 locale（引擎 ref 上的可变状态；工具切换后即时生效）。 */
  const refLocale = (): Locale => {
    const ref = getRef()
    return ref && 'locale' in ref ? (ref as SupervisorEngineRef).locale.value : 'zh-CN'
  }

  const check = (): void => {
    const ref = getRef()
    if (!ref || 'error' in ref) return
    const m = messages(refLocale())
    const state = ref.engine.status()
    if (!state) return
    if (state.phase !== 'running' && state.phase !== 'planning' && state.phase !== 'paused') {
      // batch 结束：重置，等待下一个 batch
      lastSnapshot = ''
      lastChangeAt = 0
      lastReportAt = 0
      stalledWarned = false
      dashboardNotifiedBatch = null
      return
    }
    const now = Date.now()
    const fingerprint = state.lanes.map((l) => `${l.taskId}:${l.phase}`).join(',')
    if (fingerprint !== lastSnapshot) {
      lastSnapshot = fingerprint
      lastChangeAt = now
      stalledWarned = false
    } else if (!stalledWarned && now - lastChangeAt >= stalledThresholdMs) {
      // 卡住检测（默认开启）：lane 阶段不变 + worker 会话日志也超时无更新才算真卡住。
      // 会话仍在写说明 worker 在干活（写大段代码时 lane 阶段不变），不误报。
      const runningLanes = state.lanes.filter((l) => l.phase === 'running' || l.phase === 'review' || l.phase === 'conflict')
      const activities = runningLanes.map((l) => (l.worktree ? latestSessionActivity(l.worktree) : 0))
      const anyFound = activities.some((m) => m > 0)
      const allStale = activities.length > 0 && activities.every((m) => m > 0 && now - m >= stalledThresholdMs)
      if (anyFound && allStale) {
        stalledWarned = true
        lastReportAt = now
        const minutes = Math.round((now - lastChangeAt) / 60_000)
        wake(`${m.stalled(state.id, minutes)}\n${m.sessionsUsage(formatBytes(sessionsBytes(state.lanes)))}`)
      } else if (anyFound) {
        // 会话仍活跃：worker 在干活，重置无变化计时，避免每轮重复评估。
        lastChangeAt = now
      }
    }
    // B2 progress-stall 检测：running lane 会话活跃（在写代码），但 STATUS.md 长时间
    // 无 advance（mtime 不动）→ worker 可能在攒批。只提醒一次，不重复刷。
    if (now - lastChangeAt < stalledThresholdMs || stalledWarned) {
      // 仅在全批无变化计时未触发真卡住时才评估（避免与 stalled 重复打扰）
      const tasks = scanTasks(state.tasksRoot, true)
      for (const lane of state.lanes) {
        if (lane.phase !== 'running' || !lane.worktree) continue
        const packet = tasks.find((t) => t.task.id === lane.taskId)
        if (!packet) continue
        const statusPath = join(packet.task.folder, 'STATUS.md')
        let mtime = 0
        try {
          mtime = statSync(statusPath).mtimeMs
        } catch {
          continue
        }
        const last = statusMtimes.get(lane.taskId) ?? 0
        if (last === 0) {
          statusMtimes.set(lane.taskId, mtime)
          continue
        }
        if (mtime !== last) {
          statusMtimes.set(lane.taskId, mtime)
          progressStalledWarned.delete(lane.taskId)
          continue
        }
        // STATUS 未变：查会话是否活跃——活跃才提示攒批（不活跃由上面 stalled 管）。
        const activity = lane.worktree ? latestSessionActivity(lane.worktree) : 0
        if (activity > 0 && now - activity < stalledThresholdMs && !progressStalledWarned.has(lane.taskId)) {
          const staleFor = Math.round((now - mtime) / 60_000)
          if (staleFor >= Math.round(stalledThresholdMs / 60_000)) {
            progressStalledWarned.add(lane.taskId)
            wake(`${m.progressStalled(lane.lane, lane.taskId, staleFor)}`)
          }
        }
      }
    }
    // 波次执行期间自动维持 dashboard：未运行则拉起，成功拉起后通知一次链接
    // （覆盖引擎重启续跑、进程意外退出等"开始时未打印链接"的路径）。
    if (ensureDashboard) {
      const ds = dashboardStatus ? dashboardStatus() : { running: true }
      if (!ds.running) {
        void ensureDashboard()
          .then((r) => {
            if (r.ok && dashboardNotifiedBatch !== state.id) {
              dashboardNotifiedBatch = state.id
              wake(`${m.dashboardUrl(r.url ?? '')}`)
            }
          })
          .catch(() => {
            // 拉起失败：下轮检查静默重试，不打扰用户
          })
      }
    }
    // 定时汇报（默认关闭；operator 要求后按间隔唤醒）
    if (reportIntervalMs > 0 && now - lastReportAt >= reportIntervalMs) {
      lastReportAt = now
      const mins = Math.round(reportIntervalMs / 60_000)
      const eta = estimateEta(state, refLocale())
      const loc = refLocale()
      const etaLine = eta && eta !== m.etaLabel ? `${m.etaLabel}${eta}` : ''
      const usage = m.sessionsUsage(formatBytes(sessionsBytes(state.lanes)))
      wake([m.periodicReport(mins), compactBatchStatus(state, loc), etaLine, usage, m.noRestate].filter(Boolean).join('\n'))
    }
  }

  const timer = setInterval(check, checkIntervalMs)
  return {
    setReportInterval(minutes: number): string {
      const m = messages(refLocale())
      if (!Number.isFinite(minutes) || minutes < 0) return m.invalidInterval(minutes)
      reportIntervalMs = Math.round(minutes * 60_000)
      // 以设置时刻为基准：第一次汇报在完整间隔之后，而不是立即触发。
      lastReportAt = Date.now()
      return reportIntervalMs === 0 ? m.reportIntervalOff : m.reportIntervalOn(minutes)
    },
    getReportInterval(): number {
      return Math.round(reportIntervalMs / 60_000)
    },
    dispose(): void {
      clearInterval(timer)
    },
  }
}
