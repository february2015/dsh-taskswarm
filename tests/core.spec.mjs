import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeNameComponent, resolveRepoSlug } from '../lib/core/naming.js'
import { parsePrompt, ensureStatusFile, advanceStep, markTaskRunning, markTaskDone, parseStatusFile, explainParseFailure, checkPacketQuality } from '../lib/core/task.js'
import { scanTasks, scanTaskFailures, buildWaves } from '../lib/core/discover.js'
import { writeMailboxMessage, readInbox, ackMessage, sessionInboxDir, SUPERVISOR_SESSION } from '../lib/core/mailbox.js'
import { runGit } from '../lib/core/git.js'
import { ensureOrchWorktree, createLaneWorktree, worktreePaths } from '../lib/core/worktree.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'taskswarm-core-'))
}

function writeTask(dir, id, name, deps, steps) {
  mkdirSync(dir, { recursive: true })
  const stepLines = steps
    .map((s, i) => `### Step ${i}: ${s.title}\n\n${s.items.map((it) => `- [ ] ${it}`).join('\n')}\n`)
    .join('\n')
  const prompt = [
    `# Task: ${id} — ${name}`,
    '',
    '**Size:** S',
    '',
    '## Dependencies',
    ...(deps.length ? deps.map((d) => `- ${d}`) : ['- **None**']),
    '',
    '## Mission',
    `Do ${name}.`,
    '',
    '## File Scope',
    `- ${id}.txt`,
    '',
    '## Steps',
    '',
    stepLines,
    '',
    '## Completion Criteria',
    '',
    `- [ ] ${id}.txt exists`,
    '',
    '---',
  ].join('\n')
  writeFileSync(join(dir, 'PROMPT.md'), prompt, 'utf-8')
  // No STATUS.md on purpose: ensureStatusFile scaffolds it from the packet.
}

test('naming sanitizes components', () => {
  assert.equal(sanitizeNameComponent('Hello World!'), 'hello-world')
  assert.equal(sanitizeNameComponent('  A--B  '), 'a-b')
  assert.equal(resolveRepoSlug('/tmp/My-Repo_Name'), 'my-repo-name')
})

test('parsePrompt extracts id, deps, steps, criteria', () => {
  const root = tmp()
  const dir = join(root, 'TASKSWARM-001-foo')
  writeTask(dir, 'TASKSWARM-001', 'Foo', ['A-001'], [
    { title: 'Preflight', items: ['read prompt', 'read status'] },
    { title: 'Work', items: ['create file'] },
  ])
  const task = parsePrompt(join(dir, 'PROMPT.md'), dir, 'tasks')
  assert.ok(task)
  assert.equal(task.id, 'TASKSWARM-001')
  assert.equal(task.name, 'Foo')
  assert.deepEqual(task.deps, ['A-001'])
  assert.equal(task.steps.length, 2)
  assert.equal(task.steps[1].items[0].text, 'create file')
  assert.equal(task.steps[1].items[0].checked, false)
  assert.ok(task.completionCriteria.includes('TASKSWARM-001.txt exists'))
  rmSync(root, { recursive: true, force: true })
})

test('advanceStep ticks checkboxes and markTaskDone sets status', () => {
  const root = tmp()
  const dir = join(root, 'TASKSWARM-002-bar')
  writeTask(dir, 'TASKSWARM-002', 'Bar', [], [
    { title: 'Preflight', items: ['a', 'b'] },
  ])
  const task = parsePrompt(join(dir, 'PROMPT.md'), dir, 'tasks')
  ensureStatusFile(task)
  const first = advanceStep(task, 0)
  assert.equal(first.item, 'a')
  const statusAfter = parseStatusFile(dir)
  assert.equal(statusAfter.status, 'running')
  markTaskDone(dir)
  assert.equal(parseStatusFile(dir).status, 'done')
  assert.ok(existsSync(join(dir, '.DONE')))
  rmSync(root, { recursive: true, force: true })
})

