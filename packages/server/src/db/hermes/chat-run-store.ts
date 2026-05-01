import { getDb, isSqliteAvailable } from '../index'
import { CHAT_SESSION_RUNS_TABLE, CHAT_SYNCED_MESSAGES_TABLE } from './schemas'

export type ChatSessionRunStatus = 'started' | 'running' | 'completed' | 'failed' | 'synced' | 'sync_failed'

export interface ChatSessionRunRow {
  id: number
  wui_session_id: string
  hermes_session_id: string
  run_id: string | null
  profile: string
  status: ChatSessionRunStatus
  started_at: number
  completed_at: number | null
  last_sync_at: number | null
  sync_error: string | null
}

export interface RecordChatSessionRunInput {
  wuiSessionId: string
  hermesSessionId: string
  runId?: string | null
  profile?: string | null
  status?: ChatSessionRunStatus
  startedAt?: number
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function mapRunRow(row: Record<string, unknown>): ChatSessionRunRow {
  return {
    id: Number(row.id),
    wui_session_id: String(row.wui_session_id || ''),
    hermes_session_id: String(row.hermes_session_id || ''),
    run_id: row.run_id != null ? String(row.run_id) : null,
    profile: String(row.profile || 'default'),
    status: String(row.status || 'started') as ChatSessionRunStatus,
    started_at: Number(row.started_at || 0),
    completed_at: row.completed_at != null ? Number(row.completed_at) : null,
    last_sync_at: row.last_sync_at != null ? Number(row.last_sync_at) : null,
    sync_error: row.sync_error != null ? String(row.sync_error) : null,
  }
}

export function recordChatSessionRun(input: RecordChatSessionRunInput): ChatSessionRunRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  if (!db) return null

  const startedAt = input.startedAt ?? nowSeconds()
  const profile = input.profile || 'default'
  const status = input.status || 'started'

  db.prepare(
    `INSERT INTO ${CHAT_SESSION_RUNS_TABLE}
       (wui_session_id, hermes_session_id, run_id, profile, status, started_at, sync_error)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(hermes_session_id) DO UPDATE SET
       wui_session_id = excluded.wui_session_id,
       run_id = COALESCE(excluded.run_id, ${CHAT_SESSION_RUNS_TABLE}.run_id),
       profile = excluded.profile,
       status = CASE
         WHEN ${CHAT_SESSION_RUNS_TABLE}.status = 'synced' THEN ${CHAT_SESSION_RUNS_TABLE}.status
         ELSE excluded.status
       END,
       started_at = MIN(${CHAT_SESSION_RUNS_TABLE}.started_at, excluded.started_at),
       sync_error = CASE
         WHEN ${CHAT_SESSION_RUNS_TABLE}.status = 'synced' THEN ${CHAT_SESSION_RUNS_TABLE}.sync_error
         ELSE NULL
       END`,
  ).run(input.wuiSessionId, input.hermesSessionId, input.runId ?? null, profile, status, startedAt)

  return getChatSessionRunByHermesSessionId(input.hermesSessionId)
}

export function updateChatSessionRunByHermesId(
  hermesSessionId: string,
  data: Partial<Pick<ChatSessionRunRow, 'run_id' | 'profile' | 'status' | 'completed_at' | 'last_sync_at' | 'sync_error'>>,
): void {
  if (!isSqliteAvailable()) return
  const db = getDb()
  if (!db) return

  const fields: string[] = []
  const values: any[] = []
  for (const [key, value] of Object.entries(data)) {
    fields.push(`"${key}" = ?`)
    values.push(value)
  }
  if (!fields.length) return
  values.push(hermesSessionId)
  db.prepare(`UPDATE ${CHAT_SESSION_RUNS_TABLE} SET ${fields.join(', ')} WHERE hermes_session_id = ?`).run(...values)
}

export function markChatSessionRunCompleted(
  hermesSessionId: string,
  status: Extract<ChatSessionRunStatus, 'completed' | 'failed'>,
  completedAt = nowSeconds(),
): void {
  if (!isSqliteAvailable()) return
  const db = getDb()
  if (!db) return
  db.prepare(
    `UPDATE ${CHAT_SESSION_RUNS_TABLE}
     SET status = ?, completed_at = ?, sync_error = NULL
     WHERE hermes_session_id = ? AND status != 'synced'`,
  ).run(status, completedAt, hermesSessionId)
}

