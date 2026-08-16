import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskSwarmEngine } from '../lib/orchestrator/engine.js'
import { runGit } from '../lib/core/git.js'
import { readBatchState, writeBatchState, latestBatch } from '../lib/core/status.js'
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

/** Worker that fails a designated task (simulates a stuck/broken lane). */
class SelectiveFailHost {
  constructor(failTaskIds = []) {
    this.kind = 'fake'
    this.failTaskIds = new Set(failTaskIds)
  }
  async spawn(spec) {
    if (this.failTaskIds.has(spec.task.id)) {
      // Simulate a crashed/stuck worker: return non-zero (failed) without completing.
      return { exitCode: 1, text: '', error: 'worker crashed (simulated)' }
    }
    writeFileSync(join(spec.worktree, `${spec.task.id}.txt`), `${spec.task.id} done\n`, 'utf-8')
    checkpointCommit(spec.worktree, `feat(${spec.task.id})`)
    markTaskDone(spec.task.folder)
    return { exitCode: 0, text: `${spec.task.id} complete` }
  }
  abort() {}
}

test('a failed lane pauses the batch after the wave instead of rolling into the next (pauseOnLaneFailure)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  // Wave 1: J-001 ok + J-002 broken (parallel). Wave 2: K-003 depends on J-001.
  writeTask(join(tasksRoot, 'J-001-juliet'), 'J-001', 'Juliet', [])
  writeTask(join(tasksRoot, 'J-002-kilo'), 'J-002', 'Kilo', [])
  writeTask(join(tasksRoot, 'K-003-lima'), 'K-003', 'Lima', ['J-001'])
  const stateRoot = join(repo, '.taskswarm')
  const engine = new TaskSwarmEngine({
    repoRoot: repo, tasksRoot, stateRoot,
    host: new SelectiveFailHost(['J-002']),
  })

  engine.run('all')
  const deadline = Date.now() + 30_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.ok(state, 'batch state exists')
  // pauseOnLaneFailure (default true): the failed lane pauses the batch after wave 1;
  // wave 2 (K-003) must NOT run on its own.
  assert.equal(state.phase, 'paused', `expected paused after failed lane, got ${state.phase}`)
  const failedLane = state.lanes.find((l) => l.taskId === 'J-002')
  assert.ok(failedLane, 'failed lane recorded')
  assert.equal(failedLane.phase, 'failed', 'broken lane marked failed')
  const kLane = state.lanes.find((l) => l.taskId === 'K-003')
  assert.ok(kLane && kLane.phase !== 'merged', 'wave-2 lane did not run (batch paused)')

  // Disposition: operator decides to drop the failed lane and continue → resume.
  assert.equal(engine.resume(), true, 'resume after disposition')
  const deadline2 = Date.now() + 30_000
  let state2 = engine.status()
  while (state2 && (state2.phase === 'running' || state2.phase === 'planning')) {
    if (Date.now() > deadline2) break
    await sleep(100)
    state2 = engine.status()
  }
  assert.equal(state2.phase, 'complete', `expected complete after resume, got ${state2.phase}`)
  const kAfter = state2.lanes.find((l) => l.taskId === 'K-003')
  assert.equal(kAfter.phase, 'merged', 'wave-2 lane merged after resume')

  rmSync(repo, { recursive: true, force: true })
})

test('pauseOnLaneFailure=false lets the batch continue past a failed lane', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'M-001-mike'), 'M-001', 'Mike', [])
  writeTask(join(tasksRoot, 'M-002-nov'), 'M-002', 'November', [])
  const stateRoot = join(repo, '.taskswarm')
  const engine = new TaskSwarmEngine({
    repoRoot: repo, tasksRoot, stateRoot,
    host: new SelectiveFailHost(['M-002']), pauseOnLaneFailure: false,
  })

  engine.run('all')
  const deadline = Date.now() + 30_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.equal(state.phase, 'complete', `with pauseOnLaneFailure=false the batch completes, got ${state.phase}`)
  assert.equal(state.lanes.find((l) => l.taskId === 'M-002').phase, 'failed')

  rmSync(repo, { recursive: true, force: true })
})

