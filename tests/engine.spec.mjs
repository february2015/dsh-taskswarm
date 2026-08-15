import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskSwarmEngine } from '../lib/orchestrator/engine.js'
import { runGit } from '../lib/core/git.js'
import { checkpointCommit, worktreePaths, listLaneWorktrees } from '../lib/core/worktree.js'
import { markTaskDone, parseStatusFile } from '../lib/core/task.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function writeTask(dir, id, name, deps) {
  mkdirSync(dir, { recursive: true })
  const prompt = [
    `# Task: ${id} — ${name}`,
    '',
    '**Size:** S',
    '',
    '## Dependencies',
    ...(deps.length ? deps.map((d) => `- ${d}`) : ['- **None**']),
    '',
    '## Mission',
    `Create ${id}.txt with content "${id} done".`,
    '',
    '## File Scope',
    `- ${id}.txt`,
    '',
    '## Steps',
    '',
    '### Step 0: Work',
    '',
    `- [ ] Create ${id}.txt`,
    '',
    '### Step 1: Delivery',
    '',
    `- [ ] Mark ${id} done`,
    '',
    '## Completion Criteria',
    '',
    `- [ ] ${id}.txt exists`,
    '',
    '---',
  ].join('\n')
  writeFileSync(join(dir, 'PROMPT.md'), prompt, 'utf-8')
  writeFileSync(join(dir, 'STATUS.md'), `# ${id}: ${name} — Status\n\n**Status:** 🔵 Ready for Execution\n**Current Step:** Not Started\n`, 'utf-8')
}

/** Fake worker that simulates a real lane agent: writes, commits, marks done. */
class FakeWorkerHost {
  constructor() {
    this.kind = 'fake'
    this.spawned = []
    this.active = 0
    this.maxActive = 0
  }

  async spawn(spec) {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.spawned.push(spec)
    await sleep(250) // let sibling lanes overlap
    try {
      writeFileSync(join(spec.worktree, `${spec.task.id}.txt`), `${spec.task.id} done\n`, 'utf-8')
      checkpointCommit(spec.worktree, `feat(${spec.task.id}): fake worker`)
      markTaskDone(spec.task.folder)
      return { exitCode: 0, text: `${spec.task.id} complete` }
    } finally {
      this.active -= 1
    }
  }
}

async function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'taskswarm-engine-'))
  runGit(['init', '-q'], root)
  runGit(['config', 'user.email', 'test@example.com'], root)
  runGit(['config', 'user.name', 'test'], root)
  writeFileSync(join(root, 'README.md'), '# test repo\n', 'utf-8')
  runGit(['add', '-A'], root)
  runGit(['commit', '-m', 'init'], root)
  return root
}

test('engine runs 2 independent tasks in parallel then a dependent task', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'A-001-alpha'), 'A-001', 'Alpha', [])
  writeTask(join(tasksRoot, 'B-002-beta'), 'B-002', 'Beta', [])
  writeTask(join(tasksRoot, 'C-003-gamma'), 'C-003', 'Gamma', ['A-001'])
  const stateRoot = join(repo, '.taskswarm')

  const host = new FakeWorkerHost()
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host })

  // Plan: A+B in wave 1, C in wave 2.
  const plan = engine.plan('all')
  assert.equal(plan.count, 3)
  assert.deepEqual(
    plan.waves.waves.map((w) => w.map((t) => t.id).sort()),
    [['A-001', 'B-002'], ['C-003']],
  )

  const handle = engine.run('all')
  assert.ok(handle.batchId.startsWith('b-'))

  // Wait for completion (max 30s).
  const deadline = Date.now() + 30_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.ok(state, 'batch state exists')
  assert.equal(state.phase, 'complete', `expected complete, got ${state.phase}`)

  // Both wave-1 lanes overlapped → parallelism proven.
  assert.ok(host.maxActive >= 2, `expected >=2 concurrent lanes, got ${host.maxActive}`)
  assert.equal(host.spawned.length, 3)

  // All lanes merged; worktrees cleaned up (only the orch worktree remains).
  for (const id of ['A-001', 'B-002', 'C-003']) {
    const lane = state.lanes.find((l) => l.taskId === id)
    assert.ok(lane, `lane ${id} exists`)
    assert.equal(lane.phase, 'merged', `lane ${id} merged (${lane.phase})`)
    assert.equal(parseStatusFile(join(tasksRoot, { 'A-001': 'A-001-alpha', 'B-002': 'B-002-beta', 'C-003': 'C-003-gamma' }[id])).status, 'done')
  }
  const paths = worktreePaths(repo, stateRoot)
  assert.deepEqual(listLaneWorktrees(paths), [])

  // Merged files are visible in the orch worktree checkout.
  for (const id of ['A-001', 'B-002', 'C-003']) {
    assert.ok(existsSync(join(paths.orchWorktree, `${id}.txt`)), `${id}.txt in orch worktree`)
  }

  // /orch-status style rendering is non-empty.
  const { formatBatchStatus } = await import('../lib/core/status.js')
  const rendered = formatBatchStatus(state)
  assert.ok(rendered.includes('A-001'))
  assert.ok(rendered.includes('merged'))
  // KI-008: lane lines carry step progress (checked/total).
  assert.match(rendered, /\d+\/\d+/, 'lane lines show checked/total step progress')

  rmSync(repo, { recursive: true, force: true })
})

