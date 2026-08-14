/**
 * Spec for dashboard/adapters.mjs — taskswarm state → TaskPlane dashboard JSON.
 *
 * Constructs a temporary repo (tasks/ packets + `.taskswarm/batches/` BatchState +
 * `.taskswarm/mailbox/` messages) and asserts the adapter output against the
 * TaskPlane `buildDashboardState()` contract. Zero external dependencies.
 *
 * Run: npm run build && node --test dashboard/adapters.spec.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildDashboardState,
  adaptMailbox,
  emptyDashboardState,
} from './adapters.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'taskswarm-web002-'))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

/** Write a PROMPT.md + STATUS.md task packet into `dir`. */
function writeTask(dir, id, name, deps, statusMd) {
  mkdirSync(dir, { recursive: true })
  const prompt = [
    `# Task: ${id} — ${name}`,
    '',
    '**Size:** S',
    '',
    '## Review Level: 2 (Standard)',
    '',
    '## Mission',
    `Do ${name}.`,
    '',
    '## Dependencies',
    ...(deps.length ? deps.map((d) => `- ${d}`) : ['- **None**']),
    '',
    '## File Scope',
    `- ${id.toLowerCase()}.txt`,
    '',
    '## Steps',
    '',
    '### Step 1: Work',
    '',
    '- [ ] item one',
    '- [ ] item two',
    '',
    '## Completion Criteria',
    '',
    `- [ ] ${id.toLowerCase()}.txt exists`,
    '',
    '---',
  ].join('\n')
  writeFileSync(join(dir, 'PROMPT.md'), prompt, 'utf-8')
  writeFileSync(join(dir, 'STATUS.md'), statusMd, 'utf-8')
}

function statusMd(id, name, statusLine, currentStep, iteration, boxes) {
  return [
    `# ${id}: ${name} — Status`,
    '',
    `**Status:** ${statusLine}`,
    `**Current Step:** ${currentStep}`,
    '**Last Updated:** 2026-08-13T10:00:00.000Z',
    `**Iteration:** ${iteration}`,
    '**Size:** S',
    '',
    '---',
    '',
    '### Step 1: Work',
    '**Status:** 🟢 In Progress',
    '',
    ...boxes.map((b) => `- [${b}] item`),
    '',
    '## Execution Log',
    '',
    '| Timestamp | Action | Outcome |',
    '|---|---|---|',
  ].join('\n')
}