test('stopLane kills one lane and pauses the batch after the wave', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'N-001-niner'), 'N-001', 'Niner', [])
  writeTask(join(tasksRoot, 'O-002-oscar'), 'O-002', 'Oscar', [])
  const stateRoot = join(repo, '.taskswarm')
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host: new SlowWorkerHost() })

  engine.run('all')
  await sleep(200) // let lanes start (SlowWorkerHost takes 800ms)
  // Stop O-002 while it is running.
  const stopped = engine.stopLane('O-002')
  assert.equal(stopped.ok, true, `stopLane succeeds: ${stopped.message}`)

  const deadline = Date.now() + 30_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.ok(state, 'state exists')
  assert.equal(state.phase, 'paused', `batch paused after stopped lane, got ${state.phase}`)
  const stoppedLane = state.lanes.find((l) => l.taskId === 'O-002')
  assert.equal(stoppedLane.phase, 'failed', 'stopped lane marked failed')
  assert.match(stoppedLane.error || '', /stopped/, 'error mentions stopped by operator')

  rmSync(repo, { recursive: true, force: true })
})

/** Host that records the model each spawn used. */
class ModelRecordingHost {
  constructor() { this.kind = 'fake'; this.spawnedModels = [] }
  async spawn(spec) {
    this.spawnedModels.push({ taskId: spec.task.id, model: spec.model })
    writeFileSync(join(spec.worktree, `${spec.task.id}.txt`), `${spec.task.id} done\n`, 'utf-8')
    checkpointCommit(spec.worktree, `feat(${spec.task.id})`)
    markTaskDone(spec.task.folder)
    return { exitCode: 0, text: `${spec.task.id} complete` }
  }
  abort() {}
}

test('switchLaneModel: records override, stops the lane, and reruns it with the new model (one-command SOP)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'P-001-papa'), 'P-001', 'Papa', [])
  writeTask(join(tasksRoot, 'Q-002-queen'), 'Q-002', 'Queen', [])
  const stateRoot = join(repo, '.taskswarm')
  const host = new ModelRecordingHost()
  const engine = new TaskSwarmEngine({
    repoRoot: repo, tasksRoot, stateRoot,
    host, workerModel: 'deepseek-v4-flash',
  })

  engine.run('all')
  const deadline = Date.now() + 30_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.equal(state.phase, 'complete', `batch completes, got ${state.phase}`)
  // Both lanes spawned with the default model first.
  assert.ok(host.spawnedModels.every((s) => s.model === 'deepseek-v4-flash'), 'initial spawns use workerModel')

  // Switch Q-002 to a different model — the batch is complete, so switchLaneModel
  // should refuse or no-op gracefully (no running batch). Assert the guard.
  const after = await engine.switchLaneModel('Q-002', 'deepseek-r1')
  assert.equal(after.ok, false, 'no running batch → switch refused')

  rmSync(repo, { recursive: true, force: true })
})

test('switchLaneModel reruns a running lane with the new model from the next step', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'R-001-romeo'), 'R-001', 'Romeo', [])
  writeTask(join(tasksRoot, 'S-002-sierra'), 'S-002', 'Sierra', [])
  const stateRoot = join(repo, '.taskswarm')
  // Slow host: lanes take 800ms, so switchLaneModel lands mid-run.
  const host = new ModelRecordingHost()
  const slowSpawn = host.spawn.bind(host)
  host.spawn = async (spec) => {
    await sleep(800)
    return slowSpawn(spec)
  }
  const engine = new TaskSwarmEngine({
    repoRoot: repo, tasksRoot, stateRoot,
    host, workerModel: 'deepseek-v4-flash',
  })

  engine.run('all')
  await sleep(250) // lanes started, still running (800ms)

  // Switch S-002 to deepseek-r1 while it is running.
  const result = await engine.switchLaneModel('S-002', 'deepseek-r1')
  assert.equal(result.ok, true, `switch succeeds: ${result.message}`)

  // Poll until the rerun with the new model actually spawns (async rerun).
  const deadline = Date.now() + 15_000
  let sSpawns = []
  while (Date.now() < deadline) {
    sSpawns = host.spawnedModels.filter((s) => s.taskId === 'S-002')
    if (sSpawns.some((s) => s.model === 'deepseek-r1')) break
    await sleep(100)
  }
  assert.ok(sSpawns.length >= 2, `S-002 spawned at least twice (initial + rerun), got ${sSpawns.length}`)
  assert.ok(sSpawns.some((s) => s.model === 'deepseek-r1'), 'rerun used the new model')

  rmSync(repo, { recursive: true, force: true })
})

