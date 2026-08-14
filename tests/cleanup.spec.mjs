/**
 * Supervisor 会话历史清理 helpers 单测：
 *  - formatBytes：人类可读字节数
 *  - laneSessionDir / laneSessionDirs：worktree → ~/.dsh/sessions/--<path>--/ 映射
 *  - sessionsBytes / deleteLaneSessions：对不存在的目录安全返回 0
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  formatBytes,
  laneSessionDir,
  laneSessionDirs,
  sessionsBytes,
  deleteLaneSessions,
} from '../lib/orchestrator/supervisor.js'

test('formatBytes: 人类可读字节数', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.50 GB')
  assert.equal(formatBytes(-1), '0 B')
  assert.equal(formatBytes(Number.NaN), '0 B')
})

test('laneSessionDir: worktree 路径 → 会话目录名（/ 转 -，前后加 --）', () => {
  assert.equal(
    laneSessionDir('/Users/robin/myProject/dsh-buju/.taskswarm/worktrees/jm-341'),
    join(homedir(), '.dsh', 'sessions', '--Users-robin-myProject-dsh-buju-.taskswarm-worktrees-jm-341--'),
  )
})

test('laneSessionDirs / sessionsBytes / deleteLaneSessions: 无 worktree 或目录不存在时安全返回', () => {
  const lanes = [
    { lane: 1, taskId: 'T-1', phase: 'running' }, // 无 worktree
    { lane: 2, taskId: 'T-2', phase: 'running', worktree: '/nonexistent/never-existed' }, // 目录不存在
  ]
  assert.deepEqual(laneSessionDirs(lanes), [])
  assert.equal(sessionsBytes(lanes), 0)
  assert.deepEqual(deleteLaneSessions(lanes), { dirs: 0, bytes: 0 })
})
