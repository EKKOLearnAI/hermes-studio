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
// Model Context (model-context.ts)
// ============================================================================

export const MODEL_CONTEXT_TABLE = 'model_context'

export const MODEL_CONTEXT_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  provider: 'TEXT NOT NULL',
  model: 'TEXT NOT NULL',
  context_limit: 'INTEGER NOT NULL',
}

export const MODEL_CONTEXT_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_model_context_provider_model ON model_context(provider, model)'

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
// Schema Sync Utilities
// ============================================================================

import { getDb, getStoragePath } from '../index'

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * 检查表是否存在
 */
function tableExists(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName)
  return !!result
}

/**
 * 获取表的实际结构（包括主键）
 */
function getTableStructure(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): {
  columns: Map<string, string>
  primaryKey: string | null
} {
  // 获取列信息
  const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string; type: string; pk: number }>
  const columnMap = new Map<string, string>()

  for (const col of columns) {
    columnMap.set(col.name, col.type)
  }

  // 获取主键信息
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName) as { sql: string } | undefined

  // 从 CREATE TABLE 语句中提取主键定义
  const sql = tableInfo?.sql || ''
  const pkMatch = sql.match(/PRIMARY KEY\s*\(([^)]+)\)/i)
  const primaryKey = pkMatch ? pkMatch[1].replace(/\s+/g, '') : null

  return { columns: columnMap, primaryKey }
}

/**
 * 提取列类型（从 schema 定义中）
 */
function extractType(schemaDef: string): string {
  const types = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC']
  for (const type of types) {
    if (schemaDef.toUpperCase().includes(type)) {
      return type
    }
  }
  return 'TEXT'
}

/**
 * 检查表结构是否完全匹配 schema（包括主键和列类型）
 */
function structureMatches(
  actual: { columns: Map<string, string>; primaryKey: string | null },
  schema: Record<string, string>,
  expectedPrimaryKey?: string
): boolean {
  // 1. 检查主键
  if (expectedPrimaryKey) {
    const expectedPKClean = expectedPrimaryKey.replace(/\s+/g, '')
    if (actual.primaryKey !== expectedPKClean) {
      return false  // 主键不匹配
    }
  } else {
    if (actual.primaryKey) {
      return false  // 期望没有主键，但实际有
    }
  }

  // 2. 检查列数量
  const columnMap = actual.columns as Map<string, string>
  if (columnMap.size !== Object.keys(schema).length) {
    return false
  }

  // 3. 检查列名和类型
  for (const [colName, colDef] of Object.entries(schema)) {
    if (!columnMap.has(colName)) {
      return false  // 列不存在
    }

    const actualType = columnMap.get(colName)!
    const expectedType = extractType(colDef)

    if (actualType !== expectedType) {
      return false  // 类型不匹配
    }
  }

  return true
}

/**
 * 创建表（带完整 schema）
 */
function createTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
  primaryKey?: string
): void {
  const colDefs = Object.entries(schema).map(([col, def]) => `${quoteIdentifier(col)} ${def}`)

  // 只在 schema 中没有主键时才添加复合主键
  const hasPrimaryKeyInSchema = Object.values(schema).some((def) =>
    def.toUpperCase().includes("PRIMARY KEY")
  )

  if (primaryKey && !hasPrimaryKeyInSchema) {
    colDefs.push(`PRIMARY KEY (${primaryKey})`)
  }

  db.exec(`CREATE TABLE ${quoteIdentifier(tableName)} (${colDefs.join(', ')})`)
}

/**
 * 重建表（保留数据）
 */
function rebuildTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
  primaryKey?: string
): void {
  const tempTable = `${tableName}_rebuild_${Date.now()}`

  // 1. 创建新表
  createTable(db, tempTable, schema, primaryKey)

  // 2. 找出两表共有的列（只复制这些列）
  const actual = getTableStructure(db, tableName)
  const commonCols = Array.from(actual.columns.keys()).filter((col) => schema[col])

  // 3. 复制数据
  if (commonCols.length > 0) {
    const colList = commonCols.map(c => quoteIdentifier(c)).join(', ')
    db.exec(`
      INSERT INTO ${quoteIdentifier(tempTable)} (${colList})
      SELECT ${colList} FROM ${quoteIdentifier(tableName)}
    `)
  }

  // 4. 删除旧表
  db.exec(`DROP TABLE ${quoteIdentifier(tableName)}`)

  // 5. 重命名新表
  db.exec(`ALTER TABLE ${quoteIdentifier(tempTable)} RENAME TO ${quoteIdentifier(tableName)}`)
}

/**
 * 同步表的列（不重建表）
 */
function syncColumns(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>
): void {
  const actual = getTableStructure(db, tableName)
  const expectedCols = new Set(Object.keys(schema))

  // 添加缺失的列
  for (const colName of expectedCols) {
    if (!actual.columns.has(colName)) {
      db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(colName)} ${schema[colName]}`)
    }
  }

  // 删除多余的列
  for (const colName of actual.columns.keys()) {
    if (!expectedCols.has(colName)) {
      db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} DROP COLUMN ${quoteIdentifier(colName)}`)
    }
  }
}

/**
 * 同步索引
 */