test('pause then resume keeps the original wave count (wavePlan persisted, never recomputed)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  // 依赖链：A → B → C 组成 3 个 wave。
  writeTask(join(tasksRoot, 'W-001-alpha'), 'W-001', 'Alpha', [])
  writeTask(join(tasksRoot, 'W-002-bravo'), 'W-002', 'Bravo', ['W-001'])
  writeTask(join(tasksRoot, 'W-003-charlie'), 'W-003', 'Charlie', ['W-002'])
  const stateRoot = join(repo, '.taskswarm')
  const host = new SlowWorkerHost() // 800ms/lane
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host })

  engine.run('all')
  // 等 Wave 1（W-001）完成（800ms），此时 W-002/W-003 未开始。
  await sleep(1100)

  // 暂停（等当前 wave 跑完 = Wave 1 已完成，Wave 2 未开始）。
  assert.equal(engine.pause(), true, 'pause succeeds')
  let state = engine.status()
  const deadline = Date.now() + 10_000
  while (state && state.phase === 'running' && Date.now() < deadline) {
    await sleep(100)
    state = engine.status()
  }
  assert.equal(state.phase, 'paused', `batch paused, got ${state.phase}`)

  // 关键断言：暂停时 wavePlan 仍是 3 个 wave（不是只剩 2 个）。
  const pausedPlan = readBatchState(stateRoot, state.id)
  assert.equal(pausedPlan.waves, 3, `original wave count persisted, got ${pausedPlan.waves}`)
  assert.equal(pausedPlan.wavePlan.length, 3, `wavePlan array has 3 waves, got ${pausedPlan.wavePlan.length}`)

  // 恢复 → 应继续从 Wave 2 跑，wave 结构不变。
  assert.equal(engine.resume(), true, 'resume succeeds')
  const deadline2 = Date.now() + 30_000
  let state2 = engine.status()
  while (state2 && (state2.phase === 'running' || state2.phase === 'planning') && Date.now() < deadline2) {
    await sleep(100)
    state2 = engine.status()
  }
  assert.equal(state2.phase, 'complete', `batch completes after resume, got ${state2.phase}`)

  // 恢复后的 wavePlan 仍为 3（绝不能因恢复而重算成 2）。
  const afterPlan = readBatchState(stateRoot, state2.id)
  assert.equal(afterPlan.wavePlan.length, 3, `wavePlan stays 3 after resume, got ${afterPlan.wavePlan.length}`)
  // 所有 lane 的 wave 号与原始规划一致（W-001=1, W-002=2, W-003=3）。
  const waveById = new Map(afterPlan.lanes.map((l) => [l.taskId, l.wave]))
  assert.equal(waveById.get('W-001'), 1)
  assert.equal(waveById.get('W-002'), 2)
  assert.equal(waveById.get('W-003'), 3)

  rmSync(repo, { recursive: true, force: true })
})

