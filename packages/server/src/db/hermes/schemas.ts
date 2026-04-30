/**
 * Centralized schema definitions for all Hermes SQLite tables.
 * All table schemas are defined here for unified management and migration.
 */

// ============================================================================
// Usage Store (usage-store.ts)
// ============================================================================

export const USAGE_TABLE = 'session_usage'

export const USAGE_SCHEMA: Record<string, string> = {
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

// ============================================================================
// Session Store (session-store.ts)
// ============================================================================

export const SESSIONS_TABLE = 'sessions'

export const SESSIONS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  profile: 'TEXT NOT NULL DEFAULT \'default\'',
  source: 'TEXT NOT NULL DEFAULT \'api_server\'',
  user_id: 'TEXT',
  model: 'TEXT NOT NULL DEFAULT \'\'',
  title: 'TEXT',
  started_at: 'INTEGER NOT NULL',
  ended_at: 'INTEGER',
  end_reason: 'TEXT',
  message_count: 'INTEGER NOT NULL DEFAULT 0',
  tool_call_count: 'INTEGER NOT NULL DEFAULT 0',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  billing_provider: 'TEXT',
  estimated_cost_usd: 'REAL NOT NULL DEFAULT 0',
  actual_cost_usd: 'REAL',
  cost_status: 'TEXT NOT NULL DEFAULT \'\'',
  preview: 'TEXT NOT NULL DEFAULT \'\'',
  last_active: 'INTEGER NOT NULL',
  workspace: 'TEXT',
}

export const MESSAGES_TABLE = 'messages'

export const MESSAGES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  role: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL DEFAULT \'\'',
  tool_call_id: 'TEXT',
  tool_calls: 'TEXT',
  tool_name: 'TEXT',
  timestamp: 'INTEGER NOT NULL',
  token_count: 'INTEGER',
  finish_reason: 'TEXT',
  reasoning: 'TEXT',
  reasoning_details: 'TEXT',
  reasoning_content: 'TEXT',
  codex_reasoning_items: 'TEXT',
}

export const MESSAGES_INDEX = 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)'

// ============================================================================
// Compression Snapshot (compression-snapshot.ts)
// ============================================================================

export const COMPRESSION_SNAPSHOT_TABLE = 'chat_compression_snapshots'

export const COMPRESSION_SNAPSHOT_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  last_message_index: 'INTEGER NOT NULL DEFAULT 0',
  message_count_at_time: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Group Chat (services/hermes/group-chat/index.ts)
// ============================================================================

export const GC_ROOMS_TABLE = 'gc_rooms'

export const GC_ROOMS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  name: 'TEXT NOT NULL',
  inviteCode: 'TEXT UNIQUE',
  triggerTokens: 'INTEGER NOT NULL DEFAULT 100000',
  maxHistoryTokens: 'INTEGER NOT NULL DEFAULT 32000',
  tailMessageCount: 'INTEGER NOT NULL DEFAULT 20',
  totalTokens: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_MESSAGES_TABLE = 'gc_messages'

export const GC_MESSAGES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  senderId: 'TEXT NOT NULL',
  senderName: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL',
  timestamp: 'INTEGER NOT NULL',
}

export const GC_ROOM_AGENTS_TABLE = 'gc_room_agents'

export const GC_ROOM_AGENTS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  agentId: 'TEXT NOT NULL',
  profile: 'TEXT NOT NULL',
  name: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  invited: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_CONTEXT_SNAPSHOTS_TABLE = 'gc_context_snapshots'