test('markTaskRunning sets Current Step and step status consistently (B4)', () => {
  const root = tmp()
  const dir = join(root, 'TASKSWARM-003-baz')
  writeTask(dir, 'TASKSWARM-003', 'Baz', [], [
    { title: 'Preflight', items: ['a', 'b'] },
    { title: 'Work', items: ['c'] },
  ])
  const task = parsePrompt(join(dir, 'PROMPT.md'), dir, 'tasks')
  ensureStatusFile(task)
  // Before: Current Step is the scaffolded initial "Not Started".
  assert.equal(parseStatusFile(dir).currentStep, 'Not Started')
  // After markTaskRunning: Current Step = first step title, status running.
  const title = markTaskRunning(dir, task)
  assert.equal(title, 'Preflight')
  const info = parseStatusFile(dir)
  assert.equal(info.status, 'running')
  assert.equal(info.currentStep, 'Preflight')
  const content = readFileSync(join(dir, 'STATUS.md'), 'utf-8')
  assert.match(content, /### Step 0: Preflight\n\*\*Status:\*\* 🟢 In Progress/, 'step 0 marked in progress')
  assert.match(content, /^\*\*Current Step:\*\* Preflight$/m, 'Current Step updated')
  rmSync(root, { recursive: true, force: true })
})

test('parseStatusFile reports checked/total checkbox counts (KI-008)', () => {
  const root = tmp()
  const dir = join(root, 'TASKSWARM-004-qux')
  writeTask(dir, 'TASKSWARM-004', 'Qux', [], [
    { title: 'Work', items: ['a', 'b', 'c'] },
  ])
  const task = parsePrompt(join(dir, 'PROMPT.md'), dir, 'tasks')
  ensureStatusFile(task)
  // Initially: 0/3.
  let info = parseStatusFile(dir)
  assert.equal(info.checked, 0)
  assert.equal(info.total, 3)
  // Advance once: 1/3.
  advanceStep(task, 0)
  info = parseStatusFile(dir)
  assert.equal(info.checked, 1)
  assert.equal(info.total, 3)
  rmSync(root, { recursive: true, force: true })
})

test('discover + buildWaves layers independent tasks first', () => {
  const root = tmp()
  const tasksRoot = join(root, 'tasks')
  writeTask(join(tasksRoot, 'A-001-x'), 'A-001', 'X', [], [{ title: 'S', items: ['a'] }])
  writeTask(join(tasksRoot, 'B-002-y'), 'B-002', 'Y', [], [{ title: 'S', items: ['a'] }])
  writeTask(join(tasksRoot, 'C-003-z'), 'C-003', 'Z', ['A-001'], [{ title: 'S', items: ['a'] }])
  const discovered = scanTasks(tasksRoot)
  assert.equal(discovered.length, 3)
  const waves = buildWaves(discovered.map((d) => d.task))
  assert.deepEqual(waves.waves.map((w) => w.map((t) => t.id).sort()), [['A-001', 'B-002'], ['C-003']])
  rmSync(root, { recursive: true, force: true })
})

test('mailbox write/read/ack round-trips', () => {
  const root = tmp()
  const inbox = sessionInboxDir(root, 'batch-1', SUPERVISOR_SESSION)
  const m1 = writeMailboxMessage(inbox, 'lane-1', SUPERVISOR_SESSION, 'notify', { text: 'hi' })
  const m2 = writeMailboxMessage(inbox, 'lane-2', SUPERVISOR_SESSION, 'escalate', { text: 'help' })
  const all = readInbox(inbox)
  assert.equal(all.length, 2)
  assert.deepEqual(new Set(all.map((m) => m.id)), new Set([m1.id, m2.id]))
  assert.ok(all.some((m) => m.type === 'escalate'))
  const files = readdirSync(inbox).filter((n) => !n.startsWith('.'))
  assert.equal(files.length, 2)
  for (const file of files) {
    assert.ok(ackMessage(inbox, file))
  }
  assert.equal(readInbox(inbox).length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('human-readable legacy packets are reported as parse failures, not silently dropped', () => {
  const root = tmp()
  // The exact failure mode from dsh-localvoice: folder T1 + "# T1 插件骨架" heading.
  const dir = join(root, 'T1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'PROMPT.md'), ['# T1 插件骨架', '', '## 目标', '搭建插件骨架', '', '## 验收标准（DoD）', '- [ ] ok'].join('\n'), 'utf-8')
  // parsePrompt itself returns null…
  assert.equal(parsePrompt(join(dir, 'PROMPT.md'), dir, 'tasks'), null)
  // …explainParseFailure gives the actionable cause…
  const reason = explainParseFailure(join(dir, 'PROMPT.md'), dir)
  assert.match(reason, /# Task:/)
  // …and scanTaskFailures surfaces the folder (where scanTasks silently skips it).
  assert.equal(scanTasks(root).length, 0)
  const fails = scanTaskFailures(root)
  assert.equal(fails.length, 1)
  assert.equal(fails[0].folder, 'T1')
  rmSync(root, { recursive: true, force: true })
})

test('invalid heading ID (T1 without hyphen) explains the [A-Z]+-\\d+ rule', () => {
  const root = tmp()
  const dir = join(root, 'TASK1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'PROMPT.md'), ['# Task: TASK1 — 无连字符', '', '## Mission', 'do it'].join('\n'), 'utf-8')
  assert.equal(parsePrompt(join(dir, 'PROMPT.md'), dir, 'tasks'), null)
  assert.match(explainParseFailure(join(dir, 'PROMPT.md'), dir), /\[A-Z\]\+-\\d\+/)
  rmSync(root, { recursive: true, force: true })
})

test('checkPacketQuality flags missing steps / criteria / file scope', () => {
  const root = tmp()
  const ok = join(root, 'OK-001-x')
  writeTask(ok, 'OK-001', 'X', [], [{ title: 'A', items: ['a'] }])
  const okTasks = scanTasks(root, true)
  assert.equal(okTasks.length, 1)
  assert.deepEqual(checkPacketQuality(okTasks[0].task), [])

  const bad = join(root, 'BAD-002-y')
  mkdirSync(bad, { recursive: true })
  writeFileSync(join(bad, 'PROMPT.md'), ['# Task: BAD-002 — Y', '', '**Size:** S', '', '## Mission', 'do it', '', '## Completion Criteria', '- [ ] done'].join('\n'), 'utf-8')
  const packet = parsePrompt(join(bad, 'PROMPT.md'), bad, 'bad')
  assert.ok(packet)
  const warnings = checkPacketQuality(packet)
  assert.ok(warnings.some((w) => w.includes('Step')))
  assert.ok(warnings.some((w) => w.includes('File Scope')))
  rmSync(root, { recursive: true, force: true })
})

test('lane worktrees are based on taskswarm/orch HEAD, not the working branch', () => {
  const root = tmp()
  runGit(['init', '-q'], root)
  runGit(['config', 'user.email', 'test@example.com'], root)
  runGit(['config', 'user.name', 'test'], root)
  writeFileSync(join(root, 'master.txt'), 'master only\n')
  runGit(['add', '-A'], root)
  runGit(['commit', '-m', 'master base'], root)

  const paths = worktreePaths(root, join(root, '.taskswarm'))
  assert.equal(ensureOrchWorktree(root, paths).ok, true)
  // Simulate a merged lane: commit T-1's output onto orch only (not on master).
  writeFileSync(join(paths.orchWorktree, 't1-output.txt'), 'merged by T-1\n')
  runGit(['add', '-A'], paths.orchWorktree)
  runGit(['commit', '-m', 'T-1 merged'], paths.orchWorktree)

  const lane = createLaneWorktree(root, paths, 'T-2')
  assert.ok(lane, 'lane worktree should be created')
  // The lane must inherit the orch-only file (baseline = orch HEAD).
  assert.equal(existsSync(join(lane.dir, 't1-output.txt')), true, 'lane must contain orch-merged output')
  assert.equal(existsSync(join(lane.dir, 'master.txt')), true)
  const head = runGit(['log', '--oneline', '-1'], lane.dir)
  assert.match(head.stdout, /T-1 merged/)

  runGit(['worktree', 'remove', '--force', lane.dir], root)
  runGit(['worktree', 'remove', '--force', paths.orchWorktree], root)
  rmSync(root, { recursive: true, force: true })
})

test('retried lanes attach the old branch, keep checkpoints, and merge newer orch work', () => {
  const root = tmp()
  runGit(['init', '-q'], root)
  runGit(['config', 'user.email', 'test@example.com'], root)
  runGit(['config', 'user.name', 'test'], root)
  writeFileSync(join(root, 'base.txt'), 'base\n')
  runGit(['add', '-A'], root)
  runGit(['commit', '-m', 'base'], root)

  const paths = worktreePaths(root, join(root, '.taskswarm'))
  assert.equal(ensureOrchWorktree(root, paths).ok, true)

  // First run: lane based on orch v1, worker checkpoints some work.
  const lane1 = createLaneWorktree(root, paths, 'T-3')
  assert.ok(lane1)
  writeFileSync(join(lane1.dir, 'checkpoint.txt'), 'old checkpoint\n')
  runGit(['add', '-A'], lane1.dir)
  runGit(['commit', '-m', 'checkpoint 1'], lane1.dir)
  runGit(['worktree', 'remove', '--force', lane1.dir], root) // engine cleans the worktree, branch kept

  // orch advances (another task merged).
  writeFileSync(join(paths.orchWorktree, 't2-output.txt'), 'merged by T-2\n')
  runGit(['add', '-A'], paths.orchWorktree)
  runGit(['commit', '-m', 'T-2 merged'], paths.orchWorktree)

  // Retry: recreate the lane → attaches existing branch + merges newer orch.
  const lane2 = createLaneWorktree(root, paths, 'T-3')
  assert.ok(lane2)
  assert.equal(existsSync(join(lane2.dir, 'checkpoint.txt')), true, 'old checkpoint preserved')
  assert.equal(existsSync(join(lane2.dir, 't2-output.txt')), true, 'newer orch work merged in')

  runGit(['worktree', 'remove', '--force', lane2.dir], root)
  runGit(['worktree', 'remove', '--force', paths.orchWorktree], root)
  rmSync(root, { recursive: true, force: true })
})