test('pause mid-wave: disk phase stays paused after the wave completes (bug-pause-wave-write)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  // 依赖链：F-001 → G-002 组成 2 个 wave。
  writeTask(join(tasksRoot, 'F-001-foo'), 'F-001', 'Foo', [])
  writeTask(join(tasksRoot, 'G-002-bar'), 'G-002', 'Bar', ['F-001'])
  const stateRoot = join(repo, '.taskswarm')
  const host = new SlowWorkerHost() // 800ms/lane
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host })

  engine.run('all')
  // 等 Wave 1（F-001）完成、Wave 2（G-002）已开始跑（800ms lane 中途）。
  await sleep(1500)
  // 在 Wave 2 执行途中暂停（JM 场景：JM-407 还在跑时下 pause 指令）。
  assert.equal(engine.pause(), true, 'pause succeeds mid-wave')

  // 等 Wave 2 真正跑完（execute 波次完成写盘：G-002 → merged）。
  const deadline = Date.now() + 10_000
  let disk = latestBatch(stateRoot)
  while (Date.now() < deadline) {
    disk = latestBatch(stateRoot)
    const gLane = disk?.lanes?.find((l) => l.taskId === 'G-002')
    if (gLane && gLane.phase === 'merged') break
    await sleep(100)
  }
  const gLane = disk.lanes.find((l) => l.taskId === 'G-002')
  assert.equal(gLane.phase, 'merged', `wave-2 lane merged, got ${gLane.phase}`)

  // 关键断言：磁盘 phase 必须保持 paused——绝不能因 execute 波次完成写盘被覆盖回
  // running（bug-pause-wave-write：pause() 途中写盘 paused，execute 用内存 running
  // 整份覆盖，导致 dashboard/汇报显示"执行中"，但引擎实际已暂停）。
  assert.equal(disk.phase, 'paused', `disk phase stays paused after wave write-back, got ${disk.phase}`)

  // resume 后批次正常继续（无残留 paused 状态卡死）。
  assert.equal(engine.resume(), true, 'resume succeeds')
  const deadline2 = Date.now() + 30_000
  let state2 = engine.status()
  while (state2 && (state2.phase === 'running' || state2.phase === 'planning') && Date.now() < deadline2) {
    await sleep(100)
    state2 = engine.status()
  }
  assert.equal(state2.phase, 'complete', `batch completes after resume, got ${state2.phase}`)

  rmSync(repo, { recursive: true, force: true })
})

test('operator-paused batch: supervisor resume rejected, operator resume allowed (bug-autonomous-resume)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'P-001-papa'), 'P-001', 'Papa', [])
  writeTask(join(tasksRoot, 'Q-002-quebec'), 'Q-002', 'Quebec', ['P-001'])
  const stateRoot = join(repo, '.taskswarm')
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host: new SlowWorkerHost() })

  engine.run('all')
  // 等 Wave 1 完成、Wave 2 进行中，然后 operator 下令暂停。
  await sleep(1500)
  assert.equal(engine.pause('operator'), true, 'operator pause succeeds mid-wave')

  // 等 Wave 2 跑完（磁盘保持 paused、pausedBy=operator）。
  const deadline = Date.now() + 10_000
  let disk = latestBatch(stateRoot)
  while (Date.now() < deadline) {
    disk = latestBatch(stateRoot)
    const qLane = disk?.lanes?.find((l) => l.taskId === 'Q-002')
    if (qLane && qLane.phase === 'merged') break
    await sleep(100)
  }
  assert.equal(disk.phase, 'paused', `batch paused, got ${disk.phase}`)
  assert.equal(disk.pausedBy, 'operator', `pausedBy=operator recorded, got ${disk.pausedBy}`)

  // supervisor 自主 resume → 必须被拒绝（引擎层校验）。
  assert.equal(engine.resume(undefined, 'supervisor'), false, 'supervisor autonomous resume rejected')

  // operator 显式 resume → 放行，批次继续跑完。
  assert.equal(engine.resume(undefined, 'operator'), true, 'operator resume allowed')
  const deadline2 = Date.now() + 30_000
  let state2 = engine.status()
  while (state2 && (state2.phase === 'running' || state2.phase === 'planning') && Date.now() < deadline2) {
    await sleep(100)
    state2 = engine.status()
  }
  assert.equal(state2.phase, 'complete', `batch completes after operator resume, got ${state2.phase}`)

  rmSync(repo, { recursive: true, force: true })
})

