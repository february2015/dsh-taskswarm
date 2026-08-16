/**
 * Task packets — PROMPT.md / STATUS.md conventions.
 * Adapted from TaskPlane (github.com/HenryLach/taskplane, MIT License):
 * `extensions/taskplane/discovery.ts` (parsePromptForOrchestrator) and
 * `extensions/taskplane/persistence.ts` (status conventions).
 *
 * PROMPT.md (immutable above the `---` divider):
 *   # Task: ID — Name
 *   **Size:** S | M | L | XL
 *   ## Dependencies        (bullets: `- ID`, `- **area/ID**`, or `**Requires:** ID`)
 *   ## Mission
 *   ### Step N: Title      (with `- [ ]` / `- [x]` items)
 *   ## Completion Criteria
 *
 * STATUS.md (worker-owned):
 *   **Status:** 🔵 Ready for Execution | 🟢 In Progress | 🟡 Review | ✅ Complete | ❌ Blocked
 *   **Current Step:** <name>
 *   ### Step N: Title / **Status:** ⬜|🟢|✅
 *   ## Execution Log  (| timestamp | action | outcome |)
 * @module taskswarm/core/task
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, basename } from 'node:path'

export type TaskStatus = 'ready' | 'running' | 'review' | 'done' | 'blocked'

export const STATUS_MARKER: Record<TaskStatus, string> = {
  ready: '🔵 Ready for Execution',
  running: '🟢 In Progress',
  review: '🟡 In Review',
  done: '✅ Complete',
  blocked: '❌ Blocked',
}

export const STEP_STATUS_MARKER = {
  pending: '⬜ Not Started',
  running: '🟢 In Progress',
  done: '✅ Complete',
} as const

export interface TaskStep {
  /** 0-based index, from the PROMPT.md `### Step N:` heading. */
  index: number
  title: string
  items: { text: string; checked: boolean }[]
}

export interface TaskPacket {
  id: string
  folder: string
  areaName: string
  name: string
  size: string
  reviewLevel: number
  deps: string[]
  mission: string
  steps: TaskStep[]
  completionCriteria: string[]
  fileScope: string[]
}

export interface TaskStatusInfo {
  status: TaskStatus
  currentStep: string
  done: boolean
  blockedReason?: string
  /** 已完成 checkbox 数 / 总 checkbox 数（KI-008：supervisor 汇报显示步数进度）。 */
  checked?: number
  total?: number
}

export function extractTaskIdFromFolderName(folderName: string): string | null {
  const match = folderName.match(/^([A-Z]+-\d+)/i)
  return match ? match[1].toUpperCase() : null
}

export function taskStatusFilePath(taskDir: string): string {
  return join(taskDir, 'STATUS.md')
}

export function promptFilePath(taskDir: string): string {
  return join(taskDir, 'PROMPT.md')
}

function section(content: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm')
  const match = content.match(re)
  if (!match) return ''
  const start = match.index! + match[0].length
  const next = content.slice(start).search(/^##\s+/m)
  return content.slice(start, next === -1 ? undefined : start + next)
}

function bulletIds(raw: string): string[] {
  const ids: string[] = []
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    let m = line.match(/^\s*[-*]\s+(?:\*\*)?([A-Z]+-\d+)/i)
    if (m) {
      ids.push(m[1].toUpperCase())
      continue
    }
    m = line.match(/^\s*(?:\*\*Requires?:\*\*|Requires?:)\s+([A-Z]+-\d+(?:[\s,]+[A-Z]+-\d+)*)/i)
    if (m) {
      for (const id of m[1].split(/[\s,]+/)) ids.push(id.toUpperCase())
    }
  }
  return ids
}

/**
 * Parse a PROMPT.md into a TaskPacket. Returns null when the task ID cannot be
 * determined (from the `# Task:` heading, then the folder name).
 */
