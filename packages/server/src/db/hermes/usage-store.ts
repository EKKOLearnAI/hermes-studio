import { isSqliteAvailable, ensureTable, getDb, jsonSet, jsonGet, jsonGetAll, jsonDelete } from '../index'

const TABLE = 'session_usage'

export interface UsageRecord {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  model: string
  profile: string
  created_at: number
}

const SCHEMA = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  model: "TEXT NOT NULL DEFAULT ''",
  profile: "TEXT NOT NULL DEFAULT 'default'",
  created_at: 'INTEGER NOT NULL',
}

export function initUsageStore(): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!

  // Migration: if session_id is still PRIMARY KEY (no separate id column), recreate table
  // Must run BEFORE ensureTable, because ensureTable can't ALTER TABLE ADD a PRIMARY KEY column
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(TABLE)
  const cols = (tableExists
    ? db.prepare(`PRAGMA table_info("${TABLE}")`).all() as Array<{ name: string; pk: number }>
    : [])
  const hasId = cols.some(c => c.name === 'id')
  if (!hasId && tableExists) {
    const oldCols = new Set(cols.map(c => c.name))
    const insertCols = ['session_id', 'input_tokens', 'output_tokens']
    const selectCols = [...insertCols]
    if (oldCols.has('cache_read_tokens')) { insertCols.push('cache_read_tokens'); selectCols.push('cache_read_tokens') }
    if (oldCols.has('cache_write_tokens')) { insertCols.push('cache_write_tokens'); selectCols.push('cache_write_tokens') }
    if (oldCols.has('reasoning_tokens')) { insertCols.push('reasoning_tokens'); selectCols.push('reasoning_tokens') }
    if (oldCols.has('created_at')) { insertCols.push('created_at'); selectCols.push('created_at') }
    if (oldCols.has('model')) { insertCols.push('model'); selectCols.push('model') }
    const defaults = {
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      created_at: Date.now(), model: '', profile: 'default',
    }
    const insertValues = insertCols.map(c => c)
    const selectValues = selectCols.map(c => c)
    // Columns in new schema but not in old table — use defaults
    for (const [col, def] of Object.entries(SCHEMA)) {
      if (!oldCols.has(col) && col !== 'id') {
        insertValues.push(col)
        selectValues.push(String(defaults[col as keyof typeof defaults] ?? 0))
      }
    }
    db.exec(`ALTER TABLE "${TABLE}" RENAME TO "${TABLE}_old"`)
    db.exec(`CREATE TABLE "${TABLE}" (${Object.entries(SCHEMA).map(([col, def]) => `"${col}" ${def}`).join(', ')})`)
    db.exec(`INSERT INTO "${TABLE}" (${insertValues.join(', ')}) SELECT ${selectValues.join(', ')} FROM "${TABLE}_old"`)
    db.exec(`DROP TABLE "${TABLE}_old"`)
  }

  ensureTable(TABLE, SCHEMA)
}

