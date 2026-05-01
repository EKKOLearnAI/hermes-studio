import { beforeAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { unlinkSync, existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'fs'
import { resolve } from 'path'

// Test database path
const TEST_DB_DIR = resolve(process.cwd(), 'packages/server/data/test')
const TEST_DB_PATH = resolve(TEST_DB_DIR, 'test-hermes.db')

// Global test database instance
let testDbInstance: DatabaseSync | null = null

// Mock getDb to return our test database
vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => testDbInstance,
  getStoragePath: () => TEST_DB_PATH,
}))

// Helper to get the actual database instance
function getTestDb(): DatabaseSync {
  if (!testDbInstance) {
    throw new Error('Test database not initialized. Call beforeAll() first.')
  }
  return testDbInstance
}

// Helper to check if table exists
function tableExists(db: DatabaseSync, tableName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName)
  return !!result
}

// Helper to get table columns
function getTableColumns(db: DatabaseSync, tableName: string): Map<string, string> {
  const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
    name: string
    type: string
    pk: number
  }>
  const columnMap = new Map<string, string>()
  for (const col of columns) {
    columnMap.set(col.name, col.type)
  }
  return columnMap
}

// Helper to get table primary key from SQL
function getTablePrimaryKey(db: DatabaseSync, tableName: string): string | null {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName) as { sql: string } | undefined

  const sql = tableInfo?.sql || ''
  const pkMatch = sql.match(/PRIMARY KEY\s*\(([^)]+)\)/i)
  return pkMatch ? pkMatch[1].replace(/\s+/g, '') : null
}

