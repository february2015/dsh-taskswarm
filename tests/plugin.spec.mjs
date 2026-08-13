import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/orchestrator/index.js'
import { registerLaneTools } from '../lib/worker/lane-tools.js'

test('orchestrator plugin registers the /orch-family commands', () => {
  const registered = []
  const ctx = {
    get: () => undefined,
    commands: { register: (def) => registered.push(def.name) },
  }
  apply(ctx, {})
  const expected = [
    'orch', 'orch-plan', 'orch-status', 'orch-pause', 'orch-resume',
    'orch-abort', 'orch-deps', 'orch-sessions', 'orch-integrate', 'buju-init',
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
