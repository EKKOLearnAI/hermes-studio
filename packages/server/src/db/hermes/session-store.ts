/**
 * Self-built session database — completely replaces Hermes CLI dependency.
 * Uses the same ensureTable/getDb pattern as usage-store.ts.
 */
import { isSqliteAvailable, getDb } from '../index'
import {
  COMPRESSION_SNAPSHOT_TABLE,
  GC_PENDING_SESSION_DELETES_TABLE,
  GC_SESSION_PROFILES_TABLE,
  MESSAGES_TABLE,
  SESSION_ID_ALIASES_TABLE,
  SESSIONS_TABLE,
  USAGE_TABLE,
} from './schemas'

// Re-export types for compatibility with sessions-db.ts consumers
export interface HermesSessionRow {
  id: string
  profile: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  preview: string
  last_active: number
  workspace: string | null
}

export interface HermesMessageRow {
  id: number | string
  session_id: string
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  reasoning_details?: string | null
  codex_reasoning_items?: string | null
  reasoning_content?: string | null
}

export interface HermesSessionSearchRow extends HermesSessionRow {
  snippet: string
  matched_message_id: number | null
}

export interface HermesSessionDetailRow extends HermesSessionRow {
  messages: HermesMessageRow[]
  thread_session_count: number
}

export interface SessionIdAliasRow {
  alias_id: string
  profile: string
  session_id: string
  reason: string
  created_at: number
}

// Note: Table schemas and initialization are now centralized in schemas.ts
// Tables are created automatically on bootstrap via initAllHermesTables()

// --- Helpers ---

function parseToolCalls(value: unknown): any[] | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mapSessionRow(row: Record<string, unknown>): HermesSessionRow {
  const rawTitle = row.title != null ? String(row.title) : null
  const preview = String(row.preview || '')
  const title = rawTitle || (preview ? (preview.length > 40 ? preview.slice(0, 40) + '...' : preview) : null)
  return {
    id: String(row.id || ''),
    profile: String(row.profile || 'default'),
    source: String(row.source || 'api_server'),
    user_id: row.user_id != null ? String(row.user_id) : null,
    model: String(row.model || ''),
    title,
    started_at: Number(row.started_at || 0),
    ended_at: row.ended_at != null ? Number(row.ended_at) : null,
    end_reason: row.end_reason != null ? String(row.end_reason) : null,
    message_count: Number(row.message_count || 0),
    tool_call_count: Number(row.tool_call_count || 0),
    input_tokens: Number(row.input_tokens || 0),
    output_tokens: Number(row.output_tokens || 0),
    cache_read_tokens: Number(row.cache_read_tokens || 0),
    cache_write_tokens: Number(row.cache_write_tokens || 0),
    reasoning_tokens: Number(row.reasoning_tokens || 0),
    billing_provider: row.billing_provider != null ? String(row.billing_provider) : null,
    estimated_cost_usd: Number(row.estimated_cost_usd || 0),
    actual_cost_usd: row.actual_cost_usd != null ? Number(row.actual_cost_usd) : null,
    cost_status: String(row.cost_status || ''),
    preview: String(row.preview || ''),
    last_active: Number(row.last_active || 0),
    workspace: row.workspace != null ? String(row.workspace) : null,
  }
}

function mapMessageRow(row: Record<string, unknown>): HermesMessageRow {
  return {
    id: typeof row.id === 'number' ? row.id : Number(row.id),
    session_id: String(row.session_id || ''),
    role: String(row.role || ''),
    content: row.content != null ? String(row.content) : '',
    tool_call_id: row.tool_call_id != null ? String(row.tool_call_id) : null,
    tool_calls: parseToolCalls(row.tool_calls),
    tool_name: row.tool_name != null ? String(row.tool_name) : null,
    timestamp: Number(row.timestamp || 0),
    token_count: row.token_count != null ? Number(row.token_count) : null,
    finish_reason: row.finish_reason != null ? String(row.finish_reason) : null,
    reasoning: row.reasoning != null ? String(row.reasoning) : null,
    reasoning_details: row.reasoning_details != null ? String(row.reasoning_details) : null,
    codex_reasoning_items: row.codex_reasoning_items != null ? String(row.codex_reasoning_items) : null,
    reasoning_content: row.reasoning_content != null ? String(row.reasoning_content) : null,
  }
}

// --- Session CRUD ---