export function markChatSessionRunSynced(hermesSessionId: string, lastSyncAt = nowSeconds()): void {
  updateChatSessionRunByHermesId(hermesSessionId, {
    status: 'synced',
    last_sync_at: lastSyncAt,
    sync_error: null,
  })
}

export function markChatSessionRunSyncFailed(hermesSessionId: string, error: string, at = nowSeconds()): void {
  if (!isSqliteAvailable()) return
  const db = getDb()
  if (!db) return
  db.prepare(
    `UPDATE ${CHAT_SESSION_RUNS_TABLE}
     SET status = 'sync_failed', last_sync_at = ?, sync_error = ?
     WHERE hermes_session_id = ? AND status NOT IN ('synced', 'failed')`,
  ).run(at, error.slice(0, 1000), hermesSessionId)
}

export function getChatSessionRunByHermesSessionId(hermesSessionId: string): ChatSessionRunRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${CHAT_SESSION_RUNS_TABLE} WHERE hermes_session_id = ?`).get(hermesSessionId) as Record<string, unknown> | undefined
  return row ? mapRunRow(row) : null
}

export function getChatSessionRunByRunId(wuiSessionId: string, runId?: string | null): ChatSessionRunRow | null {
  if (!isSqliteAvailable() || !runId) return null
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${CHAT_SESSION_RUNS_TABLE}
     WHERE wui_session_id = ? AND run_id = ?
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
  ).get(wuiSessionId, runId) as Record<string, unknown> | undefined
  return row ? mapRunRow(row) : null
}

export function getLatestRepairableChatSessionRun(wuiSessionId: string, runId?: string | null): ChatSessionRunRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  if (!db) return null

  if (runId) {
    const exact = getChatSessionRunByRunId(wuiSessionId, runId)
    if (exact && exact.status !== 'synced' && exact.status !== 'failed') return exact
  }

  const row = db.prepare(
    `SELECT * FROM ${CHAT_SESSION_RUNS_TABLE}
     WHERE wui_session_id = ? AND status NOT IN ('synced', 'failed')
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
  ).get(wuiSessionId) as Record<string, unknown> | undefined
  return row ? mapRunRow(row) : null
}

export function listRepairableChatSessionRuns(wuiSessionId: string, limit = 20): ChatSessionRunRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(
    `SELECT * FROM ${CHAT_SESSION_RUNS_TABLE}
     WHERE wui_session_id = ? AND status NOT IN ('synced', 'failed')
     ORDER BY
       CASE status WHEN 'completed' THEN 0 WHEN 'sync_failed' THEN 1 WHEN 'running' THEN 2 WHEN 'started' THEN 3 ELSE 4 END,
       started_at ASC,
       id ASC
     LIMIT ?`,
  ).all(wuiSessionId, limit) as Record<string, unknown>[]
  return rows.map(mapRunRow)
}

export function getSyncedMessageLocalId(hermesSessionId: string, hermesMessageId: number | string): string | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT local_message_id FROM ${CHAT_SYNCED_MESSAGES_TABLE}
     WHERE hermes_session_id = ? AND hermes_message_id = ?
     LIMIT 1`,
  ).get(hermesSessionId, String(hermesMessageId)) as { local_message_id?: string } | undefined
  return row?.local_message_id || null
}

export function recordSyncedMessage(input: {
  wuiSessionId: string
  hermesSessionId: string
  hermesMessageId: number | string
  localMessageId: number | string
  role: string
  syncedAt?: number
}): void {
  if (!isSqliteAvailable()) return
  const db = getDb()
  if (!db) return
  db.prepare(
    `INSERT INTO ${CHAT_SYNCED_MESSAGES_TABLE}
       (wui_session_id, hermes_session_id, hermes_message_id, local_message_id, role, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hermes_session_id, hermes_message_id) DO UPDATE SET
       local_message_id = excluded.local_message_id,
       role = excluded.role,
       synced_at = excluded.synced_at`,
  ).run(
    input.wuiSessionId,
    input.hermesSessionId,
    String(input.hermesMessageId),
    String(input.localMessageId),
    input.role,
    input.syncedAt ?? nowSeconds(),
  )
}