test('engine plan reports unresolved dependency references', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'X-001-ok'), 'X-001', 'Ok', ['MISSING-999'])
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot: join(repo, '.taskswarm'), host: new FakeWorkerHost() })
  const plan = engine.plan('all')
  assert.equal(plan.count, 1)
  assert.deepEqual(plan.waves.unresolvedDeps.get('X-001'), ['MISSING-999'])
  rmSync(repo, { recursive: true, force: true })
})

/** Fake host whose worker deliberately conflicts on shared.txt, and whose
 *  merger agent resolves the conflict by taking both lanes' lines. */
class ConflictMergerHost {
  constructor() {
    this.kind = 'fake'
    this.mergeCalls = []
    this.mergedOk = false
  }

  async spawn(spec) {
    // Append this lane's line to shared.txt (both lanes edit the same file
    // from the same orch baseline → merge conflict when merged back).
    writeFileSync(join(spec.worktree, 'shared.txt'), `${spec.task.id} line\n`, 'utf-8')
    checkpointCommit(spec.worktree, `feat(${spec.task.id}): shared line`)
    markTaskDone(spec.task.folder)
    return { exitCode: 0, text: `${spec.task.id} complete` }
  }

  async spawnMerger(request) {
    this.mergeCalls.push(request)
    // Simulate an LLM merge agent: finish the in-progress merge by taking the
    // lane side (already merged via --theirs semantics in the orch worktree).
    const orch = request.orchWorktree
    runGit(['add', '-A'], orch)
    runGit(['commit', '--no-edit'], orch)
    this.mergedOk = true
    return { status: 'CONFLICT_RESOLVED', summary: 'resolved shared.txt by taking both' }
  }
}

test('engine uses the merger agent to resolve a conflicting lane merge', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  // Two parallel tasks both editing shared.txt from the same baseline.
  writeTask(join(tasksRoot, 'D-001-delta'), 'D-001', 'Delta', [])
  writeTask(join(tasksRoot, 'E-002-echo'), 'E-002', 'Echo', [])
  const stateRoot = join(repo, '.taskswarm')

  const host = new ConflictMergerHost()
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host })

  const handle = engine.run('all')
  assert.ok(handle.batchId.startsWith('b-'))

  const deadline = Date.now() + 30_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.ok(state, 'batch state exists')
  assert.equal(state.phase, 'complete', `expected complete, got ${state.phase}`)

  // The second lane's merge conflicts; the merger agent is invoked at least once.
  assert.ok(host.mergeCalls.length >= 1, 'merger agent should be invoked on conflict')
  assert.ok(host.mergedOk, 'merger agent should resolve the conflict')

  // Both lanes ended merged (conflict resolved by the agent), not failed.
  for (const id of ['D-001', 'E-002']) {
    const lane = state.lanes.find((l) => l.taskId === id)
    assert.ok(lane, `lane ${id} exists`)
    assert.equal(lane.phase, 'merged', `lane ${id} merged (${lane.phase})`)
  }

  // The orch worktree holds the resolved file (agent commit landed).
  const paths = worktreePaths(repo, stateRoot)
  assert.ok(existsSync(join(paths.orchWorktree, 'shared.txt')), 'shared.txt present in orch')

  rmSync(repo, { recursive: true, force: true })
})

/** Slow worker: takes a while per lane so abort can land mid-wave. */
class SlowWorkerHost {
  constructor() { this.kind = 'slow' }
  async spawn(spec) {
    await sleep(800)
    writeFileSync(join(spec.worktree, `${spec.task.id}.txt`), `${spec.task.id} done\n`, 'utf-8')
    checkpointCommit(spec.worktree, `feat(${spec.task.id})`)
    markTaskDone(spec.task.folder)
    return { exitCode: 0, text: `${spec.task.id} complete` }
  }
  abort() {}
}