export function createSession(data: {
  id: string
  profile?: string
  model?: string
  title?: string
  workspace?: string
}): HermesSessionRow {
  const now = Math.floor(Date.now() / 1000)
  if (!isSqliteAvailable()) {
    return {
      id: data.id, profile: data.profile || 'default', source: 'api_server',
      user_id: null, model: data.model || '', title: data.title || null,
      started_at: now, ended_at: null, end_reason: null,
      message_count: 0, tool_call_count: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null,
      cost_status: '', preview: '', last_active: now, workspace: data.workspace || null,
    }
  }
  const db = getDb()!
  db.prepare(
    `INSERT INTO ${SESSIONS_TABLE} (id, profile, source, model, title, started_at, last_active, workspace)
     VALUES (?, ?, 'api_server', ?, ?, ?, ?, ?)`,
  ).run(data.id, data.profile || 'default', data.model || '', data.title || null, now, now, data.workspace || null)
  return getSession(data.id)!
}

export function getSession(id: string, profile?: string): HermesSessionRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = profile
    ? db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ? AND profile = ?`).get(id, profile) as Record<string, unknown> | undefined
    : db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? mapSessionRow(row) : null
}

export function resolveSessionId(id: string, profile?: string): string {
  if (!isSqliteAvailable()) return id
  const db = getDb()!
  const alias = profile
    ? db.prepare(
      `SELECT a.session_id
       FROM ${SESSION_ID_ALIASES_TABLE} a
       INNER JOIN ${SESSIONS_TABLE} s ON s.id = a.session_id AND s.profile = a.profile
       WHERE a.alias_id = ? AND a.profile = ?`,
    ).get(id, profile) as { session_id: string } | undefined
    : db.prepare(
      `SELECT a.session_id
       FROM ${SESSION_ID_ALIASES_TABLE} a
       INNER JOIN ${SESSIONS_TABLE} s ON s.id = a.session_id AND s.profile = a.profile
       WHERE a.alias_id = ?
       ORDER BY a.created_at DESC LIMIT 1`,
    ).get(id) as { session_id: string } | undefined
  if (alias?.session_id) return alias.session_id

  const session = profile
    ? db.prepare(`SELECT id FROM ${SESSIONS_TABLE} WHERE id = ? AND profile = ?`).get(id, profile) as { id: string } | undefined
    : db.prepare(`SELECT id FROM ${SESSIONS_TABLE} WHERE id = ?`).get(id) as { id: string } | undefined
  return session?.id || id
}

function upsertSessionAlias(
  db: NonNullable<ReturnType<typeof getDb>>,
  aliasId: string,
  sessionId: string,
  profile: string,
  reason: string,
): boolean {
  if (!aliasId || !sessionId || aliasId === sessionId) return false
  db.prepare(
    `INSERT INTO ${SESSION_ID_ALIASES_TABLE} (alias_id, profile, session_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(alias_id, profile) DO UPDATE SET
       session_id = excluded.session_id,
       reason = excluded.reason,
       created_at = excluded.created_at`,
  ).run(aliasId, profile, sessionId, reason, Math.floor(Date.now() / 1000))
  return true
}

export function createSessionAlias(aliasId: string, sessionId: string, profile = 'default', reason = ''): boolean {
  if (!isSqliteAvailable()) return false
  return upsertSessionAlias(getDb()!, aliasId, sessionId, profile, reason)
}

export function listSessionIdAliases(profile: string): Record<string, string> {
  if (!isSqliteAvailable()) return {}
  const db = getDb()!
  const rows = db.prepare(
    `SELECT a.alias_id, a.session_id
     FROM ${SESSION_ID_ALIASES_TABLE} a
     INNER JOIN ${SESSIONS_TABLE} s ON s.id = a.session_id AND s.profile = a.profile
     WHERE a.profile = ?`,
  ).all(profile) as Array<{ alias_id: string; session_id: string }>
  const aliases: Record<string, string> = {}
  for (const row of rows) {
    if (row.alias_id && row.session_id && row.alias_id !== row.session_id) {
      aliases[row.alias_id] = row.session_id
    }
  }
  return aliases
}

type MessageFingerprintInput = Array<{ role?: string | null; content?: string | null; timestamp?: number | null }>

function normalizeMessageForFingerprint(message?: { role?: string | null; content?: string | null; timestamp?: number | null }): string {
  if (!message) return ''
  return JSON.stringify({
    role: message.role || '',
    content: message.content || '',
    timestamp: Number(message.timestamp || 0),
  })
}

function localMessageFingerprint(db: NonNullable<ReturnType<typeof getDb>>, sessionId: string): string {
  const first = db.prepare(
    `SELECT role, content, timestamp FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT 1`,
  ).get(sessionId) as { role: string | null; content: string | null; timestamp: number | null } | undefined
  const last = db.prepare(
    `SELECT role, content, timestamp FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1`,
  ).get(sessionId) as { role: string | null; content: string | null; timestamp: number | null } | undefined
  return `${normalizeMessageForFingerprint(first)}|${normalizeMessageForFingerprint(last)}`
}

function sourceMessageFingerprint(messages?: MessageFingerprintInput): string | null {
  if (!messages || messages.length === 0) return null
  return `${normalizeMessageForFingerprint(messages[0])}|${normalizeMessageForFingerprint(messages[messages.length - 1])}`
}

export function findHermesImportedSessionCandidate(
  profile: string,
  hermesSession: { id: string; source?: string; title?: string | null; started_at?: number | null },
  messageCount: number,
  messages?: MessageFingerprintInput,
): { id: string } | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const title = hermesSession.title || ''
  const startedAt = Number(hermesSession.started_at || 0)
  const rows = db.prepare(
    `SELECT s.id, COUNT(m.id) AS actual_message_count
     FROM ${SESSIONS_TABLE} s
     LEFT JOIN ${MESSAGES_TABLE} m ON m.session_id = s.id
     WHERE s.profile = ?
       AND s.source = ?
       AND s.id <> ?
       AND COALESCE(s.title, '') = ?
       AND ABS(s.started_at - ?) <= 1
     GROUP BY s.id
     HAVING actual_message_count = ?
     LIMIT 2`,
  ).all(profile, hermesSession.source || 'api_server', hermesSession.id, title, startedAt, messageCount) as Array<{ id: string }>
  if (rows.length !== 1) return null

  const sourceFingerprint = sourceMessageFingerprint(messages)
  if (sourceFingerprint && localMessageFingerprint(db, rows[0]!.id) !== sourceFingerprint) {
    return null
  }

  return { id: rows[0]!.id }
}

export function rekeySession(oldId: string, newId: string, profile = 'default', reason = 'session-rekey'): boolean {
  if (!isSqliteAvailable() || oldId === newId) return false
  const db = getDb()!
  db.exec('BEGIN')
  try {
    const source = db.prepare(`SELECT id FROM ${SESSIONS_TABLE} WHERE id = ? AND profile = ?`).get(oldId, profile) as { id: string } | undefined
    if (!source) {
      db.exec('ROLLBACK')
      return false
    }
    const target = db.prepare(`SELECT id FROM ${SESSIONS_TABLE} WHERE id = ? AND profile = ?`).get(newId, profile) as { id: string } | undefined
    if (target) {
      upsertSessionAlias(db, oldId, newId, profile, reason)
      db.exec('COMMIT')
      return false
    }

    db.prepare(`UPDATE ${SESSIONS_TABLE} SET id = ? WHERE id = ? AND profile = ?`).run(newId, oldId, profile)
    db.prepare(`UPDATE ${MESSAGES_TABLE} SET session_id = ? WHERE session_id = ?`).run(newId, oldId)
    for (const table of [COMPRESSION_SNAPSHOT_TABLE, GC_PENDING_SESSION_DELETES_TABLE, GC_SESSION_PROFILES_TABLE]) {
      try {
        db.prepare(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`).run(newId, oldId)
      } catch {
        // Optional tables may not exist in older or partially initialized databases.
      }
    }
    try {
      db.prepare(`UPDATE ${USAGE_TABLE} SET session_id = ? WHERE session_id = ? AND profile = ?`).run(newId, oldId, profile)
    } catch {
      // Usage table may not exist in older or partially initialized databases.
    }
    upsertSessionAlias(db, oldId, newId, profile, reason)
    db.exec('COMMIT')
    return true
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