/** Write a BatchState JSON under `<root>/.taskswarm/batches/`. */
function writeBatchState(root, state) {
  const dir = join(root, '.taskswarm', 'batches')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${state.id}.json`), JSON.stringify(state, null, 2), 'utf-8')
}

/** Write a taskswarm mailbox message file at `<root>/.taskswarm/mailbox/<batchId>/<rel>`. */
function writeMessage(root, batchId, rel, msg) {
  const full = join(root, '.taskswarm', 'mailbox', batchId, rel)
  mkdirSync(full, { recursive: true })
  const name = `${Date.now()}-${msg.id.slice(0, 8)}.json`
  writeFileSync(join(full, name), JSON.stringify(msg), 'utf-8')
}

function makeBatchState(root) {
  return {
    id: 'b-test-abc123',
    repoRoot: root,
    tasksRoot: join(root, 'tasks'),
    stateRoot: join(root, '.taskswarm'),
    phase: 'running',
    scope: 'ALPHA-001 BETA-002',
    startedAt: '2026-08-13T10:00:00.000Z',
    waves: 2,
    lanes: [
      {
        lane: 1,
        taskId: 'ALPHA-001',
        phase: 'pending',
        worktree: join(root, '.taskswarm', 'worktrees', 'alpha-001'),
        log: [],
      },
      {
        lane: 2,
        taskId: 'BETA-002',
        phase: 'running',
        worktree: join(root, '.taskswarm', 'worktrees', 'beta-002'),
        startedAt: '2026-08-13T10:01:00.000Z',
        log: ['starting BETA-002'],
      },
    ],
  }
}

test('batch mapping: batchId/phase/waves/wavePlan/lanes align with contract', (t) => {
  const root = tmp()
  t.after(() => cleanup(root))

  writeTask(
    join(root, 'tasks', 'ALPHA-001-one'),
    'ALPHA-001', 'First', [],
    statusMd('ALPHA-001', 'First', '🔵 Ready for Execution', 'Not Started', 3, ['x', ' ']),
  )
  writeTask(
    join(root, 'tasks', 'BETA-002-two'),
    'BETA-002', 'Second', ['ALPHA-001'],
    statusMd('BETA-002', 'Second', '🟢 In Progress', 'Step 2', 1, ['x', 'x', 'x', ' ']),
  )
  const batchState = makeBatchState(root)
  writeBatchState(root, batchState)

  const state = buildDashboardState({ stateRoot: join(root, '.taskswarm') })

  // Contract fields with taskswarm defaults.
  assert.deepEqual(state.laneStates, {})
  assert.deepEqual(state.telemetry, {})
  assert.equal(state.batchTotalCost, 0)
  assert.equal(state.supervisor, null)
  assert.equal(state.runtimeRegistry, null)
  assert.deepEqual(state.runtimeLaneSnapshots, {})
  assert.deepEqual(state.runtimeMergeSnapshots, {})
  assert.deepEqual(state.sessions, [])
  assert.deepEqual(state.tmuxSessions, [])
  assert.equal(typeof state.timestamp, 'number')

  const batch = state.batch
  assert.ok(batch, 'batch must be present')
  assert.equal(batch.batchId, 'b-test-abc123')
  assert.equal(batch.phase, 'running')
  assert.equal(batch.startedAt, '2026-08-13T10:00:00.000Z')
  assert.equal(batch.updatedAt, '2026-08-13T10:00:00.000Z')
  assert.equal(batch.totalWaves, 2)
  assert.equal(batch.mode, 'repo')
  assert.deepEqual(batch.mergeResults, [])
  assert.deepEqual(batch.segments, [])
  assert.deepEqual(batch.errors, [])
  assert.equal(batch.lastError, null)

  // wavePlan recomputed from tasks root (BETA depends on ALPHA → 2 waves),
  // taskIds line up with batch.lanes[].taskId.
  assert.deepEqual(batch.wavePlan, [['ALPHA-001'], ['BETA-002']])
  // First wave with a non-pending lane is wave index 1 (ALPHA pending, BETA running).
  assert.equal(batch.currentWaveIndex, 1)

  // Lanes: phase passthrough, laneSessionId derived from worktree dir name.
  assert.equal(batch.lanes.length, 2)
  assert.equal(batch.lanes[0].laneNumber, 1)
  assert.equal(batch.lanes[0].taskId, 'ALPHA-001')
  assert.deepEqual(batch.lanes[0].taskIds, ['ALPHA-001'])
  assert.equal(batch.lanes[0].laneSessionId, 'alpha-001')
  assert.equal(batch.lanes[0].worktreePath, join(root, '.taskswarm', 'worktrees', 'alpha-001'))
  assert.equal(batch.lanes[0].phase, 'pending')
  assert.equal(batch.lanes[1].laneNumber, 2)
  assert.equal(batch.lanes[1].laneSessionId, 'beta-002')
  assert.equal(batch.lanes[1].phase, 'running')
})

test('task mapping: statusData.progress from STATUS.md, title, done flag', (t) => {
  const root = tmp()
  t.after(() => cleanup(root))

  writeTask(
    join(root, 'tasks', 'ALPHA-001-one'),
    'ALPHA-001', 'First', [],
    statusMd('ALPHA-001', 'First', '🔵 Ready for Execution', 'Not Started', 3, ['x', ' ']),
  )
  writeTask(
    join(root, 'tasks', 'BETA-002-two'),
    'BETA-002', 'Second', ['ALPHA-001'],
    statusMd('BETA-002', 'Second', '🟢 In Progress', 'Step 2', 1, ['x', 'x', 'x', ' ']),
  )
  writeBatchState(root, makeBatchState(root))

  const tasks = buildDashboardState({ stateRoot: join(root, '.taskswarm') }).batch.tasks
  assert.equal(tasks.length, 2)

  const alpha = tasks.find((t) => t.taskId === 'ALPHA-001')
  assert.ok(alpha.taskFolder.endsWith(join('tasks', 'ALPHA-001-one')))
  assert.equal(alpha.laneNumber, 1)
  assert.equal(alpha.taskTitle, 'First')
  assert.equal(alpha.status, 'pending')
  assert.equal(alpha.doneFileFound, false)
  assert.equal(alpha.statusData.currentStep, 'Not Started')
  assert.equal(alpha.statusData.iteration, 3)
  assert.equal(alpha.statusData.checked, 1)
  assert.equal(alpha.statusData.total, 2)
  assert.equal(alpha.statusData.progress, 50)
  assert.equal(alpha.startedAt, null)

  const beta = tasks.find((t) => t.taskId === 'BETA-002')
  assert.equal(beta.taskTitle, 'Second')
  assert.equal(beta.status, 'running')
  assert.equal(beta.statusData.currentStep, 'Step 2')
  assert.equal(beta.statusData.checked, 3)
  assert.equal(beta.statusData.total, 4)
  assert.equal(beta.statusData.progress, 75)
  assert.equal(beta.startedAt, Date.parse('2026-08-13T10:01:00.000Z'))

  // A lane task without a STATUS.md → statusData null (upstream behavior).
  const root2 = tmp()
  t.after(() => cleanup(root2))
  mkdirSync(join(root2, 'tasks', 'ONLY-001'), { recursive: true })
  writeFileSync(join(root2, 'tasks', 'ONLY-001', 'PROMPT.md'), '# Task: ONLY-001 — Solo\n\n## Dependencies\n\n- **None**\n', 'utf-8')
  writeBatchState(root2, {
    id: 'b-solo',
    repoRoot: root2,
    tasksRoot: join(root2, 'tasks'),
    stateRoot: join(root2, '.taskswarm'),
    phase: 'running',
    scope: 'ONLY-001',
    startedAt: '2026-08-13T10:00:00.000Z',
    waves: 1,
    lanes: [{ lane: 1, taskId: 'ONLY-001', phase: 'running', log: [] }],
  })
  const solo = buildDashboardState({ stateRoot: join(root2, '.taskswarm') }).batch.tasks[0]
  assert.equal(solo.taskId, 'ONLY-001')
  assert.equal(solo.statusData, null)
})

test('mailbox: messages mapped, sorted by timestamp, status per dir', (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  const batchId = 'b-mailbox'
  writeBatchState(root, {
    id: batchId,
    repoRoot: root,
    tasksRoot: join(root, 'tasks'),
    stateRoot: join(root, '.taskswarm'),
    phase: 'complete',
    scope: 'X-001',
    startedAt: '2026-08-13T10:00:00.000Z',
    waves: 1,
    lanes: [{ lane: 1, taskId: 'X-001', phase: 'merged', log: [] }],
  })

  writeMessage(root, batchId, 'supervisor/inbox', {
    id: 'aaaa-1111', from: 'lane-1', to: 'supervisor', type: 'escalate',
    payload: { taskId: 'X-001', issue: 'blocked on review' },
    ts: '2026-08-13T11:00:00.000Z',
  })
  writeMessage(root, batchId, 'supervisor/inbox/_ack', {
    id: 'bbbb-2222', from: 'engine', to: 'supervisor', type: 'notify',
    payload: { batchId, phase: 'complete' },
    ts: '2026-08-13T11:30:00.000Z',
  })
  writeMessage(root, batchId, 'supervisor/inbox', {
    id: 'cccc-3333', from: 'lane-1', to: 'supervisor', type: 'request',
    payload: { taskId: 'X-001', description: 'need review pass' },
    ts: '2026-08-13T12:00:00.000Z',
  })
  writeMessage(root, batchId, 'supervisor/outbox', {
    id: 'dddd-4444', from: 'supervisor', to: 'lane-1', type: 'reply',
    payload: 'revise step 2',
    ts: '2026-08-13T12:30:00.000Z',
  })
  writeMessage(root, batchId, 'broadcast', {
    id: 'eeee-5555', from: 'supervisor', to: 'broadcast', type: 'broadcast',
    payload: { message: 'all lanes halt' },
    ts: '2026-08-13T12:45:00.000Z',
  })

  const mailbox = buildDashboardState({ stateRoot: join(root, '.taskswarm'), batchId }).mailbox
  assert.deepEqual(mailbox.auditEvents, [])
  assert.deepEqual(mailbox.agentIds, ['supervisor'])

  // Sorted ascending by timestamp.
  assert.deepEqual(mailbox.messages.map((m) => m.id), ['aaaa-1111', 'bbbb-2222', 'cccc-3333', 'dddd-4444', 'eeee-5555'])
  assert.deepEqual(mailbox.messages.map((m) => m._status), ['pending', 'delivered', 'pending', 'reply', 'pending'])
  assert.deepEqual(mailbox.messages.map((m) => m.timestamp), [
    Date.parse('2026-08-13T11:00:00.000Z'),
    Date.parse('2026-08-13T11:30:00.000Z'),
    Date.parse('2026-08-13T12:00:00.000Z'),
    Date.parse('2026-08-13T12:30:00.000Z'),
    Date.parse('2026-08-13T12:45:00.000Z'),
  ])

  // Field mapping: timestamp from ts, subject/content from payload.
  const escalated = mailbox.messages[0]
  assert.equal(escalated.from, 'lane-1')
  assert.equal(escalated.to, 'supervisor')
  assert.equal(escalated.type, 'escalate')
  assert.equal(escalated._agentDir, 'supervisor')
  assert.equal(escalated._isBroadcast, false)
  assert.equal(escalated.subject, 'blocked on review')
  assert.equal(escalated.body.taskId, 'X-001')

  const reply = mailbox.messages[3]
  assert.equal(reply._status, 'reply')
  assert.equal(reply.subject, 'revise step 2')

  const broadcast = mailbox.messages[4]
  assert.equal(broadcast._isBroadcast, true)
  assert.equal(broadcast._agentDir, 'broadcast')
  assert.equal(broadcast.subject, 'all lanes halt')

  // Missing mailbox dir → empty payload.
  assert.deepEqual(adaptMailbox(root, 'b-does-not-exist'), { messages: [], agentIds: [], auditEvents: [] })
})

test('errors/lastError aggregated from lane.error', (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  writeTask(join(root, 'tasks', 'FAIL-001'), 'FAIL-001', 'Fail', [], statusMd('FAIL-001', 'Fail', '❌ Blocked', 'Step 1', 1, [' ', ' ']))
  writeBatchState(root, {
    id: 'b-fail',
    repoRoot: root,
    tasksRoot: join(root, 'tasks'),
    stateRoot: join(root, '.taskswarm'),
    phase: 'running',
    scope: 'FAIL-001',
    startedAt: '2026-08-13T10:00:00.000Z',
    waves: 1,
    lanes: [{ lane: 1, taskId: 'FAIL-001', phase: 'failed', error: 'boom', exitCode: 1, log: [] }],
  })

  const batch = buildDashboardState({ stateRoot: join(root, '.taskswarm') }).batch
  assert.equal(batch.lanes[0].phase, 'failed')
  assert.equal(batch.lanes[0].error, 'boom')
  assert.deepEqual(batch.errors, [{ lane: 1, taskId: 'FAIL-001', error: 'boom' }])
  assert.equal(batch.lastError, 'boom')
})

test('empty state: no batch → { batch: null } with contract defaults', (t) => {
  const root = tmp()
  t.after(() => cleanup(root))

  // No stateRoot / missing .taskswarm → upstream-style empty object.
  const empty = emptyDashboardState()
  assert.equal(empty.batch, null)
  assert.deepEqual(empty.laneStates, {})
  assert.deepEqual(empty.telemetry, {})
  assert.equal(empty.batchTotalCost, 0)
  assert.equal(empty.supervisor, null)
  assert.equal(empty.runtimeRegistry, null)
  assert.deepEqual(empty.runtimeLaneSnapshots, {})
  assert.deepEqual(empty.runtimeMergeSnapshots, {})
  assert.deepEqual(empty.sessions, [])
  assert.deepEqual(empty.tmuxSessions, [])
  assert.deepEqual(empty.mailbox, { messages: [], agentIds: [], auditEvents: [] })
  assert.equal(typeof empty.timestamp, 'number')

  const fromMissing = buildDashboardState({ stateRoot: join(root, '.taskswarm') })
  assert.equal(fromMissing.batch, null)

  // Unknown batchId → null batch too.
  const root2 = tmp()
  t.after(() => cleanup(root2))
  mkdirSync(join(root2, '.taskswarm', 'batches'), { recursive: true })
  const unknown = buildDashboardState({ stateRoot: join(root2, '.taskswarm'), batchId: 'b-nope' })
  assert.equal(unknown.batch, null)
})

test('full state JSON-serializes without exceptions', (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  writeTask(
    join(root, 'tasks', 'ALPHA-001-one'),
    'ALPHA-001', 'First', [],
    statusMd('ALPHA-001', 'First', '🔵 Ready for Execution', 'Not Started', 3, ['x', ' ']),
  )
  writeTask(
    join(root, 'tasks', 'BETA-002-two'),
    'BETA-002', 'Second', ['ALPHA-001'],
    statusMd('BETA-002', 'Second', '🟢 In Progress', 'Step 2', 1, ['x', 'x', 'x', ' ']),
  )
  writeBatchState(root, makeBatchState(root))

  const state = buildDashboardState({ stateRoot: join(root, '.taskswarm') })
  const serialized = JSON.stringify(state)
  assert.equal(typeof serialized, 'string')
  assert.ok(serialized.length > 0)
  const roundTrip = JSON.parse(serialized)
  assert.equal(roundTrip.batch.batchId, 'b-test-abc123')
  assert.deepEqual(roundTrip.batch.wavePlan, [['ALPHA-001'], ['BETA-002']])
  assert.equal(roundTrip.mailbox.messages.length, 0)

  // Every top-level contract key is present in the serialized form.
  for (const key of [
    'batch', 'laneStates', 'telemetry', 'batchTotalCost', 'supervisor',
    'runtimeRegistry', 'runtimeLaneSnapshots', 'runtimeMergeSnapshots',
    'mailbox', 'sessions', 'tmuxSessions', 'timestamp',
  ]) {
    assert.ok(key in roundTrip, `missing top-level key ${key}`)
  }
})

test('latestBatch selection: lexically-last batch file wins when no batchId given', (t) => {
  const root = tmp()
  t.after(() => cleanup(root))
  writeTask(join(root, 'tasks', 'X-001'), 'X-001', 'X', [], statusMd('X-001', 'X', '🟢 In Progress', 'Step 1', 0, [' ']))
  writeBatchState(root, {
    id: 'b-aaa', repoRoot: root, tasksRoot: join(root, 'tasks'), stateRoot: join(root, '.taskswarm'),
    phase: 'complete', scope: 'X-001', startedAt: '2026-08-13T08:00:00.000Z', waves: 1,
    lanes: [{ lane: 1, taskId: 'X-001', phase: 'merged', log: [] }],
  })
  writeBatchState(root, {
    id: 'b-zzz', repoRoot: root, tasksRoot: join(root, 'tasks'), stateRoot: join(root, '.taskswarm'),
    phase: 'running', scope: 'X-001', startedAt: '2026-08-13T09:00:00.000Z', waves: 1,
    lanes: [{ lane: 1, taskId: 'X-001', phase: 'running', log: [] }],
  })
  // lib/core latestBatch() = lexically-last `<batchId>.json` filename.
  const state = buildDashboardState({ stateRoot: join(root, '.taskswarm') })
  assert.equal(state.batch.batchId, 'b-zzz')

  // Explicit batchId wins over latest.
  const explicit = buildDashboardState({ stateRoot: join(root, '.taskswarm'), batchId: 'b-aaa' })
  assert.equal(explicit.batch.batchId, 'b-aaa')
})
