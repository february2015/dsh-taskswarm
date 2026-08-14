import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeNameComponent, resolveRepoSlug } from '../lib/core/naming.js'
import { parsePrompt, ensureStatusFile, advanceStep, markTaskDone, parseStatusFile } from '../lib/core/task.js'
import { scanTasks, buildWaves } from '../lib/core/discover.js'
import { writeMailboxMessage, readInbox, ackMessage, sessionInboxDir, SUPERVISOR_SESSION } from '../lib/core/mailbox.js'

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