export function updateSession(id: string, data: Partial<Omit<HermesSessionRow, 'id' | 'profile'>>): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!
  const fields: string[] = []
  const values: any[] = []
  for (const [key, val] of Object.entries(data)) {
    if (key === 'id' || key === 'profile') continue
    // Skip last_active and ended_at - handle them separately below
    if (key === 'last_active' || key === 'ended_at') continue
    fields.push(`"${key}" = ?`)
    values.push(val)
  }

  // Handle ended_at - only update if provided, otherwise keep existing value
  if (data.ended_at !== undefined) {
    fields.push(`"ended_at" = ?`)
    values.push(data.ended_at)
  }

  // Handle last_active - use provided value or current time
  if (data.last_active !== undefined) {
    fields.push(`"last_active" = ?`)
    values.push(data.last_active)
  }

  if (fields.length === 0) return
  db.prepare(`UPDATE ${SESSIONS_TABLE} SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
}

export function deleteSession(id: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  db.prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE session_id = ?`).run(id)
  db.prepare(`DELETE FROM ${SESSION_ID_ALIASES_TABLE} WHERE session_id = ? OR alias_id = ?`).run(id, id)
  const result = db.prepare(`DELETE FROM ${SESSIONS_TABLE} WHERE id = ?`).run(id)
  return result.changes > 0
}

