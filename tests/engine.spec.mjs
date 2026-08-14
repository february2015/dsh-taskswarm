import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
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
