import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server as HttpServer } from 'node:http'

const dbState = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbState.db,
  isSqliteAvailable: () => Boolean(dbState.db),
}))

describe('group chat legacy activity migration', () => {
  let httpServer: HttpServer

  beforeEach(() => {
    vi.resetModules()
    dbState.db = new DatabaseSync(':memory:')
    httpServer = createServer()
  })

  afterEach(() => {
    vi.useRealTimers()
    dbState.db?.close()
    dbState.db = null
  })

  it('backfills only valid historical compatibility times, derives a missing room creation time, orders by activity, and is idempotent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const cutoff = Date.now()
    dbState.db?.exec(`
      CREATE TABLE gc_rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        inviteCode TEXT UNIQUE
      );
      CREATE TABLE gc_messages (
        id TEXT PRIMARY KEY,
        roomId TEXT NOT NULL,
        senderId TEXT NOT NULL,
        senderName TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        tool_name TEXT,
        finish_reason TEXT
      );
    `)
    dbState.db?.prepare('INSERT INTO gc_rooms (id, name) VALUES (?, ?)').run('room-a', 'No trusted history')
    dbState.db?.prepare('INSERT INTO gc_rooms (id, name) VALUES (?, ?)').run('room-z', 'Historical activity')
    dbState.db?.prepare(
      'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('history-valid', 'room-z', 'user-1', 'User', 'old visible message', cutoff - 1_000)
    dbState.db?.prepare(
      'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('history-future', 'room-z', 'user-1', 'User', 'future timestamp', cutoff + 1_000)
    dbState.db?.prepare(
      'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, role, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('history-tool', 'room-z', 'agent-1', 'Agent', 'tool message', cutoff - 500, 'tool', 'shell')
    dbState.db?.prepare(
      'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, role, finish_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('history-streaming', 'room-z', 'agent-1', 'Agent', 'stream fragment', cutoff - 250, 'assistant', 'streaming')

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    initAllHermesTables()
    const server = new GroupChatServer(httpServer)

    expect(dbState.db?.prepare('SELECT createdAt FROM gc_rooms WHERE id = ?').get('room-z')).toEqual({
      createdAt: cutoff - 1_000,
    })
    expect(dbState.db?.prepare('SELECT createdAt FROM gc_rooms WHERE id = ?').get('room-a')).toEqual({
      createdAt: 0,
    })
    expect(dbState.db?.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('history-valid')).toEqual({
      persistedAt: cutoff - 1_000,
    })
    expect(dbState.db?.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('history-future')).toEqual({
      persistedAt: 0,
    })
    expect(dbState.db?.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('history-tool')).toEqual({
      persistedAt: 0,
    })
    expect(dbState.db?.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('history-streaming')).toEqual({
      persistedAt: 0,
    })
    expect(server.getStorage().getAllRooms().map(room => room.id)).toEqual(['room-z', 'room-a'])

    initAllHermesTables()
    expect(dbState.db?.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('history-valid')).toEqual({
      persistedAt: cutoff - 1_000,
    })
    server.getIO().close()
  })

  it('persists the migration boundary across a database restart so future timestamps never become trusted later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-chat-activity-'))
    const path = join(dir, 'legacy.sqlite')
    dbState.db?.close()
    dbState.db = new DatabaseSync(path)
    try {
      dbState.db.exec(`
        CREATE TABLE gc_rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, inviteCode TEXT UNIQUE);
        CREATE TABLE gc_messages (
          id TEXT PRIMARY KEY, roomId TEXT NOT NULL, senderId TEXT NOT NULL, senderName TEXT NOT NULL,
          content TEXT NOT NULL, timestamp INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'user'
        );
      `)
      dbState.db.prepare('INSERT INTO gc_rooms (id, name) VALUES (?, ?)').run('room-1', 'Room')
      dbState.db.prepare(
        'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('future-on-first-upgrade', 'room-1', 'user-1', 'User', 'future', 1_000_001)

      const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      initAllHermesTables()
      expect(dbState.db.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('future-on-first-upgrade')).toEqual({
        persistedAt: 0,
      })
      expect(dbState.db.prepare('SELECT migrationCutoff FROM gc_activity_migrations WHERE id = ?').get('legacy-activity-times-v1')).toEqual({
        migrationCutoff: 1_000_000,
      })

      dbState.db.close()
      dbState.db = new DatabaseSync(path)
      vi.setSystemTime(1_000_002)
      initAllHermesTables()
      expect(dbState.db.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('future-on-first-upgrade')).toEqual({
        persistedAt: 0,
      })
    } finally {
      vi.useRealTimers()
      dbState.db?.close()
      dbState.db = null
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('orders profile, authenticated-member, and owner room lists by activity', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    initAllHermesTables()
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-a', 'Older', 'ROOMA', { ownerAuthUserId: 7 })
    storage.saveRoom('room-z', 'Newer', 'ROOMZ', { ownerAuthUserId: 7 })
    storage.addRoomAgent('room-a', 'agent-a', 'default', 'Agent A', '', 0)
    storage.addRoomAgent('room-z', 'agent-z', 'default', 'Agent Z', '', 0)
    storage.addRoomMember('room-a', 'auth:7', 'User', '', '', 7)
    storage.addRoomMember('room-z', 'auth:7', 'User', '', '', 7)
    storage.addMessage({ id: 'old', roomId: 'room-a', senderId: 'user', senderName: 'User', content: 'old', timestamp: 10, persistedAt: 10 })
    storage.addMessage({ id: 'new', roomId: 'room-z', senderId: 'user', senderName: 'User', content: 'new', timestamp: 20, persistedAt: 20 })

    expect(storage.getRoomsForProfiles(['default']).map(room => room.id)).toEqual(['room-z', 'room-a'])
    expect(storage.getRoomsForAuthUser(7).map(room => room.id)).toEqual(['room-z', 'room-a'])
    expect(storage.getOwnedRoomsForAuthUser(7).map(room => room.id)).toEqual(['room-z', 'room-a'])
    server.getIO().close()
  })
})
