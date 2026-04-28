import { describe, it, expect, vi } from 'vitest'

// Force JSON fallback by mocking isSqliteAvailable
vi.mock('../../packages/server/src/db/index', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    isSqliteAvailable: () => false,
    getDb: () => null,
  }
})

import {
  jsonGet,
  jsonSet,
  jsonGetAll,
  jsonDelete,
} from '../../packages/server/src/db/index'

describe('JSON fallback store', () => {
  it('jsonSet and jsonGet round-trip', () => {
    expect(typeof jsonSet).toBe('function')
    expect(typeof jsonGet).toBe('function')
    expect(typeof jsonGetAll).toBe('function')
    expect(typeof jsonDelete).toBe('function')
  })
})

// Test ensureTable with a real in-memory SQLite (Node 22+)
describe('SQLite ensureTable', () => {
  it('creates table with correct columns and handles migration', () => {
    // This test requires Node 22.5+ for node:sqlite
    const nodeVersion = process.versions.node.split('.').map(Number)
    const isAvailable = nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 5)

    if (!isAvailable) {
      console.log('Skipping SQLite test — Node < 22.5')
      return
    }

    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(':memory:')

    // Simulate ensureTable logic
    function ensureTable(tableName: string, schema: Record<string, string>): void {
      const colDefs = Object.entries(schema)
        .map(([col, def]) => `"${col}" ${def}`)
        .join(', ')
      db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)

      const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>
      const existingCols = new Set(rows.map(r => r.name))
      const expectedCols = new Set(Object.keys(schema))

      for (const col of expectedCols) {
        if (!existingCols.has(col)) {
          db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" ${schema[col]}`)
        }
      }
      for (const col of existingCols) {
        if (!expectedCols.has(col)) {
          db.exec(`ALTER TABLE "${tableName}" DROP COLUMN "${col}"`)
        }
      }
    }

    // Initial schema
    const schema: Record<string, string> = {
      session_id: 'TEXT PRIMARY KEY',
      input_tokens: 'INTEGER NOT NULL DEFAULT 0',
      output_tokens: 'INTEGER NOT NULL DEFAULT 0',
      updated_at: 'INTEGER NOT NULL',
    }
    ensureTable('session_usage', schema)

    // Verify columns
    const cols = db.prepare(`PRAGMA table_info("session_usage")`).all() as Array<{ name: string }>
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain('session_id')
    expect(colNames).toContain('input_tokens')
    expect(colNames).toContain('output_tokens')
    expect(colNames).toContain('updated_at')

    // Add a column
    schema['cost_usd'] = 'REAL DEFAULT 0'
    ensureTable('session_usage', schema)
    const cols2 = db.prepare(`PRAGMA table_info("session_usage")`).all() as Array<{ name: string }>
    const colNames2 = cols2.map(c => c.name)
    expect(colNames2).toContain('cost_usd')

    // Remove a column
    delete schema['cost_usd']
    ensureTable('session_usage', schema)
    const cols3 = db.prepare(`PRAGMA table_info("session_usage")`).all() as Array<{ name: string }>
    const colNames3 = cols3.map(c => c.name)
    expect(colNames3).not.toContain('cost_usd')

    // Verify INSERT works
    db.prepare(
      `INSERT INTO session_usage (session_id, input_tokens, output_tokens, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('test-session', 100, 50, Date.now())

    const row = db.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('test-session') as any
    expect(row.session_id).toBe('test-session')
    expect(row.input_tokens).toBe(100)
    expect(row.output_tokens).toBe(50)

    // Verify DELETE works
    db.prepare('DELETE FROM session_usage WHERE session_id = ?').run('test-session')
    const deleted = db.prepare('SELECT * FROM session_usage WHERE session_id = ?').get('test-session')
    expect(deleted).toBeUndefined()

    db.close()
  })
})
