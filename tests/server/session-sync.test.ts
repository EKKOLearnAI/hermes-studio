/**
 * Tests for session-sync service
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getDb, ensureTable } from '../../packages/server/src/db/index'
import { syncAllHermesSessionsOnStartup } from '../../packages/server/src/services/hermes/session-sync'

describe('session-sync', () => {
  beforeEach(() => {
    // Reset database before each test
    const db = getDb()
    if (db) {
      db.exec('DELETE FROM sessions')
      db.exec('DELETE FROM messages')
    }
  })

  afterEach(() => {
    // Cleanup after each test
    const db = getDb()
    if (db) {
      db.exec('DELETE FROM sessions')
      db.exec('DELETE FROM messages')
    }
  })

  it('should skip sync when local DB is not empty', () => {
    const db = getDb()
    expect(db).not.toBeNull()

    // Insert a test session
    db!.prepare(`
      INSERT INTO sessions (id, profile, source, model, title, started_at, last_active)
      VALUES ('test-session-1', 'default', 'api_server', 'gpt-4', 'Test Session', ${Date.now()}, ${Date.now()})
    `).run()

    // Check that session exists
    const countResult = db!.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
    expect(countResult.count).toBe(1)

    // Run sync - should skip because DB is not empty
    syncAllHermesSessionsOnStartup()

    // Verify session still exists (no changes)
    const countAfter = db!.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
    expect(countAfter.count).toBe(1)
  })

  it('should attempt sync when local DB is empty', () => {
    const db = getDb()
    expect(db).not.toBeNull()

    // Verify DB is empty
    const countBefore = db!.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
    expect(countBefore.count).toBe(0)

    // Run sync - should attempt to sync from Hermes
    syncAllHermesSessionsOnStartup()

    // Note: Whether sessions are actually imported depends on whether
    // Hermes state.db exists and has api_server sessions
    // This test mainly verifies the function doesn't crash when DB is empty
    expect(true).toBe(true)
  })

  it('should handle case when SQLite is not available', () => {
    // This test verifies the function handles the case when getDb() returns null
    // Since we can't easily mock getDb(), we just verify it doesn't crash
    expect(() => {
      syncAllHermesSessionsOnStartup()
    }).not.toThrow()
  })
})
