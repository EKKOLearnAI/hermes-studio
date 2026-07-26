import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { claimTestHermesDbOwnership } from './db-test-helpers'

const dbState = vi.hoisted(() => ({ db: null as DatabaseSync | null }))
const cliMock = vi.hoisted(() => ({
  deleteSessionForProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbState.db,
  getStoragePath: () => ':memory:',
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  deleteSessionForProfile: cliMock.deleteSessionForProfile,
}))

import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import { SessionDeleter } from '../../packages/server/src/services/hermes/session-deleter'

describe('SessionDeleter durable Group Chat cleanup', () => {
  beforeEach(async () => {
    dbState.db = new DatabaseSync(':memory:')
    await claimTestHermesDbOwnership(dbState.db)
    initAllHermesTables()
    cliMock.deleteSessionForProfile.mockReset()
  })

  afterEach(() => {
    dbState.db?.close()
    dbState.db = null
  })

  it('requeues crash-stranded work and deletes it through the recorded profile', async () => {
    const db = dbState.db!
    const now = Date.now()
    db.prepare(
      `INSERT INTO gc_session_profiles (session_id, room_id, agent_id, profile_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('session-reviewer', 'room-1', 'agent-1', 'reviewer', now)
    db.prepare(
      `INSERT INTO gc_pending_session_deletes
       (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, 'processing', 0, NULL, ?, ?, 0)`,
    ).run('session-reviewer', 'reviewer', now, now)
    cliMock.deleteSessionForProfile.mockResolvedValue(true)

    const result = await new SessionDeleter().drain('reviewer')

    expect(cliMock.deleteSessionForProfile).toHaveBeenCalledWith('session-reviewer', 'reviewer')
    expect(result).toEqual({ deleted: ['session-reviewer'], skipped: [], failed: [] })
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM gc_pending_session_deletes WHERE session_id = ?',
    ).get('session-reviewer')).toEqual({ count: 0 })
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM gc_session_profiles WHERE session_id = ?',
    ).get('session-reviewer')).toEqual({ count: 0 })
  })

  it('drains every profile represented in the outbox on startup replay', async () => {
    const db = dbState.db!
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO gc_pending_session_deletes
       (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, 'pending', 0, NULL, ?, ?, 0)`,
    )
    insert.run('session-writer', 'writer', now, now)
    insert.run('session-reviewer-2', 'reviewer', now + 1, now + 1)
    cliMock.deleteSessionForProfile.mockResolvedValue(true)

    await new SessionDeleter().drainAllProfiles('default')

    expect(cliMock.deleteSessionForProfile).toHaveBeenCalledWith('session-writer', 'writer')
    expect(cliMock.deleteSessionForProfile).toHaveBeenCalledWith('session-reviewer-2', 'reviewer')
    expect(db.prepare('SELECT COUNT(*) AS count FROM gc_pending_session_deletes').get()).toEqual({ count: 0 })
  })

  it('backs off a false CLI result instead of retrying immediately', async () => {
    const db = dbState.db!
    const now = Date.now()
    db.prepare(
      `INSERT INTO gc_pending_session_deletes
       (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, 'pending', 0, NULL, ?, ?, 0)`,
    ).run('session-failed', 'writer', now, now)
    cliMock.deleteSessionForProfile.mockResolvedValue(false)

    const result = await new SessionDeleter().drain('writer')
    const row = db.prepare(
      `SELECT status, attempt_count, last_error, next_attempt_at
       FROM gc_pending_session_deletes WHERE session_id = ?`,
    ).get('session-failed') as {
      status: string
      attempt_count: number
      last_error: string | null
      next_attempt_at: number
    }

    expect(cliMock.deleteSessionForProfile).toHaveBeenCalledWith('session-failed', 'writer')
    expect(result).toEqual({ deleted: [], skipped: ['session-failed'], failed: [] })
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(1)
    expect(row.last_error).toMatch(/returned false/i)
    expect(row.next_attempt_at).toBeGreaterThan(now)
  })

  it('keeps retrying durable cleanup after three transient failures', async () => {
    const db = dbState.db!
    const now = Date.now()
    db.prepare(
      `INSERT INTO gc_pending_session_deletes
       (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, 'pending', 3, 'transient', ?, ?, 0)`,
    ).run('session-retry', 'reviewer', now, now)
    cliMock.deleteSessionForProfile.mockResolvedValue(true)

    await new SessionDeleter().drainAllProfiles('default')

    expect(cliMock.deleteSessionForProfile).toHaveBeenCalledWith('session-retry', 'reviewer')
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM gc_pending_session_deletes WHERE session_id = ?',
    ).get('session-retry')).toEqual({ count: 0 })
  })
})
