import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
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
    dbState.db?.close()
    dbState.db = null
  })

  it('backfills only valid historical compatibility times, derives a missing room creation time, orders by activity, and is idempotent', async () => {
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
})
