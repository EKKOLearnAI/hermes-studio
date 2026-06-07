import { isSqliteAvailable, ensureTable, getDb, jsonSet, jsonGet, jsonGetAll, jsonDelete } from '../index'

const TABLE = 'session_usage'

const SCHEMA = {
  session_id: 'TEXT PRIMARY KEY',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  model: 'TEXT NOT NULL DEFAULT \'\'',
  profile: 'TEXT NOT NULL DEFAULT \'default\'',
  created_at: 'INTEGER NOT NULL DEFAULT 0',
}

export function initUsageStore(): void {
  if (isSqliteAvailable()) {
    ensureTable(TABLE, SCHEMA)
  }
}

export function updateUsage(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  extra: {
    cache_read_tokens?: number
    cache_write_tokens?: number
    reasoning_tokens?: number
    model?: string
  } = {},
): void {
  const now = Date.now()
  const record = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    updated_at: now,
    cache_read_tokens: extra.cache_read_tokens ?? 0,
    cache_write_tokens: extra.cache_write_tokens ?? 0,
    reasoning_tokens: extra.reasoning_tokens ?? 0,
    model: extra.model ?? '',
  }
  if (isSqliteAvailable()) {
    const db = getDb()!
    db.prepare(
      `INSERT INTO ${TABLE} (session_id, input_tokens, output_tokens, updated_at, cache_read_tokens, cache_write_tokens, reasoning_tokens, model, profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'default', 0)
       ON CONFLICT(session_id) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         updated_at = excluded.updated_at,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         reasoning_tokens = excluded.reasoning_tokens,
         model = excluded.model`,
    ).run(
      sessionId,
      record.input_tokens,
      record.output_tokens,
      record.updated_at,
      record.cache_read_tokens,
      record.cache_write_tokens,
      record.reasoning_tokens,
      record.model,
    )
  } else {
    jsonSet(TABLE, sessionId, record)
  }
}

export function getUsage(sessionId: string): { input_tokens: number; output_tokens: number } | undefined {
  if (isSqliteAvailable()) {
    return getDb()!.prepare(
      `SELECT input_tokens, output_tokens FROM ${TABLE} WHERE session_id = ?`,
    ).get(sessionId) as { input_tokens: number; output_tokens: number } | undefined
  }
  const row = jsonGet(TABLE, sessionId)
  if (!row) return undefined
  return { input_tokens: row.input_tokens ?? 0, output_tokens: row.output_tokens ?? 0 }
}

export function getUsageBatch(
  sessionIds: string[],
): Record<string, { input_tokens: number; output_tokens: number }> {
  if (sessionIds.length === 0) return {}
  if (isSqliteAvailable()) {
    const db = getDb()!
    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT session_id, input_tokens, output_tokens FROM ${TABLE} WHERE session_id IN (${placeholders})`,
    ).all(...sessionIds) as Array<{ session_id: string; input_tokens: number; output_tokens: number }>
    const map: Record<string, { input_tokens: number; output_tokens: number }> = {}
    for (const r of rows) map[r.session_id] = { input_tokens: r.input_tokens, output_tokens: r.output_tokens }
    return map
  }
  const all = jsonGetAll(TABLE)
  const map: Record<string, { input_tokens: number; output_tokens: number }> = {}
  for (const id of sessionIds) {
    const row = all[id]
    if (row) map[id] = { input_tokens: row.input_tokens ?? 0, output_tokens: row.output_tokens ?? 0 }
  }
  return map
}

export function deleteUsage(sessionId: string): void {
  if (isSqliteAvailable()) {
    getDb()!.prepare(`DELETE FROM ${TABLE} WHERE session_id = ?`).run(sessionId)
  } else {
    jsonDelete(TABLE, sessionId)
  }
}