export function parsePrompt(promptPath: string, taskFolder: string, areaName: string): TaskPacket | null {
  let content: string
  try {
    content = readFileSync(promptPath, 'utf-8')
  } catch {
    return null
  }

  let id: string | null = null
  let name = basename(taskFolder)
  const heading = content.match(/^#\s+Task:\s+([A-Z]+-\d+)\s*[-—]\s*(.+)$/m)
  if (heading) {
    id = heading[1]
    name = heading[2].trim()
  }
  if (!id) id = extractTaskIdFromFolderName(basename(taskFolder))
  if (!id) return null

  const sizeMatch = content.match(/^\*\*Size:\*\*\s*(\S+)/m)
  const reviewMatch = content.match(/^##\s+Review Level:\s*(\d+)/m)
  const mission = section(content, 'Mission').trim()
  const deps = bulletIds(section(content, 'Dependencies'))

  const steps: TaskStep[] = []
  const stepRe = /^###\s+Step\s+(\d+)\s*:\s*(.+)$/gm
  const stepMatches = [...content.matchAll(stepRe)]
  for (const m of stepMatches) {
    const index = Number(m[1])
    const title = m[2].trim()
    const start = m.index! + m[0].length
    const end = content.slice(start).search(/^(?:###\s+Step\s+\d+\s*:|##\s)/m)
    const body = content.slice(start, end === -1 ? undefined : start + end)
    const items: { text: string; checked: boolean }[] = []
    for (const line of body.split(/\r?\n/)) {
      const im = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/)
      if (im) items.push({ text: im[2].trim(), checked: im[1].toLowerCase() === 'x' })
    }
    steps.push({ index, title, items })
  }

  const criteria: string[] = []
  for (const line of section(content, 'Completion Criteria').split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+\[[ xX]\]\s+(.+)$/)
    if (m) criteria.push(m[1].trim())
  }

  const fileScope: string[] = []
  for (const line of section(content, 'File Scope').split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+(.+)$/)
    if (m) fileScope.push(m[1].trim())
  }

  return {
    id,
    folder: taskFolder,
    areaName,
    name,
    size: sizeMatch ? sizeMatch[1] : 'M',
    reviewLevel: reviewMatch ? Number(reviewMatch[1]) : 2,
    deps,
    mission,
    steps,
    completionCriteria: criteria,
    fileScope,
  }
}

/**
 * Explain why a PROMPT.md failed to parse (parsePrompt returned null).
 * Mirrors the ID-resolution logic in parsePrompt so the reason matches the
 * actual failure. Returns a human-readable reason string (never null when the
 * file exists but does not parse; callers may fall back to a generic message).
 */
export function explainParseFailure(promptPath: string, taskFolder: string): string {
  let content: string
  try {
    content = readFileSync(promptPath, 'utf-8')
  } catch {
    return 'PROMPT.md 不可读'
  }
  if (!content.trim()) return 'PROMPT.md 为空'
  const heading = content.match(/^#\s+Task:\s+([A-Z]+-\d+)\s*[-—]\s*(.+)$/m)
  if (!heading) {
    const hasTaskHeading = /^#\s+Task:/m.test(content)
    return hasTaskHeading
      ? '任务标题 ID 不合法：需形如 "T-1"（[A-Z]+-\\d+），例如 "# Task: T-1 — 名称"'
      : `缺少 "# Task: <ID> — <名称>" 标题（ID 须形如 "T-1"），且目录名 "${basename(taskFolder)}" 也无法推断 ID（需形如 "T-1-xxx"）`
  }
  return '未知解析失败'
}

/**
 * Structure-quality warnings for a packet that DID parse but may trip up
 * workers (no steps / no criteria / no file scope). Not fatal — the task
 * still runs — but worth surfacing via /tswarm-check.
 */
export function checkPacketQuality(task: TaskPacket): string[] {
  const warnings: string[] = []
  if (!task.mission) warnings.push('## Mission 为空')
  if (task.steps.length === 0) warnings.push('没有 "### Step N:" 步骤清单（worker 无法推进任务状态）')
  if (task.completionCriteria.length === 0) warnings.push('没有 "## Completion Criteria" 验收项（worker 不知道何时算完成）')
  if (task.fileScope.length === 0) warnings.push('缺 "## File Scope"（建议声明影响文件，便于并行 lane 隔离）')
  return warnings
}

/** Read the status line out of a STATUS.md. */
export function parseStatusFile(taskDir: string): TaskStatusInfo {
  const path = taskStatusFilePath(taskDir)
  const info: TaskStatusInfo = { status: 'ready', currentStep: '', done: existsSync(join(taskDir, '.DONE')) }
  if (!existsSync(path)) return { ...info, status: info.done ? 'done' : 'ready' }
  const content = readFileSync(path, 'utf-8')
  const statusMatch = content.match(/^\*\*Status:\*\*\s*(.+)$/m)
  const stepMatch = content.match(/^\*\*Current Step:\*\*\s*(.+)$/m)
  const blockerMatch = content.match(/^\*\*Blocker:\*\*\s*(.+)$/m)
  if (stepMatch) info.currentStep = stepMatch[1].trim()
  if (blockerMatch) info.blockedReason = blockerMatch[1].trim()
  // KI-008: checkbox 统计（勾选数/总数）供 supervisor 汇报与状态显示用。
  const checked = (content.match(/- \[x\]/gi) ?? []).length
  const total = checked + (content.match(/- \[ \]/g) ?? []).length
  if (total > 0) { info.checked = checked; info.total = total }
  const raw = statusMatch ? statusMatch[1].trim() : ''
  if (raw.includes('✅') || info.done) info.status = 'done'
  else if (raw.includes('❌')) info.status = 'blocked'
  else if (raw.includes('🟡')) info.status = 'review'
  else if (raw.includes('🟢')) info.status = 'running'
  else info.status = 'ready'
  return info
}

/** Ensure a STATUS.md exists for a task dir, scaffolding from the packet. */
export function ensureStatusFile(task: TaskPacket): void {
  const path = taskStatusFilePath(task.folder)
  if (existsSync(path)) return
  const lines: string[] = [
    `# ${task.id}: ${task.name} — Status`,
    `**Status:** ${STATUS_MARKER.ready}`,
    '**Current Step:** Not Started',
    `**Last Updated:** ${new Date().toISOString()}`,
    '**Iteration:** 0',
    '**Size:** ' + task.size,
    '',
    '---',
    '',
  ]
  for (const step of task.steps) {
    lines.push(`### Step ${step.index}: ${step.title}`, `**Status:** ${STEP_STATUS_MARKER.pending}`, '')
    for (const item of step.items) {
      lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`)
    }
    lines.push('', '---', '')
  }
  lines.push('## Execution Log', '', '| Timestamp | Action | Outcome |', '|---|---|---|')
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
}

/**
 * 确保 STATUS.md 与 PROMPT.md 的 Step 结构一致（2026-08-16 修复）：
 * 任务包创建方（其它 AI / 手工）可能只写了 `**Status:**` 头 + Execution Log 而缺
 * `### Step N:` 段——引擎的 advanceStep / 进度统计都依赖 Step 段，缺了会静默失败
 * （advance 不勾选、进度显示空）。
 *
 * 规则：STATUS.md 存在但**没有任何 `### Step` 段**时，从 PROMPT 重建 Step 段
 * （保留已有的 `**Status:**` 行与 Execution Log），让 STATUS.md 与任务包设计一致。
 * 已有 Step 段则不动（保留 worker 的勾选进度）。
 * @returns 是否补建了 Step 段。
 */
export function ensureStatusStructure(task: TaskPacket): boolean {
  const path = taskStatusFilePath(task.folder)
  if (!existsSync(path)) {
    ensureStatusFile(task)
    return true
  }
  let content = readFileSync(path, 'utf-8')
  if (/^### Step \d+: /m.test(content)) return false
  // 无 Step 段：把 Step 段**注入**到现有内容中（保留 Status 头 / Execution Log 行 /
  // Blocker 等一切已有内容），插入点为 `## Execution Log` 之前；无该标题则追加到末尾。
  const stepsBlock = task.steps.map((step) => {
    const lines = [`### Step ${step.index}: ${step.title}`, `**Status:** ${STEP_STATUS_MARKER.pending}`, '']
    for (const item of step.items) lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`)
    lines.push('', '---', '')
    return lines.join('\n')
  }).join('\n')
  const logIdx = content.search(/^## Execution Log$/m)
  if (logIdx >= 0) {
    content = content.slice(0, logIdx) + stepsBlock + '\n' + content.slice(logIdx)
  } else {
    content = content.replace(/\s*$/, '') + '\n\n' + stepsBlock
  }
  writeFileSync(path, content, 'utf-8')
  return true
}

/**
 * 任务状态落盘前的结构保证：STATUS.md 存在但缺 `### Step N:` 段时，从 PROMPT.md
 * 解析任务包并补建 Step 段。所有写 STATUS.md 的入口（setTaskStatus / advanceStep /
 * markTaskDone / appendExecutionLog / updateStatusField / appendStepStatus …）都应
 * 先过这一道，确保任务创建/更新/成功/失败/状态变更任何环节都不会落到残缺结构上。
 * 返回是否补建了 Step 段。
 */
export function ensureTaskDirStructure(taskDir: string): boolean {
  try {
    const promptPath = promptFilePath(taskDir)
    if (!existsSync(promptPath)) return false
    const packet = parsePrompt(promptPath, taskDir, '')
    if (!packet) return false
    return ensureStatusStructure(packet)
  } catch {
    return false
  }
}

function updateStatusField(taskDir: string, field: string, value: string): void {
  const path = taskStatusFilePath(taskDir)
  if (!existsSync(path)) return
  // 落盘前结构保证：缺 Step 段则从 PROMPT 补建（任务更新/状态变更任何环节都不落残缺结构）。
  ensureTaskDirStructure(taskDir)
  let content = readFileSync(path, 'utf-8')
  const re = new RegExp(`^\\*\\*${field}:\\*\\*.*$`, 'm')
  content = re.test(content)
    ? content.replace(re, `**${field}:** ${value}`)
    : content.replace(/^---$/m, `**${field}:** ${value}\n\n---`)
  writeFileSync(path, content, 'utf-8')
}

function appendStepStatus(taskDir: string, stepTitle: string, marker: string): void {
  const path = taskStatusFilePath(taskDir)
  if (!existsSync(path)) return
  // 落盘前结构保证：缺 Step 段则补建，确保能定位到对应 Step 段。
  ensureTaskDirStructure(taskDir)
  const content = readFileSync(path, 'utf-8')
  const re = new RegExp(`^(### Step \\d+: ${escapeRegExp(stepTitle)}\\n)\\*\\*Status:\\*\\*.*$`, 'm')
  if (re.test(content)) {
    writeFileSync(path, content.replace(re, `$1**Status:** ${marker}`), 'utf-8')
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Tick the first unchecked item of the current/incomplete step; returns info. */
export function advanceStep(task: TaskPacket, stepIndex: number): { step: number; remaining: number; item?: string } {
  const path = taskStatusFilePath(task.folder)
  if (!existsSync(path)) ensureStatusFile(task)
  let content = readFileSync(path, 'utf-8')
  const step = task.steps.find((s) => s.index === stepIndex)
  if (!step) return { step: stepIndex, remaining: 0 }
  // Find the first `- [ ]` line inside this step's section of STATUS.md.
  const re = new RegExp(`^### Step ${step.index}: ${escapeRegExp(step.title)}$`, 'm')
  let match = content.match(re)
  // 2026-08-16：STATUS.md 缺 Step 段（任务包创建方只写 Status 头 + Execution Log）时，
  // 先按 PROMPT 补建结构再勾选——否则 advance 静默失败（不勾选、进度不动）。
  if (!match && !/^### Step \d+: /m.test(content)) {
    ensureStatusStructure(task)
    content = readFileSync(path, 'utf-8')
    match = content.match(re)
  }
  if (!match) return { step: stepIndex, remaining: 0 }
  const start = match.index! + match[0].length
  const end = content.slice(start).search(/^### Step \d+:/m)
  const body = content.slice(start, end === -1 ? undefined : start + end)
  const itemRe = /^(\s*-\s+\[)([ ])(\])(\s+)(.+)$/m
  const item = body.match(itemRe)
  if (!item) {
    // Step fully checked — mark the step itself complete.
    appendStepStatus(task.folder, step.title, STEP_STATUS_MARKER.done)
    updateStatusField(task.folder, 'Current Step', step.title)
    return { step: stepIndex, remaining: 0 }
  }
  const full = body.replace(itemRe, '$1x$3$4$5')
  content = content.slice(0, start) + full + content.slice(start + body.length)
  writeFileSync(path, content, 'utf-8')
  const remaining = (full.match(/- \[ \]/g) ?? []).length
  appendStepStatus(task.folder, step.title, STEP_STATUS_MARKER.running)
  updateStatusField(task.folder, 'Current Step', step.title)
  updateStatusField(task.folder, 'Status', STATUS_MARKER.running)
  return { step: stepIndex, remaining, item: item[5]!.trim() }
}

/** Set the task status marker (running/review/done/blocked). */
export function setTaskStatus(taskDir: string, status: TaskStatus, extra?: { blockedReason?: string }): void {
  const path = taskStatusFilePath(taskDir)
  if (!existsSync(path)) return
  updateStatusField(taskDir, 'Status', STATUS_MARKER[status])
  if (status === 'blocked' && extra?.blockedReason) {
    updateStatusField(taskDir, 'Blocker', extra.blockedReason)
  }
}

/**
 * Mark a task as running AND make STATUS.md internally consistent (B4 fix,
 * 2026-08-15): besides the `**Status:**` line, set `**Current Step:**` to the
 * first step's title and flip that step's `**Status:**` to 🟢 In Progress.
 * Without this, STATUS.md shows "🟢 In Progress" next to "**Current Step:**
 * Not Started" from lane start until the worker's first `advance` — and the
 * dashboard faithfully renders that misleading "Not Started".
 * Returns the step title selected (or null when the task has no steps).
 */
export function markTaskRunning(taskDir: string, packet: TaskPacket): string | null {
  const path = taskStatusFilePath(taskDir)
  if (!existsSync(path)) return null
  const first = packet.steps[0]
  if (!first) return null
  updateStatusField(taskDir, 'Current Step', first.title)
  appendStepStatus(taskDir, first.title, STEP_STATUS_MARKER.running)
  updateStatusField(taskDir, 'Status', STATUS_MARKER.running)
  return first.title
}

/** Append a row to the STATUS.md execution log. */
export function appendExecutionLog(taskDir: string, action: string, outcome: string): void {
  const path = taskStatusFilePath(taskDir)
  if (!existsSync(path)) return
  // 落盘前结构保证：缺 Step 段则补建（Execution Log 追加到完整结构上）。
  ensureTaskDirStructure(taskDir)
  appendFileSync(path, `| ${new Date().toISOString()} | ${action} | ${outcome} |\n`, 'utf-8')
}

/** Mark a task done: update STATUS.md and create `.DONE`. */
export function markTaskDone(taskDir: string): void {
  setTaskStatus(taskDir, 'done')
  const donePath = join(taskDir, '.DONE')
  if (!existsSync(donePath)) writeFileSync(donePath, new Date().toISOString() + '\n', 'utf-8')
}

/** Append an amendment to the PROMPT.md amendments section (below the divider). */
export function appendAmendment(taskDir: string, text: string): void {
  const path = promptFilePath(taskDir)
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf-8')
  const marker = '## Amendments (Added During Execution)'
  const line = `- ${text}`
  if (content.includes(marker)) {
    writeFileSync(path, content.replace(marker, `${marker}\n${line}`), 'utf-8')
  } else {
    writeFileSync(path, `${content}\n---\n\n${marker}\n${line}\n`, 'utf-8')
  }
}

/** Scaffold a task packet from a template into the tasks root. */
export function scaffoldTask(tasksRoot: string, templateDir: string, id: string, name: string): string | null {
  const folder = join(tasksRoot, `${id}-${name}`)
  if (existsSync(join(folder, 'PROMPT.md'))) return null
  if (!existsSync(join(templateDir, 'PROMPT.md')) || !existsSync(join(templateDir, 'STATUS.md'))) return null
  mkdirSync(folder, { recursive: true })
  const read = (f: string): string => readFileSync(join(templateDir, f), 'utf-8')
  const prompt = read('PROMPT.md')
    .replace(/EXAMPLE-001/g, id)
    .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10))
  const status = read('STATUS.md')
    .replace(/EXAMPLE-001/g, id)
    .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10))
  writeFileSync(join(folder, 'PROMPT.md'), prompt, 'utf-8')
  writeFileSync(join(folder, 'STATUS.md'), status, 'utf-8')
  return folder
}