export function renameSession(id: string, title: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`UPDATE ${SESSIONS_TABLE} SET title = ? WHERE id = ?`).run(title, id)
  return result.changes > 0
}

export function listSessions(profile: string, source?: string, limit = 2000): HermesSessionRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()!

  // Use a subquery to generate preview from first user message if not set
  const sql = `
    SELECT
      s.*,
      COALESCE(
        s.preview,
        (
          SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 63)
          FROM ${MESSAGES_TABLE} m
          WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
          ORDER BY m.timestamp, m.id
          LIMIT 1
        ),
        ''
      ) AS preview
    FROM ${SESSIONS_TABLE} s
    WHERE s.profile = ?
      ${source ? 'AND s.source = ?' : ''}
    ORDER BY s.last_active DESC
    LIMIT ?
  `

  const params: any[] = [profile]
  if (source) {
    params.push(source)
  }
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(mapSessionRow)
}

export function searchSessions(profile: string, query: string, limit = 20): HermesSessionSearchRow[] {
  if (!isSqliteAvailable()) return []
  const trimmed = query.trim()
  if (!trimmed) {
    return listSessions(profile, undefined, limit).map(s => ({ ...s, snippet: s.preview || '', matched_message_id: null }))
  }
  const db = getDb()!
  const lowered = trimmed.toLowerCase()
  const pattern = `%${lowered}%`

  // Step 1: Find matching sessions
  const sessionRows = db.prepare(
    `SELECT * FROM ${SESSIONS_TABLE}
     WHERE profile = ? AND (
       LOWER(title) LIKE ? OR LOWER(preview) LIKE ?
       OR id IN (SELECT DISTINCT session_id FROM ${MESSAGES_TABLE} WHERE LOWER(content) LIKE ? OR LOWER(COALESCE(tool_name, '')) LIKE ?)
     )
     ORDER BY last_active DESC LIMIT ?`,
  ).all(profile, pattern, pattern, pattern, pattern, limit) as Record<string, unknown>[]

  if (sessionRows.length === 0) return []

  // Step 2: For each session, find first matching message id + snippet
  const msgQuery = db.prepare(
    `SELECT id, content, tool_name FROM ${MESSAGES_TABLE}
     WHERE session_id = ? AND (LOWER(content) LIKE ? OR LOWER(COALESCE(tool_name, '')) LIKE ?)
     ORDER BY timestamp, id LIMIT 1`,
  )

  return sessionRows.map(row => {
    const session = mapSessionRow(row)
    let snippet = ''
    let matched_message_id: number | null = null

    // Check if session title or preview matches
    const titleLower = (session.title || '').toLowerCase()
    const previewLower = (session.preview || '').toLowerCase()
    const titleIdx = titleLower.indexOf(lowered)
    const previewIdx = previewLower.indexOf(lowered)

    if (titleIdx >= 0) {
      snippet = session.title!.substring(Math.max(0, titleIdx - 20), titleIdx + lowered.length + 60)
    } else if (previewIdx >= 0) {
      snippet = session.preview.substring(Math.max(0, previewIdx - 20), previewIdx + lowered.length + 60)
    } else {
      // Get snippet from matching message
      const msg = msgQuery.get(session.id, pattern, pattern) as { id: number; content: string; tool_name: string | null } | undefined
      if (msg) {
        matched_message_id = msg.id
        const contentLower = msg.content.toLowerCase()
        const idx = contentLower.indexOf(lowered)
        snippet = msg.content.substring(Math.max(0, idx - 20), idx + lowered.length + 60)
      }
    }

    return { ...session, snippet, matched_message_id }
  })
}