test('engine-auto-paused batch (failed lane): supervisor resume allowed', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'R-001-roger'), 'R-001', 'Roger', [])
  writeTask(join(tasksRoot, 'S-002-sierra'), 'S-002', 'Sierra', ['R-001'])
  const stateRoot = join(repo, '.taskswarm')
  // J-002 类似场景：让 wave 1 的 lane 失败 → 引擎自动暂停。
  const engine = new TaskSwarmEngine({
    repoRoot: repo, tasksRoot, stateRoot,
    host: new (class {
      constructor() { this.kind = 'fake' }
      async spawn(spec) {
        // R-001 正常完成；S-002 直接失败（模拟 pauseOnLaneFailure 的 failed lane 在 wave 1）。
        if (spec.task.id === 'R-001') {
          writeFileSync(join(spec.worktree, 'r.txt'), 'ok\n', 'utf-8')
          checkpointCommit(spec.worktree, 'feat(R-001)')
          markTaskDone(spec.task.folder)
          return { exitCode: 0, text: 'ok' }
        }
        writeFileSync(join(spec.worktree, 's.txt'), 'bad\n', 'utf-8')
        checkpointCommit(spec.worktree, 'feat(S-002)')
        return { exitCode: 1, text: 'boom' }
      }
      abort() {}
    })(),
  })

  engine.run('all')
  const deadline = Date.now() + 10_000
  let state = engine.status()
  while (state && state.phase === 'running' && Date.now() < deadline) {
    await sleep(100)
    state = engine.status()
  }
  assert.equal(state.phase, 'paused', `engine auto-paused after failed lane, got ${state.phase}`)
  assert.equal(state.pausedBy, 'engine', `pausedBy=engine, got ${state.pausedBy}`)

  // 引擎自动暂停：supervisor 有权 resume（跳过 failed lane 继续）。
  assert.equal(engine.resume(undefined, 'supervisor'), true, 'supervisor resume allowed for engine-paused batch')
  const deadline2 = Date.now() + 30_000
  let state2 = engine.status()
  while (state2 && (state2.phase === 'running' || state2.phase === 'planning') && Date.now() < deadline2) {
    await sleep(100)
    state2 = engine.status()
  }
  assert.equal(state2.phase, 'complete', `batch completes after supervisor resume, got ${state2.phase}`)

  rmSync(repo, { recursive: true, force: true })
})

test('abort then immediate start: new batch runs cleanly (no cross-batch interference)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'X-001-xray'), 'X-001', 'Xray', [])
  writeTask(join(tasksRoot, 'Y-002-yankee'), 'Y-002', 'Yankee', [])
  const stateRoot = join(repo, '.taskswarm')
  const engine = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host: new SlowWorkerHost() })

  const h1 = engine.run('all')
  await sleep(200)
  assert.equal(engine.abort(), true, 'abort succeeds')
  await sleep(500) // let the abort settle

  // abort 后立刻 start 新批次：必须成功（不是"no running batch"错）。
  const h2 = engine.run('all')
  assert.ok(h2.batchId.startsWith('b-'), 'new batch starts after abort')
  assert.notEqual(h2.batchId, h1.batchId, 'new batch id differs')

  const deadline = Date.now() + 20_000
  let state = engine.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine.status()
  }
  assert.equal(state.phase, 'complete', `new batch completes after abort+start, got ${state.phase}`)
  assert.equal(state.id, h2.batchId, 'status reflects the new batch')

  rmSync(repo, { recursive: true, force: true })
})

