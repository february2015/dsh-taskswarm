/**
 * Agent Mailbox — file-based cross-agent messaging.
 * Adapted from TaskPlane `extensions/taskplane/mailbox.ts`
 * (github.com/HenryLach/taskplane, MIT License). Lean re-implementation:
 * atomic writes (temp file + rename), best-effort reads, ack = move to `_ack/`.
 *
 * Directory layout under the batch state root:
 *   <stateRoot>/mailbox/<batchId>/
 *     supervisor/inbox/          ← worker → supervisor messages
 *     supervisor/ack/
 *     <lane>/outbox/             ← worker outbound copies
 *     broadcast/                 ← supervisor → all lanes
 * @module taskswarm/core/mailbox
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type MailboxMessageType = 'notify' | 'escalate' | 'request' | 'broadcast' | 'reply'

export interface MailboxMessage {
  id: string
  from: string
  to: string
  type: MailboxMessageType
  payload: unknown
  ts: string
}

export const SUPERVISOR_SESSION = 'supervisor'

export function mailboxRoot(stateRoot: string, batchId: string): string {
  return join(stateRoot, 'mailbox', batchId)
}

export function sessionInboxDir(stateRoot: string, batchId: string, sessionName: string): string {
  return join(mailboxRoot(stateRoot, batchId), sessionName, 'inbox')
}

export function sessionAckDir(stateRoot: string, batchId: string, sessionName: string): string {
  return join(mailboxRoot(stateRoot, batchId), sessionName, 'ack')
}

export function sessionOutboxDir(stateRoot: string, batchId: string, sessionName: string): string {
  return join(mailboxRoot(stateRoot, batchId), sessionName, 'outbox')
}

export function broadcastInboxDir(stateRoot: string, batchId: string): string {
  return join(mailboxRoot(stateRoot, batchId), 'broadcast')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function isMailboxMessage(obj: unknown): obj is MailboxMessage {
  if (typeof obj !== 'object' || obj === null) return false
  const m = obj as Record<string, unknown>
  return (
    typeof m.id === 'string'
    && typeof m.from === 'string'
    && typeof m.to === 'string'
    && typeof m.type === 'string'
    && typeof m.ts === 'string'
  )
}

/**
 * Atomically append a message to an inbox. Returns the message written.
 */
export function writeMailboxMessage(
  inboxDir: string,
  from: string,
  to: string,
  type: MailboxMessageType,
  payload: unknown,
): MailboxMessage {
  ensureDir(inboxDir)
  const message: MailboxMessage = {
    id: randomUUID(),
    from,
    to,
    type,
    payload,
    ts: new Date().toISOString(),
  }
  const filename = `${Date.now()}-${message.id.slice(0, 8)}.json`
  const target = join(inboxDir, filename)
  const tmp = join(inboxDir, `.${filename}.tmp`)
  writeFileSync(tmp, JSON.stringify(message), 'utf-8')
  renameSync(tmp, target)
  return message
}

/** Read all un-acked messages in an inbox (oldest first). */
export function readInbox(inboxDir: string): MailboxMessage[] {
  if (!existsSync(inboxDir)) return []
  const messages: MailboxMessage[] = []
  for (const name of readdirSync(inboxDir).sort()) {
    if (name.startsWith('.')) continue
    const full = join(inboxDir, name)
    if (!existsSync(full)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(full, 'utf-8'))
      if (isMailboxMessage(parsed)) messages.push(parsed)
    } catch {
      /* skip corrupt message files */
    }
  }
  return messages
}

/** Ack a message by moving it into the inbox's `_ack/` sibling. */
export function ackMessage(inboxDir: string, filename: string): boolean {
  const source = join(inboxDir, filename)
  if (!existsSync(source)) return false
  const ackDir = join(inboxDir, '_ack')
  ensureDir(ackDir)
  try {
    renameSync(source, join(ackDir, filename))
    return true
  } catch {
    return false
  }
}

/** Drain an inbox: ack everything, returning the drained messages. */
export function drainInbox(inboxDir: string): MailboxMessage[] {
  const messages = readInbox(inboxDir)
  for (const m of messages) {
    // Locate the file by id suffix; filenames are `<ts>-<id8>.json`.
    for (const name of readdirSync(inboxDir)) {
      if (name.endsWith(`-${m.id.slice(0, 8)}.json`)) {
        ackMessage(inboxDir, name)
        break
      }
    }
  }
  return messages
}

/** Remove a mailbox subtree entirely (batch teardown). */
export function removeMailbox(stateRoot: string, batchId: string): void {
  const root = mailboxRoot(stateRoot, batchId)
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}

/** Discover agent ids that have mailbox entries for a batch. */
export function discoverMailboxAgentIds(stateRoot: string, batchId: string): string[] {
  const root = mailboxRoot(stateRoot, batchId)
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => !name.startsWith('.'))
}
