import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Hermes schema initialization', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('initializes all tables with correct schemas', async () => {
    const { initAllHermesTables, USAGE_TABLE, SESSIONS_TABLE, MESSAGES_TABLE, GC_ROOMS_TABLE } =
      await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    // Verify core tables exist
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain(USAGE_TABLE)
    expect(tables.map(t => t.name)).toContain(SESSIONS_TABLE)
    expect(tables.map(t => t.name)).toContain(MESSAGES_TABLE)
    expect(tables.map(t => t.name)).toContain(GC_ROOMS_TABLE)

    // Verify USAGE_TABLE structure
    const usageCols = db.prepare(`PRAGMA table_info("${USAGE_TABLE}")`).all() as Array<{ name: string }>
    expect(usageCols.some(c => c.name === 'id')).toBe(true)
    expect(usageCols.some(c => c.name === 'session_id')).toBe(true)
    expect(usageCols.some(c => c.name === 'input_tokens')).toBe(true)
    expect(usageCols.some(c => c.name === 'output_tokens')).toBe(true)
  })

  it('preserves existing data when adding safe schema columns', async () => {
    const { initAllHermesTables, USAGE_TABLE, USAGE_SCHEMA } =
      await import('../../packages/server/src/db/hermes/schemas')

    // Create table with minimal schema
    db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`)

    // Insert test data
    db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run('test-session', Date.now())

    // Run initialization (should add safe missing columns)
    expect(() => initAllHermesTables()).not.toThrow()

    // Verify data is preserved
    const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('test-session')
    expect(row).toBeTruthy()
    expect(row.session_id).toBe('test-session')

    // Verify safe new columns were added
    const cols = db.prepare(`PRAGMA table_info("${USAGE_TABLE}")`).all() as Array<{ name: string }>
    expect(cols.some(c => c.name === 'input_tokens')).toBe(true)
    expect(cols.some(c => c.name === 'output_tokens')).toBe(true)
  })

  it('handles single-column primary key tables correctly', async () => {
    const { initAllHermesTables, GC_ROOM_AGENTS_TABLE } =
      await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    // Verify table has primary key and required columns
    const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(GC_ROOM_AGENTS_TABLE) as { sql: string }
    expect(tableInfo.sql).toContain('PRIMARY KEY')
    expect(tableInfo.sql).toContain('id')
    expect(tableInfo.sql).toContain('roomId')
    expect(tableInfo.sql).toContain('agentId')

    // Verify we can insert multiple entries with unique id
    db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1', '', 0)
    db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('agent-2', 'room-1', 'agent-2', 'default', 'Agent 2', '', 0)

    const count = db.prepare(`SELECT COUNT(*) as count FROM "${GC_ROOM_AGENTS_TABLE}"`).get() as { count: number }
    expect(count.count).toBe(2)

    // Verify duplicate primary key is rejected
    expect(() => {
      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1 Duplicate', '', 0)
    }).toThrow()
  })
})