function syncIndexes(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  indexes: Record<string, string>
): void {
  const existingIndexes = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`
  ).all(tableName) as Array<{ name: string }>

  const existingNames = new Set(existingIndexes.map(i => i.name))
  const expectedNames = new Set(Object.keys(indexes))

  // 删除多余索引
  for (const name of existingNames) {
    if (expectedNames.has(name)) {
      try { db.exec(`DROP INDEX ${quoteIdentifier(name)}`) } catch { }
    }
  }

  // 创建新索引
  for (const [name, sql] of Object.entries(indexes)) {
    if (!existingNames.has(name)) {
      try { db.exec(sql) } catch { }
    }
  }
}

/**
 * 主同步函数
 * - 表不存在：创建
 * - 表存在但结构不匹配（主键/类型）：重建
 * - 表存在且结构匹配：同步列（增删）
 * - 同步索引
 */
export function syncTable(
  tableName: string,
  schema: Record<string, string>,
  options?: {
    primaryKey?: string  // 主键定义，如 "roomId, agentId" 或 "id"
    indexes?: Record<string, string>  // 索引定义
  }
): void {
  const db = getDb()
  if (!db) return

  // 1. 表不存在 → 直接创建
  if (!tableExists(db, tableName)) {
    createTable(db, tableName, schema, options?.primaryKey)

    // 创建索引
    if (options?.indexes) {
      for (const indexSQL of Object.values(options.indexes)) {
        db.exec(indexSQL)
      }
    }
    return
  }

  // 2. 表存在 → 检查结构
  const actual = getTableStructure(db, tableName)
  const matches = structureMatches(actual, schema, options?.primaryKey)

  if (matches) {
    // 结构完全匹配 → 同步列（理论上不会做任何事，但确保一致性）
    syncColumns(db, tableName, schema)
  } else {
    // 结构不匹配 → 重建表
    rebuildTable(db, tableName, schema, options?.primaryKey)
  }

  // 3. 同步索引（不管是否重建）
  if (options?.indexes) {
    syncIndexes(db, tableName, options.indexes)
  }
}

// ============================================================================
// Unified Initializer
// ============================================================================

/**
 * Initialize all Hermes SQLite tables with proper schemas.
 * This function automatically syncs all tables to match their schema definitions.
 * Call this once at application bootstrap.
 */
export function initAllHermesTables(retryCount = 0): void {
  // 防止无限重试（最多重试 1 次）
  if (retryCount > 1) {
    throw new Error('[Schema] ❌ Database initialization failed after multiple retry attempts. Please delete the database file manually and restart.')
  }

  const db = getDb()
  if (!db) return

  try {
    // Usage store
    syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

    // Session store
    syncTable(SESSIONS_TABLE, SESSIONS_SCHEMA)
    syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA)
    db.exec(MESSAGES_INDEX)

    // Compression snapshot
    syncTable(COMPRESSION_SNAPSHOT_TABLE, COMPRESSION_SNAPSHOT_SCHEMA)

    // Model context
    syncTable(MODEL_CONTEXT_TABLE, MODEL_CONTEXT_SCHEMA, {
      indexes: {
        idx_model_context_provider_model: MODEL_CONTEXT_INDEX,
      }
    })

    // Group chat - basic tables
    syncTable(GC_ROOMS_TABLE, GC_ROOMS_SCHEMA)
    syncTable(GC_MESSAGES_TABLE, GC_MESSAGES_SCHEMA)
    syncTable(GC_CONTEXT_SNAPSHOTS_TABLE, GC_CONTEXT_SNAPSHOTS_SCHEMA)
    syncTable(GC_PENDING_SESSION_DELETES_TABLE, GC_PENDING_SESSION_DELETES_SCHEMA)
    syncTable(GC_SESSION_PROFILES_TABLE, GC_SESSION_PROFILES_SCHEMA)

    // Group chat - single-column primary key tables (PRIMARY KEY in column definition)
    syncTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA, {
      indexes: {
        idx_gc_room_agents_profile: 'CREATE INDEX idx_gc_room_agents_profile ON gc_room_agents(profile)',
      }
    })

    syncTable(GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA, {
      indexes: {
        idx_gc_room_members_user: 'CREATE INDEX idx_gc_room_members_user ON gc_room_members(userId)',
      }
    })
  } catch (e) {
    console.error('Error initializing Hermes SQLite tables:', e)

    // 自动恢复：备份数据库 → 删除损坏的数据库 → 重新初始化
    console.warn('[Schema] Database initialization failed. Attempting automatic recovery...')

    try {
      const dbPath = getStoragePath()
      const { unlinkSync, copyFileSync, existsSync } = require('fs')

      if (!existsSync(dbPath)) {
        console.log('[Schema] Database file does not exist. Creating new database...')
        initAllHermesTables()
        console.log('[Schema] Database created successfully!')
        return
      }

      // 检查是否已经存在备份（避免重复失败时创建多个备份）
      const existingBackup = dbPath + '.corrupted.last'
      let finalBackupPath: string | undefined

      if (existsSync(existingBackup)) {
        console.log(`[Schema] Backup already exists: ${existingBackup}`)
        console.log('[Schema] Deleting corrupted database without re-backup...')
        try {
          unlinkSync(dbPath)
        } catch (deleteError) {
          console.warn('[Schema] Failed to delete corrupted database:', deleteError)
        }
      } else {
        // 没有备份，创建新备份
        const timestamp = Date.now()
        const backupPath = dbPath + '.corrupted.' + timestamp
        let backupSuccess = false

        try {
          copyFileSync(dbPath, backupPath)
          backupSuccess = true
          finalBackupPath = backupPath
          console.log(`[Schema] Backed up corrupted database to: ${backupPath}`)
        } catch (backupError) {
          console.warn('[Schema] Failed to backup database:', backupError)
        }

        // 只有备份成功后才删除原文件
        if (backupSuccess) {
          try {
            unlinkSync(dbPath)
          } catch (deleteError) {
            console.warn('[Schema] Failed to delete corrupted database:', deleteError)
          }
        }
      }

      // 3. 删除 WAL 和 SHM 文件
      try { unlinkSync(dbPath + '-wal') } catch { }
      try { unlinkSync(dbPath + '-shm') } catch { }

      // 4. 重新初始化（增加重试计数）
      console.log('[Schema] Reinitializing database...')
      initAllHermesTables(retryCount + 1)
      console.log('[Schema] Database recovered successfully! System is ready to use.')
      const backupLocation = finalBackupPath || existingBackup
      if (backupLocation) {
        console.log(`[Schema] If you need to recover old data, restore from: ${backupLocation}`)
      }
    } catch (recoveryError) {
      console.error('[Schema] Failed to recover database:', recoveryError)
      throw recoveryError
    }
  }
}