test('abort then immediate start: old batch file is never re-written, new batch progresses (bug-batch-state-write)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'F-001-foo'), 'F-001', 'Foo', [])
  writeTask(join(tasksRoot, 'G-002-bar'), 'G-002', 'Bar', ['F-001'])
  const stateRoot = join(repo, '.taskswarm')
  const host = new SlowWorkerHost()
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host })

  // Start batch 1, then abort while wave 1 (F-001) is still running.
  const h1 = engine.run('all')
  await sleep(250)
  assert.equal(engine.abort(), true, 'abort returns true')

  // Old batch file must be terminal and never re-written.
  const oldPath = join(stateRoot, 'batches', `${h1.batchId}.json`)
  const oldStat1 = statSync(oldPath)
  await sleep(400) // let any stale write attempt land
  const oldStat2 = statSync(oldPath)
  const oldState = JSON.parse(readFileSync(oldPath, 'utf-8'))
  assert.equal(oldState.phase, 'aborted', 'old batch phase is aborted')
  assert.equal(oldStat2.mtimeMs, oldStat1.mtimeMs, 'old batch file mtime unchanged after abort')

  // Immediately start a new batch — must be allowed and must progress.
  const h2 = engine.run('all')
  assert.ok(h2.batchId.startsWith('b-'), 'new batch started')
  assert.notEqual(h2.batchId, h1.batchId)

  const deadline = Date.now() + 30_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.ok(state, 'new batch state exists')
  assert.equal(state.phase, 'complete', `new batch expected complete, got ${state.phase}`)
  assert.equal(state.id, h2.batchId, 'status() reflects the new batch')

  // The old (aborted) file must still be terminal and untouched.
  const oldStateAfter = JSON.parse(readFileSync(oldPath, 'utf-8'))
  assert.equal(oldStateAfter.phase, 'aborted', 'old batch still aborted after new batch ran')

  rmSync(repo, { recursive: true, force: true })
})

/** Fake host whose worker conflicts on shared.txt and whose merger FAILS
 *  to resolve → lane must land in `conflict` and the batch auto-pauses (B3#3). */
class UnresolvedMergerHost {
  constructor() { this.kind = 'fake' }

  async spawn(spec) {
    writeFileSync(join(spec.worktree, 'shared.txt'), `${spec.task.id} line\n`, 'utf-8')
    checkpointCommit(spec.worktree, `feat(${spec.task.id}): shared line`)
    markTaskDone(spec.task.folder)
    return { exitCode: 0, text: `${spec.task.id} complete` }
  }

  async spawnMerger() {
    // The LLM merge agent could not resolve the conflict.
    return { status: 'CONFLICT_UNRESOLVED', summary: 'could not reconcile both implementations' }
  }
}

test('unresolved merge conflict lands the lane in conflict and pauses the batch (B3#3)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'H-001-hotel'), 'H-001', 'Hotel', [])
  writeTask(join(tasksRoot, 'I-002-india'), 'I-002', 'India', [])
  const stateRoot = join(repo, '.taskswarm')
  const host = new UnresolvedMergerHost()
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host })

  engine.run('all')
  const deadline = Date.now() + 30_000
  let state = engine.status()
  // The batch pauses at a wave boundary after the conflict; it never completes on its own.
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.ok(state, 'batch state exists')
  assert.equal(state.phase, 'paused', `expected paused after conflict, got ${state.phase}`)

  // The conflicting lane is marked conflict (not failed silently).
  const conflictLanes = state.lanes.filter((l) => l.phase === 'conflict')
  assert.ok(conflictLanes.length >= 1, `expected >=1 conflict lane, got ${state.lanes.map((l) => `${l.taskId}:${l.phase}`).join(',')}`)

  // The scene is preserved: lane branch still exists for inspection.
  const branchOk = runGit(['rev-parse', '--verify', 'refs/heads/taskswarm/H-001'], repo)
  assert.ok(branchOk.ok || runGit(['rev-parse', '--verify', 'refs/heads/taskswarm/I-002'], repo).ok,
    'at least one conflicting lane branch is preserved')

  rmSync(repo, { recursive: true, force: true })
})

test('worker mission enforces incremental advance rules (B2)', async () => {
  const { buildWorkerMission } = await import('../lib/worker/lane-tools.js')
  const mission = buildWorkerMission('/tmp/tasks/T-1', '/tmp/wt', 1, 'T-1')
  assert.match(mission, /advance.*IMMEDIATELY|IMMEDIATELY.*advance/i, 'mission demands immediate advance')
  assert.match(mission, /Never accumulate work/i, 'mission bans batching checkboxes')
  assert.match(mission, /Do NOT edit STATUS\.md by hand/i, 'mission bans hand-editing STATUS.md')
  assert.match(mission, /Only call `done` when ALL Completion Criteria/i, 'mission gates done on completion criteria')
})
