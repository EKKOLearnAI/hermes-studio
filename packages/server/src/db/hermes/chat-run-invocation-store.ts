import { getDb } from '../index'
import { CHAT_RUN_INVOCATIONS_TABLE } from './schemas'

export type ChatRunInvocationStatus = 'running' | 'requires_action' | 'completed' | 'failed' | 'canceled'
export type ChatRunInvocationTerminalStatus = 'completed' | 'failed' | 'canceled'

const MAX_INVOCATION_TEXT_BYTES = 2 * 1024 * 1024

function boundedText(value?: string | null): string | null {
  if (value == null) return null
  const text = String(value)
  if (Buffer.byteLength(text, 'utf8') <= MAX_INVOCATION_TEXT_BYTES) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (Buffer.byteLength(text.slice(mid), 'utf8') > MAX_INVOCATION_TEXT_BYTES) low = mid + 1
    else high = mid
  }
  let start = low
  if (start > 0) {
    const code = text.charCodeAt(start)
    if (code >= 0xDC00 && code <= 0xDFFF) start += 1
  }
  return text.slice(start)
}

export interface ChatRunInvocationRecord {
  id: string
  session_id: string
  run_id: string
  status: ChatRunInvocationStatus
  output: string | null
  reasoning: string | null
  error: string | null
  action: Record<string, unknown> | null
  started_at: number
  finished_at: number | null
}

function mapRow(row: Record<string, unknown>): ChatRunInvocationRecord {
  return {
    id: String(row.id || ''),
    session_id: String(row.session_id || ''),
    run_id: String(row.run_id || ''),
    status: String(row.status || 'running') as ChatRunInvocationStatus,
    output: row.output == null ? null : String(row.output),
    reasoning: row.reasoning == null ? null : String(row.reasoning),
    error: row.error == null ? null : String(row.error),
    action: (() => {
      if (row.action == null || row.action === '') return null
      try { return JSON.parse(String(row.action)) as Record<string, unknown> } catch { return null }
    })(),
    started_at: Number(row.started_at || 0),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
  }
}

export function createChatRunInvocation(input: {
  id: string
  sessionId: string
  startedAt?: number
}): ChatRunInvocationRecord {
  const db = getDb()
  if (!db) throw new Error('SQLite is required for durable chat run invocations')
  const startedAt = input.startedAt ?? Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO ${CHAT_RUN_INVOCATIONS_TABLE} (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)`,
  ).run(input.id, input.sessionId, startedAt)
  return getChatRunInvocation(input.id)!
}

export function getChatRunInvocation(id: string): ChatRunInvocationRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${CHAT_RUN_INVOCATIONS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

export function markChatRunInvocationRequiresAction(
  id: string,
  action: Record<string, unknown>,
): boolean {
  const db = getDb()
  if (!db) return false
  const result = db.prepare(
    `UPDATE ${CHAT_RUN_INVOCATIONS_TABLE} SET status = 'requires_action', action = ? WHERE id = ? AND status = 'running'`,
  ).run(JSON.stringify(action), id)
  return Number(result.changes || 0) === 1
}

export function recoverOrphanedChatRunInvocations(reason = 'Chat run interrupted by server restart'): number {
  const db = getDb()
  if (!db) return 0
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    `UPDATE ${CHAT_RUN_INVOCATIONS_TABLE}
       SET status = 'failed', error = ?, action = NULL, finished_at = ?
     WHERE status IN ('running', 'requires_action')`,
  ).run(reason, now)
  return Number(result.changes || 0)
}

export function pruneChatRunInvocations(finishedBefore: number): number {
  const db = getDb()
  if (!db) return 0
  const result = db.prepare(
    `DELETE FROM ${CHAT_RUN_INVOCATIONS_TABLE} WHERE finished_at IS NOT NULL AND finished_at < ?`,
  ).run(finishedBefore)
  return Number(result.changes || 0)
}

export function settleChatRunInvocation(
  id: string,
  terminal: {
    status: ChatRunInvocationTerminalStatus
    runId?: string | null
    output?: string | null
    reasoning?: string | null
    error?: string | null
    finishedAt?: number
  },
): boolean {
  const db = getDb()
  if (!db) return false
  const result = db.prepare(
    `UPDATE ${CHAT_RUN_INVOCATIONS_TABLE}
       SET run_id = ?, status = ?, output = ?, reasoning = ?, error = ?, action = NULL, finished_at = ?
     WHERE id = ? AND status IN ('running', 'requires_action')`,
  ).run(
    terminal.runId || '',
    terminal.status,
    boundedText(terminal.output),
    boundedText(terminal.reasoning),
    boundedText(terminal.error),
    terminal.finishedAt ?? Math.floor(Date.now() / 1000),
    id,
  )
  return Number(result.changes || 0) === 1
}
