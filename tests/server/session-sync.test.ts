/**
 * Tests for session-sync service
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '../../packages/server/src/db/index'
import { initAllStores } from '../../packages/server/src/db/hermes/init'
import { listSessionSummaries } from '../../packages/server/src/db/hermes/sessions-db'
import { syncAllHermesSessionsOnStartup } from '../../packages/server/src/services/hermes/session-sync'

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: vi.fn().mockResolvedValue([]),
  getSessionDetailFromDbWithProfile: vi.fn(),
}))

function resetSessionTables(): void {
  initAllStores()

  const db = getDb()
  if (db) {
    db.exec('DELETE FROM messages')
    db.exec('DELETE FROM sessions')
  }
}

describe('session-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionTables()
  })

  afterEach(() => {
    resetSessionTables()
  })

  it('should skip sync when local DB is not empty', async () => {
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
    await syncAllHermesSessionsOnStartup()
    expect(vi.mocked(listSessionSummaries)).not.toHaveBeenCalled()

    // Verify session still exists (no changes)
    const countAfter = db!.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
    expect(countAfter.count).toBe(1)
  })

  it('should attempt sync when local DB is empty', async () => {
    const db = getDb()
    expect(db).not.toBeNull()

    // Verify DB is empty
    const countBefore = db!.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
    expect(countBefore.count).toBe(0)

    // Run sync - should attempt to sync from Hermes
    await expect(syncAllHermesSessionsOnStartup()).resolves.toBeUndefined()
    expect(vi.mocked(listSessionSummaries)).toHaveBeenCalledWith('api_server', 10000, 'default')
  })
})
