import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cjkRatio,
  detectLocaleFromText,
  detectLocaleFromSession,
  resolveLocale,
  messages,
} from '../lib/orchestrator/i18n.js'
import {
  readSettings,
  writeSetting,
  removeSetting,
  repoConfigPath,
} from '../lib/orchestrator/settings.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'taskswarm-i18n-'))
}

test('cjkRatio / detectLocaleFromText', () => {
  assert.ok(cjkRatio('启动 WEB-006 并汇报') > 0.3)
  assert.equal(detectLocaleFromText('start WEB-006 and report'), 'en')
  assert.equal(detectLocaleFromText('帮我启动批次'), 'zh-CN')
  assert.equal(detectLocaleFromText(''), 'en') // 无信号 → en（由会话检测层兜底 zh-CN）
})

test('detectLocaleFromSession: 中文会话 → zh-CN', () => {
  const sessions = {
    get() {
      return {
        surface: {
          deriveMessages() {
            return [
              { role: 'user', content: [{ type: 'text', text: '帮我跑一个 demo 批次' }], source: { kind: 'user' } },
              { role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } },
              { role: 'user', content: [{ type: 'text', text: '清理一下残留' }], source: { kind: 'user' } },
            ]
          },
        },
      }
    },
  }
  assert.equal(detectLocaleFromSession(sessions, 's1'), 'zh-CN')
})

test('detectLocaleFromSession: 英文会话 → en', () => {
  const sessions = {
    get() {
      return {
        surface: {
          deriveMessages() {
            return [
              { role: 'user', content: [{ type: 'text', text: 'run a demo batch please' }], source: { kind: 'user' } },
              { role: 'user', content: [{ type: 'text', text: 'clean up the leftovers' }], source: { kind: 'user' } },
            ]
          },
        },
      }
    },
  }
  assert.equal(detectLocaleFromSession(sessions, 's2'), 'en')
})

test('detectLocaleFromSession: 无会话/无消息 → zh-CN 兜底', () => {
  assert.equal(detectLocaleFromSession(undefined, undefined), 'zh-CN')
  assert.equal(detectLocaleFromSession({ get: () => undefined }, 'gone'), 'zh-CN')
  assert.equal(detectLocaleFromSession({ get: () => ({ surface: {} }) }, 'empty'), 'zh-CN')
})

test('resolveLocale: 显式 config 优先于检测', () => {
  const zhSessions = { get: () => ({ surface: { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '中文' }], source: { kind: 'user' } }] } }) }
  assert.equal(resolveLocale('en', zhSessions, 's'), 'en')
  assert.equal(resolveLocale('zh-CN', undefined, undefined), 'zh-CN')
  assert.equal(resolveLocale(undefined, zhSessions, 's'), 'zh-CN')
})

test('messages: 双语字典关键事件标题', () => {
  const zh = messages('zh-CN')
  const en = messages('en')
  assert.match(zh.batchStarted('b-1', 3), /已启动/)
  assert.match(en.batchStarted('b-1', 3), /started/)
  assert.match(en.batchAborted('b-1'), /aborted/)
  assert.match(zh.waveComplete(1, 3, 2, 1), /Wave 1\/3/)
  assert.match(en.waveComplete(1, 3, 2, 1), /Wave 1\/3 complete: 2 merged \/ 1 failed/)
  assert.match(en.laneFailed(2, 'DEMO-006', 'worker exited 1'), /failed: worker exited 1/)
  assert.match(zh.laneFailed(2, 'DEMO-006'), /失败/)
})

test('settings: config.json 合并读写 / locale / reportIntervalMinutes', () => {
  const dir = tmp()
  try {
    // 初始无配置
    assert.deepEqual(readSettings(dir), {})
    assert.equal(existsSync(repoConfigPath(dir)), false)

    // 写入 locale，其他键保留
    writeSetting(dir, 'locale', 'en')
    assert.deepEqual(readSettings(dir), { locale: 'en' })

    // 再写 reportIntervalMinutes，locale 不丢（合并式）
    writeSetting(dir, 'reportIntervalMinutes', 15)
    const settings = readSettings(dir)
    assert.equal(settings.locale, 'en')
    assert.equal(settings.reportIntervalMinutes, 15)

    // 文件内容含两个键
    const raw = JSON.parse(readFileSync(repoConfigPath(dir), 'utf-8'))
    assert.equal(raw.locale, 'en')
    assert.equal(raw.reportIntervalMinutes, 15)

    // 移除 locale → 只剩 reportIntervalMinutes
    removeSetting(dir, 'locale')
    assert.deepEqual(readSettings(dir), { reportIntervalMinutes: 15 })

    // 非法值被忽略
    writeSetting(dir, 'locale', 'auto') // auto 不以键形式存储
    assert.equal(readSettings(dir).locale, undefined)
    writeSetting(dir, 'reportIntervalMinutes', -5)
    assert.equal(readSettings(dir).reportIntervalMinutes, 15)

    // 全部移除 → 文件删除
    removeSetting(dir, 'reportIntervalMinutes')
    assert.equal(existsSync(repoConfigPath(dir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