export const GC_CONTEXT_SNAPSHOTS_SCHEMA: Record<string, string> = {
  roomId: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  lastMessageId: 'TEXT NOT NULL',
  lastMessageTimestamp: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_ROOM_MEMBERS_TABLE = 'gc_room_members'

export const GC_ROOM_MEMBERS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  userId: 'TEXT NOT NULL',
  userName: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  joinedAt: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_PENDING_SESSION_DELETES_TABLE = 'gc_pending_session_deletes'

export const GC_PENDING_SESSION_DELETES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  profile_name: 'TEXT NOT NULL',
  status: "TEXT NOT NULL DEFAULT 'pending'",
  attempt_count: 'INTEGER NOT NULL DEFAULT 0',
  last_error: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  next_attempt_at: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_SESSION_PROFILES_TABLE = 'gc_session_profiles'

export const GC_SESSION_PROFILES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  room_id: 'TEXT NOT NULL',
  agent_id: 'TEXT NOT NULL',
  profile_name: 'TEXT NOT NULL',
  created_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Unified Initializer
// ============================================================================

import { ensureTable, getDb } from '../index'

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function sqlLiteral(value: string | number): string {
  if (typeof value === 'number') return String(value)
  return `'${value.replace(/'/g, "''")}'`
}

function usageSchemaDefinitionSql(): string {
  return Object.entries(USAGE_SCHEMA)
    .map(([col, def]) => `${quoteIdentifier(col)} ${def}`)
    .join(', ')
}

function sqliteTableExists(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): boolean {
  return Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName))
}

function sqliteTableColumns(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
  return new Set(rows.map(row => row.name))
}

function legacyUsageValueSql(
  sourceAlias: string,
  oldCols: Set<string>,
  col: string,
  defaults: Record<string, string | number>,
): string {
  const sourceColumn = (sourceCol: string) => `${quoteIdentifier(sourceAlias)}.${quoteIdentifier(sourceCol)}`

  if (col === 'created_at' && oldCols.has('updated_at')) {
    return `COALESCE(${sourceColumn('updated_at')}, ${sqlLiteral(defaults.created_at)})`
  }

  if (oldCols.has(col)) {
    return `COALESCE(${sourceColumn(col)}, ${sqlLiteral(defaults[col] ?? 0)})`
  }

  return sqlLiteral(defaults[col] ?? 0)
}

function insertUsageRowsFromLegacyTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  oldTableName: string,
  oldCols: Set<string>,
  skipExistingSessionIds = false,
): void {
  const defaults: Record<string, string | number> = {
    session_id: '',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    created_at: Date.now(),
    model: '',
    profile: 'default',
  }
  const sourceAlias = 'old_usage'
  const sourceColumn = (col: string) => `${quoteIdentifier(sourceAlias)}.${quoteIdentifier(col)}`
  const insertValues: string[] = []
  const selectValues: string[] = []

  for (const col of Object.keys(USAGE_SCHEMA)) {
    if (col === 'id') continue

    insertValues.push(quoteIdentifier(col))
    selectValues.push(legacyUsageValueSql(sourceAlias, oldCols, col, defaults))
  }

  const skipExistingWhere = skipExistingSessionIds && oldCols.has('session_id')
    ? ` WHERE NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(USAGE_TABLE)} WHERE ${quoteIdentifier(USAGE_TABLE)}.${quoteIdentifier('session_id')} = ${sourceColumn('session_id')})`
    : ''

  db.exec(
    `INSERT INTO ${quoteIdentifier(USAGE_TABLE)} (${insertValues.join(', ')}) ` +
    `SELECT ${selectValues.join(', ')} FROM ${quoteIdentifier(oldTableName)} AS ${quoteIdentifier(sourceAlias)}` +
    skipExistingWhere,
  )
}