export function updateUsage(
  sessionId: string,
  data: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    model?: string
    profile?: string
  },
): void {
  const cacheReadTokens = data.cacheReadTokens ?? 0
  const cacheWriteTokens = data.cacheWriteTokens ?? 0
  const reasoningTokens = data.reasoningTokens ?? 0
  const now = Date.now()
  const model = data.model || ''
  const profile = data.profile || 'default'
  if (isSqliteAvailable()) {
    const db = getDb()!
    db.prepare(
      `INSERT INTO ${TABLE} (session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, model, profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, data.inputTokens, data.outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, model, profile, now)
  } else {
    jsonSet(TABLE, sessionId, {
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      reasoning_tokens: reasoningTokens,
      model,
      profile,
      created_at: now,
    })
  }
}

export function getUsage(sessionId: string): UsageRecord | undefined {
  if (isSqliteAvailable()) {
    return getDb()!.prepare(
      `SELECT session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, model, profile, created_at FROM ${TABLE} WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(sessionId) as UsageRecord | undefined
  }
  const row = jsonGet(TABLE, sessionId)
  if (!row) return undefined
  return {
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    cache_read_tokens: row.cache_read_tokens ?? 0,
    cache_write_tokens: row.cache_write_tokens ?? 0,
    reasoning_tokens: row.reasoning_tokens ?? 0,
    model: row.model ?? '',
    profile: row.profile ?? 'default',
    created_at: row.created_at ?? 0,
  }
}

export function getUsageBatch(sessionIds: string[]): Record<string, UsageRecord> {
  if (sessionIds.length === 0) return {}
  if (isSqliteAvailable()) {
    const db = getDb()!
    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, model, profile, created_at
       FROM ${TABLE}
       WHERE id IN (SELECT MAX(id) FROM ${TABLE} WHERE session_id IN (${placeholders}) GROUP BY session_id)`,
    ).all(...sessionIds) as unknown as Array<UsageRecord & { session_id: string }>
    const map: Record<string, UsageRecord> = {}
    for (const r of rows) {
      map[r.session_id] = {
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        reasoning_tokens: r.reasoning_tokens,
        model: r.model,
        profile: r.profile,
        created_at: r.created_at,
      }
    }
    return map
  }
  const all = jsonGetAll(TABLE)
  const map: Record<string, UsageRecord> = {}
  for (const id of sessionIds) {
    const row = all[id]
    if (row) {
      map[id] = {
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        cache_read_tokens: row.cache_read_tokens ?? 0,
        cache_write_tokens: row.cache_write_tokens ?? 0,
        reasoning_tokens: row.reasoning_tokens ?? 0,
        model: row.model ?? '',
        profile: row.profile ?? 'default',
        created_at: row.created_at ?? 0,
      }
    }
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

// --- Aggregation for stats endpoint ---

export interface UsageStatsModelRow {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
}

export interface UsageStatsDailyRow {
  date: string
  tokens: number
  cache: number
  sessions: number
  cost: number
}

export interface LocalUsageStats {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
  by_model: UsageStatsModelRow[]
  by_day: UsageStatsDailyRow[]
}

export function getLocalUsageStats(profile?: string): LocalUsageStats {
  const empty: LocalUsageStats = {
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, reasoning_tokens: 0, sessions: 0,
    by_model: [], by_day: [],
  }
  if (!isSqliteAvailable()) return empty

  const db = getDb()!
  const profileFilter = profile ? `WHERE profile = ?` : ''

  const totals = db.prepare(`
    SELECT COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
      COALESCE(SUM(reasoning_tokens),0) as reasoning_tokens,
      COUNT(DISTINCT session_id) as sessions
    FROM ${TABLE}
    ${profileFilter}
  `).get(...(profile ? [profile] : [])) as any

  const byModel = db.prepare(`
    SELECT model,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_read_tokens) as cache_read_tokens,
      SUM(cache_write_tokens) as cache_write_tokens,
      SUM(reasoning_tokens) as reasoning_tokens,
      COUNT(DISTINCT session_id) as sessions
    FROM ${TABLE}
    ${profileFilter}
    GROUP BY model
    ORDER BY sessions DESC
  `).all(...(profile ? [profile] : [])) as unknown as UsageStatsModelRow[]

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  const byDayStmt = profile
    ? `SELECT DATE(created_at / 1000, 'unixepoch') as date,
      SUM(input_tokens + output_tokens) as tokens,
      SUM(cache_read_tokens) as cache,
      COUNT(DISTINCT session_id) as sessions
      FROM ${TABLE}
      WHERE profile = ? AND created_at > ?
      GROUP BY date
      ORDER BY date`
    : `SELECT DATE(created_at / 1000, 'unixepoch') as date,
      SUM(input_tokens + output_tokens) as tokens,
      SUM(cache_read_tokens) as cache,
      COUNT(DISTINCT session_id) as sessions
      FROM ${TABLE}
      WHERE created_at > ?
      GROUP BY date
      ORDER BY date`
  const byDay = db.prepare(byDayStmt).all(...(profile ? [profile, thirtyDaysAgo] : [thirtyDaysAgo])) as Array<{ date: string; tokens: number; cache: number; sessions: number }>

  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_read_tokens: totals.cache_read_tokens,
    cache_write_tokens: totals.cache_write_tokens,
    reasoning_tokens: totals.reasoning_tokens,
    sessions: totals.sessions,
    by_model: byModel,
    by_day: byDay.map(d => ({ ...d, cost: 0 })),
  }
}
