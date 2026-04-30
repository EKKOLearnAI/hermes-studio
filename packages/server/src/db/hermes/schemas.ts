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

/**
 * Initialize all Hermes SQLite tables with proper schemas.
 * This function creates tables and adds missing columns if schemas change.
 * Call this once at application bootstrap.
 */
export function initAllHermesTables(): void {
  const db = getDb()
  if (!db) return

  // Usage store - with special migration logic
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(USAGE_TABLE)
  const cols = (tableExists
    ? db.prepare(`PRAGMA table_info("${USAGE_TABLE}")`).all() as Array<{ name: string; pk: number }>
    : [])
  const hasId = cols.some(c => c.name === 'id')
  if (!hasId && tableExists) {
    // Migration: if session_id is still PRIMARY KEY (no separate id column), recreate table
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
    for (const [col] of Object.entries(USAGE_SCHEMA)) {
      if (!oldCols.has(col) && col !== 'id') {
        insertValues.push(col)
        selectValues.push(String(defaults[col as keyof typeof defaults] ?? 0))
      }
    }
    db.exec(`ALTER TABLE "${USAGE_TABLE}" RENAME TO "${USAGE_TABLE}_old"`)
    db.exec(`CREATE TABLE "${USAGE_TABLE}" (${Object.entries(USAGE_SCHEMA).map(([col, def]) => `"${col}" ${def}`).join(', ')})`)
    db.exec(`INSERT INTO "${USAGE_TABLE}" (${insertValues.join(', ')}) SELECT ${selectValues.join(', ')} FROM "${USAGE_TABLE}_old"`)
    db.exec(`DROP TABLE "${USAGE_TABLE}_old"`)
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