describe('Database Schema Synchronization', () => {
  beforeAll(() => {
    // Create test directory
    if (!existsSync(TEST_DB_DIR)) {
      mkdirSync(TEST_DB_DIR, { recursive: true })
    }
  })

  beforeEach(() => {
    // Clean up any existing test database
    try { unlinkSync(TEST_DB_PATH) } catch {}
    try { unlinkSync(TEST_DB_PATH + '-wal') } catch {}
    try { unlinkSync(TEST_DB_PATH + '-shm') } catch {}

    // Create new test database
    testDbInstance = new DatabaseSync(TEST_DB_PATH)
    testDbInstance.exec('PRAGMA journal_mode=WAL')
    testDbInstance.exec('PRAGMA synchronous=NORMAL')

    // Reset modules to ensure fresh imports
    vi.resetModules()
  })

  afterEach(() => {
    // Close test database
    if (testDbInstance) {
      testDbInstance.close()
      testDbInstance = null
    }

    // Clean up test database and backup files
    try { unlinkSync(TEST_DB_PATH) } catch {}
    try { unlinkSync(TEST_DB_PATH + '-wal') } catch {}
    try { unlinkSync(TEST_DB_PATH + '-shm') } catch {}
  })

  describe('Normal initialization - fresh database creation', () => {
    it('creates all tables with correct schemas when database does not exist', async () => {
      const { initAllHermesTables, USAGE_TABLE, USAGE_SCHEMA, SESSIONS_TABLE, SESSIONS_SCHEMA } =
        await import('../../packages/server/src/db/hermes/schemas')

      initAllHermesTables()

      const db = getTestDb()

      // Verify USAGE_TABLE was created
      expect(tableExists(db, USAGE_TABLE)).toBe(true)

      // Verify USAGE_TABLE has correct columns
      const usageCols = getTableColumns(db, USAGE_TABLE)
      expect(usageCols.size).toBe(Object.keys(USAGE_SCHEMA).length)
      expect(usageCols.has('id')).toBe(true)
      expect(usageCols.has('session_id')).toBe(true)
      expect(usageCols.has('input_tokens')).toBe(true)

      // Verify SESSIONS_TABLE was created
      expect(tableExists(db, SESSIONS_TABLE)).toBe(true)

      // Verify SESSIONS_TABLE has correct columns
      const sessionsCols = getTableColumns(db, SESSIONS_TABLE)
      expect(sessionsCols.size).toBe(Object.keys(SESSIONS_SCHEMA).length)
      expect(sessionsCols.has('id')).toBe(true)
      expect(sessionsCols.has('profile')).toBe(true)
      expect(sessionsCols.has('source')).toBe(true)
    })
  })

  describe('Schema sync with column additions', () => {
    it('adds missing columns to existing table without rebuilding', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/db/hermes/schemas')

      // Create initial table without some columns
      const db = getTestDb()
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`)

      // Insert test data
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run('test-1', Date.now())

      // Sync with full schema
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify all columns now exist
      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.has('input_tokens')).toBe(true)
      expect(cols.has('output_tokens')).toBe(true)
      expect(cols.has('cache_read_tokens')).toBe(true)
      expect(cols.has('cache_write_tokens')).toBe(true)

      // Verify data integrity (should be preserved)
      const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('test-1')
      expect(row).toBeTruthy()
      expect(row.session_id).toBe('test-1')
    })
  })

  describe('Schema sync with composite primary keys', () => {
    it('creates table with composite primary key', async () => {
      const { syncTable, GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA } =
        await import('../../packages/server/src/db/hermes/schemas')

      syncTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA, {
        primaryKey: 'roomId, agentId',
      })

      const db = getTestDb()

      // Verify table exists
      expect(tableExists(db, GC_ROOM_AGENTS_TABLE)).toBe(true)

      // Verify composite primary key
      const pk = getTablePrimaryKey(db, GC_ROOM_AGENTS_TABLE)
      expect(pk).toBe('roomId,agentId')

      // Verify all columns exist
      const cols = getTableColumns(db, GC_ROOM_AGENTS_TABLE)
      expect(cols.has('roomId')).toBe(true)
      expect(cols.has('agentId')).toBe(true)
      expect(cols.has('profile')).toBe(true)
      expect(cols.has('name')).toBe(true)

      // Verify primary key constraint works (should allow same roomId with different agentId)
      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('room-1', 'agent-1', 'default', 'Agent 1', '', 0)

      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('room-1', 'agent-2', 'default', 'Agent 2', '', 0)

      // Verify both rows exist
      const rows = db.prepare(`SELECT COUNT(*) as count FROM "${GC_ROOM_AGENTS_TABLE}"`).get() as { count: number }
      expect(rows.count).toBe(2)

      // Verify duplicate primary key is rejected
      expect(() => {
        db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?)`)
          .run('room-1', 'agent-1', 'default', 'Agent 1 Duplicate', '', 0)
      }).toThrow()
    })
  })

  describe('Primary key changes trigger table rebuild', () => {
    it('rebuilds table when primary key changes from single to composite', async () => {
      const { syncTable, GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA } =
        await import('../../packages/server/src/db/hermes/schemas')

      const db = getTestDb()

      // Create table with single-column primary key and all necessary columns
      db.exec(`CREATE TABLE "${GC_ROOM_MEMBERS_TABLE}" (roomId TEXT PRIMARY KEY, userId TEXT, userName TEXT, description TEXT DEFAULT '', joinedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`)

      // Insert test data
      db.prepare(`INSERT INTO "${GC_ROOM_MEMBERS_TABLE}" (roomId, userId, userName, description, joinedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('room-1', 'user-1', 'User 1', '', Date.now(), Date.now())

      // Sync with composite primary key schema
      syncTable(GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA, {
        primaryKey: 'roomId, userId',
      })

      // Verify composite primary key
      const pk = getTablePrimaryKey(db, GC_ROOM_MEMBERS_TABLE)
      expect(pk).toBe('roomId,userId')

      // Verify data was preserved
      const row = db.prepare(`SELECT * FROM "${GC_ROOM_MEMBERS_TABLE}" WHERE roomId = ? AND userId = ?`).get('room-1', 'user-1')
      expect(row).toBeTruthy()
      expect(row.roomId).toBe('room-1')
      expect(row.userId).toBe('user-1')
    })
  })

  describe('Schema sync with type changes', () => {
    it('rebuilds table when column types change', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/db/hermes/schemas')

      const db = getTestDb()

      // Create table with wrong column type (INTEGER instead of TEXT for session_id)
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, created_at INTEGER NOT NULL)`)

      // Insert test data
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run(12345, Date.now())

      // Sync with correct schema
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify column type is correct (should be TEXT now)
      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.get('session_id')).toBe('TEXT')

      // Verify data was preserved (SQLite can convert INTEGER to TEXT)
      const rows = db.prepare(`SELECT COUNT(*) as count FROM "${USAGE_TABLE}"`).get() as { count: number }
      expect(rows.count).toBe(1)

      // Verify the converted value
      const row = db.prepare(`SELECT session_id FROM "${USAGE_TABLE}"`).get() as { session_id: string }
      expect(row.session_id).toBe('12345')
    })
  })

  describe('Index synchronization', () => {
    it('creates specified indexes on table', async () => {
      const { syncTable, MESSAGES_TABLE, MESSAGES_SCHEMA } =
        await import('../../packages/server/src/db/hermes/schemas')

      syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA, {
        indexes: {
          idx_messages_session_id: 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)',
        },
      })

      const db = getTestDb()

      // Verify index was created
      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get('idx_messages_session_id')
      expect(indexes).toBeTruthy()
    })

    it('removes obsolete indexes', async () => {
      const { syncTable, MESSAGES_TABLE, MESSAGES_SCHEMA } =
        await import('../../packages/server/src/db/hermes/schemas')

      const db = getTestDb()

      // Create table and an extra index
      db.exec(`CREATE TABLE "${MESSAGES_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, content TEXT)`)
      db.exec(`CREATE INDEX idx_extra ON "${MESSAGES_TABLE}"(content)`)

      // Sync without the extra index
      syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA, {
        indexes: {
          idx_messages_session_id: 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)',
        },
      })

      // Verify extra index was removed
      const extraIndex = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get('idx_extra')
      expect(extraIndex).toBeFalsy()

      // Verify correct index was created
      const correctIndex = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get('idx_messages_session_id')
      expect(correctIndex).toBeTruthy()
    })
  })

  describe('Data preservation during schema sync', () => {
    it('preserves data when only adding columns', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/db/hermes/schemas')

      const db = getTestDb()

      // Create minimal table
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`)

      // Insert test data (only columns that exist)
      const sessionId = 'test-session-123'
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run(sessionId, Date.now())

      // Sync with full schema (should add columns without rebuilding)
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify data is still there
      const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get(sessionId)
      expect(row).toBeTruthy()
      expect(row.session_id).toBe(sessionId)
    })

    it('preserves data when rebuilding table with compatible columns', async () => {
      const { syncTable, GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA } =
        await import('../../packages/server/src/db/hermes/schemas')

      const db = getTestDb()

      // Create table without composite primary key but with all columns
      db.exec(`CREATE TABLE "${GC_ROOM_AGENTS_TABLE}" (roomId TEXT NOT NULL, agentId TEXT NOT NULL, profile TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', invited INTEGER DEFAULT 0)`)

      // Insert test data (only columns that exist)
      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('room-1', 'agent-1', 'default', 'Test Agent', '', 0)

      // Sync with composite primary key (triggers rebuild)
      syncTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA, {
        primaryKey: 'roomId, agentId',
      })

      // Verify data was preserved
      const row = db.prepare(`SELECT * FROM "${GC_ROOM_AGENTS_TABLE}" WHERE roomId = ? AND agentId = ?`)
        .get('room-1', 'agent-1')
      expect(row).toBeTruthy()
      expect(row.roomId).toBe('room-1')
      expect(row.agentId).toBe('agent-1')
      expect(row.name).toBe('Test Agent')
    })
  })

  describe('Column deletion', () => {
    it('removes extra columns from existing table', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/db/hermes/schemas')

      // Create table with extra columns
      const db = getTestDb()
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, extra_col TEXT, another_extra INTEGER)`)

      // Insert test data (only for columns that exist)
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at, extra_col, another_extra) VALUES (?, ?, ?, ?)`)
        .run('test-1', Date.now(), 'value', 123)

      // Sync with schema (should remove extra columns)
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify extra columns are gone
      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.has('extra_col')).toBe(false)
      expect(cols.has('another_extra')).toBe(false)

      // Verify data is still there
      const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('test-1')
      expect(row).toBeTruthy()
      expect(row.session_id).toBe('test-1')
    })
  })
})