export interface PaginatedSessionDetailResult {
  session: HermesSessionRow
  messages: HermesMessageRow[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export function getSessionDetail(id: string, profile?: string): HermesSessionDetailRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const resolvedId = resolveSessionId(id, profile)
  const sessionRow = profile
    ? db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ? AND profile = ?`).get(resolvedId, profile) as Record<string, unknown> | undefined
    : db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ?`).get(resolvedId) as Record<string, unknown> | undefined
  if (!sessionRow) return null
  const msgRows = db.prepare(
    `SELECT * FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY timestamp, id`,
  ).all(resolvedId) as Record<string, unknown>[]
  const session = mapSessionRow(sessionRow)
  return {
    ...session,
    messages: msgRows.map(mapMessageRow),
    thread_session_count: 1,
  }
}

// --- Message CRUD ---

export function addMessage(msg: {
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  codex_reasoning_items?: string | null
}): number | undefined {
  if (!isSqliteAvailable()) return undefined
  const db = getDb()!
  const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
  const result = db.prepare(
    `INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_details, reasoning_content, codex_reasoning_items)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.session_id, msg.role, msg.content,
    msg.tool_call_id ?? null, toolCallsJson, msg.tool_name ?? null,
    msg.timestamp ?? Math.floor(Date.now() / 1000),
    msg.token_count ?? null, msg.finish_reason ?? null,
    msg.reasoning ?? null, msg.reasoning_details ?? null,
    msg.reasoning_content ?? null, msg.codex_reasoning_items ?? null,
  )
  return result.lastInsertRowid as number
}

export function addMessages(msgs: Array<{
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  codex_reasoning_items?: string | null
}>): void {
  if (!isSqliteAvailable() || msgs.length === 0) return
  const db = getDb()!
  const insert = db.prepare(
    `INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_details, reasoning_content, codex_reasoning_items)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.exec('BEGIN')
  try {
    for (const msg of msgs) {
      const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
      insert.run(
        msg.session_id, msg.role, msg.content,
        msg.tool_call_id ?? null, toolCallsJson, msg.tool_name ?? null,
        msg.timestamp ?? Math.floor(Date.now() / 1000),
        msg.token_count ?? null, msg.finish_reason ?? null,
        msg.reasoning ?? null, msg.reasoning_details ?? null,
        msg.reasoning_content ?? null, msg.codex_reasoning_items ?? null,
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function getMessageCount(sessionId: string): number {
  if (!isSqliteAvailable()) return 0
  const db = getDb()!
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM ${MESSAGES_TABLE} WHERE session_id = ?`,
  ).get(sessionId) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

export function updateSessionStats(id: string): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!
  db.prepare(
    `UPDATE ${SESSIONS_TABLE}
     SET message_count = (SELECT COUNT(*) FROM ${MESSAGES_TABLE} WHERE session_id = ?),
         last_active = COALESCE((SELECT MAX(timestamp) FROM ${MESSAGES_TABLE} WHERE session_id = ?), started_at)
     WHERE id = ?`,
  ).run(id, id, id)
  console.log(`Updated session ${id} stats`)
}

export function getSessionDetailPaginated(
  id: string,
  offset = 0,
  limit = 500,
  profile?: string,
): PaginatedSessionDetailResult | null {
  if (!isSqliteAvailable()) {
    return null
  }

  const db = getDb()!
  const resolvedId = resolveSessionId(id, profile)

  // Get session info
  const sessionRow = profile
    ? db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ? AND profile = ?`).get(resolvedId, profile) as Record<string, unknown> | undefined
    : db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ?`).get(resolvedId) as Record<string, unknown> | undefined
  if (!sessionRow) return null

  // Get total message count
  const countResult = db.prepare(
    `SELECT COUNT(*) as total FROM ${MESSAGES_TABLE} WHERE session_id = ?`,
  ).get(resolvedId) as { total: number } | undefined
  const total = countResult?.total || 0

  // Get paginated messages (newest first from DB, then reverse)
  const msgRows = db.prepare(
    `SELECT * FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(resolvedId, limit, offset) as Record<string, unknown>[]

  const session = mapSessionRow(sessionRow)
  const messages = msgRows.map(mapMessageRow).reverse()  // Reverse to show oldest first

  return {
    session,
    messages,
    total,
    offset,
    limit,
    hasMore: offset + messages.length < total,
  }
}

// --- Session store mode ---

import { config } from '../../config'

export function useLocalSessionStore(): boolean {
  return config.sessionStore === 'local'
}