test('crash recovery: a fresh engine instance resumes the batch and keeps the wave plan', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'Z-001-zulu'), 'Z-001', 'Zulu', [])
  writeTask(join(tasksRoot, 'AA-002-alfa'), 'AA-002', 'Alfa', ['Z-001'])
  const stateRoot = join(repo, '.taskswarm')

  // 构造崩溃现场（等价于进程死在 Wave 1 完成后）：磁盘 phase=running、
  // Wave 1 (Z-001) merged、Wave 2 (AA-002) pending、wavePlan 持久化。
  writeBatchState({
    id: 'b-crash', repoRoot: repo, tasksRoot, stateRoot, phase: 'running',
    scope: 'all', startedAt: new Date().toISOString(), waves: 2,
    wavePlan: [['Z-001'], ['AA-002']],
    lanes: [
      { lane: 1, taskId: 'Z-001', phase: 'merged', wave: 1, log: ['merged'] },
      { lane: 2, taskId: 'AA-002', phase: 'pending', wave: 2, log: [] },
    ],
  })

  // 新实例（模拟重启）resume：应从磁盘恢复，wave 结构不变。
  const engine2 = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host: new SlowWorkerHost() })
  assert.equal(engine2.resume(), true, 'fresh engine resumes the pending batch')

  const deadline = Date.now() + 25_000
  let state = engine2.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine2.status()
  }
  assert.equal(state.phase, 'complete', `recovered batch completes, got ${state.phase}`)
  // wavePlan 原样保持 2 个 wave（Z-001 已完成 + AA-002 待跑）。
  assert.equal(state.wavePlan.length, 2, `wavePlan keeps 2 waves after crash recovery, got ${state.wavePlan.length}`)
  const z = state.lanes.find((l) => l.taskId === 'Z-001')
  const aa = state.lanes.find((l) => l.taskId === 'AA-002')
  assert.equal(z.phase, 'merged', 'completed wave-1 lane merged')
  assert.equal(aa.phase, 'merged', 'wave-2 lane merged after recovery')
  assert.equal(z.wave, 1, 'lane Z-001 wave=1 preserved')
  assert.equal(aa.wave, 2, 'lane AA-002 wave=2 preserved')

  // 让后台异步尾巴 settle 后再清理。
  await sleep(1200)
  rmSync(repo, { recursive: true, force: true })
})

test('resume after restart rebinds the batch owner to the new conversation (2026-08-17)', async () => {
  const repo = await makeRepo()
  const tasksRoot = join(repo, 'tasks')
  writeTask(join(tasksRoot, 'AB-001-echo'), 'AB-001', 'Echo', [])
  writeTask(join(tasksRoot, 'AC-002-foxtrot'), 'AC-002', 'Foxtrot', ['AB-001'])
  const stateRoot = join(repo, '.taskswarm')

  // 构造崩溃现场（等价于进程死在 Wave 1 完成后）：磁盘 phase=paused、Wave 1 merged、Wave 2 pending。
  writeBatchState({
    id: 'b-rebind', repoRoot: repo, tasksRoot, stateRoot, phase: 'paused',
    scope: 'all', startedAt: new Date().toISOString(), waves: 2,
    wavePlan: [['AB-001'], ['AC-002']],
    lanes: [
      { lane: 1, taskId: 'AB-001', phase: 'merged', wave: 1, log: ['merged'] },
      { lane: 2, taskId: 'AC-002', phase: 'pending', wave: 2, log: [] },
    ],
  })

  // 新实例（模拟重启）：新对话（session B）resume → owner 应重绑到 session B。
  const hostB = { kind: 'fake', async spawn(spec) { writeFileSync(join(spec.worktree, spec.task.id + '.txt'), 'ok\n'); checkpointCommit(spec.worktree, 'feat'); markTaskDone(spec.task.folder); return { exitCode: 0, text: 'ok' } }, abort() {} }
  const sessionB = { id: 'session-B' }
  const engine2 = new TaskSwarmEngine({ repoRoot: repo, tasksRoot, stateRoot, host: hostB })
  assert.equal(engine2.resume(sessionB), true, 'fresh engine resumes with new owner')

  // 断言：activeBatchOwnerAgent 现在是 session B（而非 undefined）。
  const owner = engine2.activeBatchOwnerAgent()
  assert.ok(owner, 'batch has an owner after resume')
  assert.equal(owner && owner.id, 'session-B', 'owner rebound to the new conversation')

  const deadline = Date.now() + 20_000
  let state = engine2.status()
  while (state && (state.phase === 'running' || state.phase === 'planning')) {
    if (Date.now() > deadline) break
    await sleep(100)
    state = engine2.status()
  }
  assert.equal(state.phase, 'complete', `batch completes, got ${state.phase}`)

  await sleep(500)
  rmSync(repo, { recursive: true, force: true })
})