function recoverInterruptedUsageMigration(db: NonNullable<ReturnType<typeof getDb>>): void {
  const oldUsageTable = `${USAGE_TABLE}_old`
  if (!sqliteTableExists(db, oldUsageTable)) return

  const oldCols = sqliteTableColumns(db, oldUsageTable)
  db.exec('BEGIN')
  try {
    insertUsageRowsFromLegacyTable(db, oldUsageTable, oldCols, true)
    db.exec(`DROP TABLE ${quoteIdentifier(oldUsageTable)}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Initialize all Hermes SQLite tables with proper schemas.
 * This function creates tables and adds missing columns if schemas change.
 * Call this once at application bootstrap.
 */
export function initAllHermesTables(): void {
  const db = getDb()
  if (!db) return

  // Usage store - with special migration logic
  const tableExists = sqliteTableExists(db, USAGE_TABLE)
  const cols = tableExists
    ? db.prepare(`PRAGMA table_info(${quoteIdentifier(USAGE_TABLE)})`).all() as Array<{ name: string; pk: number }>
    : []
  const hasId = cols.some(c => c.name === 'id')
  if (!hasId && tableExists) {
    // Migration: if session_id is still PRIMARY KEY (no separate id column), recreate table
    const oldCols = new Set(cols.map(c => c.name))
    const oldUsageTable = `${USAGE_TABLE}_old`

    db.exec('BEGIN')
    try {
      db.exec(`ALTER TABLE ${quoteIdentifier(USAGE_TABLE)} RENAME TO ${quoteIdentifier(oldUsageTable)}`)
      db.exec(`CREATE TABLE ${quoteIdentifier(USAGE_TABLE)} (${usageSchemaDefinitionSql()})`)
      insertUsageRowsFromLegacyTable(db, oldUsageTable, oldCols)
      db.exec(`DROP TABLE ${quoteIdentifier(oldUsageTable)}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } else if (hasId) {
    recoverInterruptedUsageMigration(db)
  }
  ensureTable(USAGE_TABLE, USAGE_SCHEMA)

  // Session store
  ensureTable(SESSIONS_TABLE, SESSIONS_SCHEMA)
  ensureTable(MESSAGES_TABLE, MESSAGES_SCHEMA)
  db.exec(MESSAGES_INDEX)

  // Compression snapshot
  ensureTable(COMPRESSION_SNAPSHOT_TABLE, COMPRESSION_SNAPSHOT_SCHEMA)

  // Group chat - basic tables
  ensureTable(GC_ROOMS_TABLE, GC_ROOMS_SCHEMA)
  ensureTable(GC_MESSAGES_TABLE, GC_MESSAGES_SCHEMA)
  ensureTable(GC_CONTEXT_SNAPSHOTS_TABLE, GC_CONTEXT_SNAPSHOTS_SCHEMA)
  ensureTable(GC_PENDING_SESSION_DELETES_TABLE, GC_PENDING_SESSION_DELETES_SCHEMA)
  ensureTable(GC_SESSION_PROFILES_TABLE, GC_SESSION_PROFILES_SCHEMA)

  // Group chat - composite primary key tables
  // Create without PK first, then add PK constraint
  ensureTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA)
  ensureTable(GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA)

  // Add composite primary keys (SQLite doesn't support ADD PK, so we recreate if needed)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${GC_ROOM_AGENTS_TABLE}_new (${Object.entries(GC_ROOM_AGENTS_SCHEMA).map(([k, v]) => `"${k}" ${v}`).join(', ')}, PRIMARY KEY (room_id, agent_id))`)
    db.exec(`INSERT OR IGNORE INTO ${GC_ROOM_AGENTS_TABLE}_new SELECT * FROM ${GC_ROOM_AGENTS_TABLE}`)
    db.exec(`DROP TABLE IF EXISTS ${GC_ROOM_AGENTS_TABLE}`)
    db.exec(`ALTER TABLE ${GC_ROOM_AGENTS_TABLE}_new RENAME TO ${GC_ROOM_AGENTS_TABLE}`)
  } catch {
    // Table already has correct schema or migration failed
  }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${GC_ROOM_MEMBERS_TABLE}_new (${Object.entries(GC_ROOM_MEMBERS_SCHEMA).map(([k, v]) => `"${k}" ${v}`).join(', ')}, PRIMARY KEY (room_id, user_id))`)
    db.exec(`INSERT OR IGNORE INTO ${GC_ROOM_MEMBERS_TABLE}_new SELECT * FROM ${GC_ROOM_MEMBERS_TABLE}`)
    db.exec(`DROP TABLE IF EXISTS ${GC_ROOM_MEMBERS_TABLE}`)
    db.exec(`ALTER TABLE ${GC_ROOM_MEMBERS_TABLE}_new RENAME TO ${GC_ROOM_MEMBERS_TABLE}`)
  } catch {
    // Table already has correct schema or migration failed
  }
}
