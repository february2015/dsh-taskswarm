import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../lib/orchestrator/index.js'
import { registerLaneTools } from '../lib/worker/lane-tools.js'
import { grantWorkerFullAccess } from '../lib/worker/worker-tools.js'

test('orchestrator plugin registers the /orch-family commands', () => {
  const registered = []
  const ctx = {
    get: () => undefined,
    provide: () => undefined,
    commands: { register: (def) => registered.push(def.name) },
  }
  apply(ctx, {})
  const expected = [
    'orch', 'orch-plan', 'orch-status', 'orch-pause', 'orch-resume',
    'orch-abort', 'orch-deps', 'orch-sessions', 'orch-integrate', 'tswarm-init',
  ]
  for (const name of expected) {
    assert.ok(registered.includes(name), `command /${name} registered`)
  }
})

test('lane tools register the four bridge tools plus task_runner', () => {
  const registered = []
  const lane = {
    taskDir: '/tmp/t', worktree: '/tmp/w', repoRoot: '/tmp/r',
    batchId: 'b-1', stateRoot: '/tmp/s', lane: 1,
  }
  registerLaneTools({ tools: { register: (def) => registered.push(def.name) } }, lane)
  const expected = ['task_runner', 'review_step', 'notify_supervisor', 'escalate_to_supervisor', 'request_segment_expansion']
  for (const name of expected) {
    assert.ok(registered.includes(name), `tool ${name} registered`)
  }
})

test('grantWorkerFullAccess injects danger-full-access + approval never on the worker session', () => {
  const appended = []
  const agentCtx = {
    agent: { session: { append: (type, data) => appended.push({ type, data }) } },
  }
  grantWorkerFullAccess(agentCtx)
  const modes = appended.filter((e) => e.type === 'sandbox/mode')
  const policies = appended.filter((e) => e.type === 'approval/policy')
  assert.equal(modes.length, 1)
  assert.equal(modes[0].data.mode, 'danger-full-access')
  assert.equal(policies.length, 1)
  assert.equal(policies[0].data.policy, 'never')
})

test('every agent spawner (worker/reviewer/merger/runner) grants full access in setup', () => {
  // 回归防护（2026-08-16）：reviewer 曾漏掉 grantWorkerFullAccess → 会话保持
  // workspace-write + ask → 触发授权提醒。检查所有 agents.create setup 都调用它。
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const files = [
    'orchestrator/in-process-host.ts',
    'worker/reviewer.ts',
    'worker/merger.ts',
    'worker/runner.ts',
  ]
  for (const rel of files) {
    const src = readFileSync(join(srcRoot, rel), 'utf-8')
    assert.match(src, /grantWorkerFullAccess/, `${rel} must grant full access in setup`)
  }
})
