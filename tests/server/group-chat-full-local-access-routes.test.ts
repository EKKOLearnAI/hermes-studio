import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server as HttpServer } from 'http'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const dbState = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbState.db,
  isSqliteAvailable: () => Boolean(dbState.db),
}))

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    id: 'agent-socket',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}))

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

async function routeHandler(path: string, method: string) {
  const { groupChatPublicRoutes, groupChatRoutes } = await import('../../packages/server/src/routes/hermes/group-chat')
  const layer = [...(groupChatPublicRoutes as any).stack, ...(groupChatRoutes as any).stack]
    .find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

describe('group chat full local access switch (routes & storage)', () => {
  let httpServer: HttpServer
  let root: string
  let originalWorkspaceBase: string | undefined
  let originalWebUiHome: string | undefined

  beforeEach(async () => {
    vi.resetModules()
    dbState.db = new DatabaseSync(':memory:')
    root = await mkdtemp(join(tmpdir(), 'hermes-gc-fullaccess-'))
    originalWorkspaceBase = process.env.WORKSPACE_BASE
    originalWebUiHome = process.env.HERMES_WEB_UI_HOME
    process.env.WORKSPACE_BASE = root
    process.env.HERMES_WEB_UI_HOME = join(root, 'web-ui-home')
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    httpServer = createServer()
  })

  afterEach(async () => {
    httpServer?.close()
    dbState.db?.close()
    dbState.db = null
    if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
    else process.env.WORKSPACE_BASE = originalWorkspaceBase
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    await rm(root, { recursive: true, force: true })
  })

  it('defaults to 0 and persists on/off with session-seed rotation', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()

    storage.saveRoom('room-1', 'Room 1')
    expect(storage.getRoom('room-1')?.fullLocalAccess).toBe(0)
    const initialSeed = storage.getRoom('room-1')?.sessionSeed

    const on = storage.updateRoomFullLocalAccess('room-1', true)
    expect(on?.fullLocalAccess).toBe(1)
    expect(on?.sessionSeed).not.toBe(initialSeed)
    const onSeed = on?.sessionSeed
    expect(storage.getRoom('room-1')?.fullLocalAccess).toBe(1)
    expect(storage.getAllRooms()[0]?.fullLocalAccess).toBe(1)

    // same value again: no seed rotation, no write
    expect(storage.updateRoomFullLocalAccess('room-1', true)?.sessionSeed).toBe(onSeed)

    const off = storage.updateRoomFullLocalAccess('room-1', false)
    expect(off?.fullLocalAccess).toBe(0)
    expect(off?.sessionSeed).not.toBe(onSeed)
    expect(storage.getRoom('room-1')?.fullLocalAccess).toBe(0)
    server.getIO().close()
  })

  it('isolates the switch per room', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()

    storage.saveRoom('room-a', 'Room A')
    storage.saveRoom('room-b', 'Room B')
    storage.updateRoomFullLocalAccess('room-a', true)

    expect(storage.getRoom('room-a')?.fullLocalAccess).toBe(1)
    expect(storage.getRoom('room-b')?.fullLocalAccess).toBe(0)

    storage.updateRoomFullLocalAccess('room-b', true)
    expect(storage.getRoom('room-a')?.fullLocalAccess).toBe(1)
    expect(storage.getRoom('room-b')?.fullLocalAccess).toBe(1)

    storage.updateRoomFullLocalAccess('room-a', false)
    expect(storage.getRoom('room-a')?.fullLocalAccess).toBe(0)
    expect(storage.getRoom('room-b')?.fullLocalAccess).toBe(1)
    server.getIO().close()
  })

  it('returns null for unknown rooms and does not create rows', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()

    expect(storage.updateRoomFullLocalAccess('missing-room', true)).toBeNull()
    expect(storage.getAllRooms()).toEqual([])
    server.getIO().close()
  })

  it('upgrades existing gc_rooms tables adding fullLocalAccess default 0', async () => {
    dbState.db?.exec('DROP TABLE gc_rooms')
    dbState.db?.exec(`CREATE TABLE gc_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      inviteCode TEXT UNIQUE,
      triggerTokens INTEGER NOT NULL DEFAULT 100000,
      maxHistoryTokens INTEGER NOT NULL DEFAULT 32000,
      tailMessageCount INTEGER NOT NULL DEFAULT 10,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      sessionSeed TEXT NOT NULL DEFAULT '0',
      workspace TEXT NOT NULL DEFAULT ''
    )`)
    dbState.db?.prepare('INSERT INTO gc_rooms (id, name) VALUES (?, ?)').run('old-room', 'Old Room')

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()

    const row = dbState.db?.prepare(
      'SELECT fullLocalAccess FROM gc_rooms WHERE id = ?',
    ).get('old-room') as Record<string, unknown>
    expect(row.fullLocalAccess).toBe(0)

    // column is live: can update through storage after migration
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    expect(storage.getRoom('old-room')?.fullLocalAccess).toBe(0)
    expect(storage.updateRoomFullLocalAccess('old-room', true)?.fullLocalAccess).toBe(1)
    server.getIO().close()
  })

  it('rejects non-managers with 403 and leaves the value untouched', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-private', 'Private Room', undefined, { ownerAuthUserId: 42 })
    storage.addRoomAgent('room-private', 'agent-1', 'research', 'Researcher', '', 0)
    setGroupChatServer(server)
    const user = { id: 2, username: 'ops', role: 'admin', profiles: ['default'] }

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/full-local-access', 'PUT')
    const ctx: any = {
      params: { roomId: 'room-private' },
      state: { user },
      request: { body: { enabled: true } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Access denied' })
    expect(storage.getRoom('room-private')?.fullLocalAccess).toBe(0)
    server.getIO().close()
  })

  it('rejects non-boolean enabled payloads with 400', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/full-local-access', 'PUT')
    for (const bad of [
      { enabled: 1 },
      { enabled: 'yes' },
      { enabled: null },
      {},
      { enabled: 'true' },
    ]) {
      const ctx: any = {
        params: { roomId: 'room-1' },
        request: { body: bad },
        status: 200,
        body: undefined,
      }
      await handler(ctx, async () => {})
      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'enabled must be a boolean' })
      expect(storage.getRoom('room-1')?.fullLocalAccess).toBe(0)
    }
    server.getIO().close()
  })

  it('returns 404 for unknown rooms', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/full-local-access', 'PUT')
    const ctx: any = {
      params: { roomId: 'missing-room' },
      request: { body: { enabled: true } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Room not found' })
    server.getIO().close()
  })

  it('owner can toggle the switch; fences and interrupts room agents on change', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1', undefined, { ownerAuthUserId: 42 })
    setGroupChatServer(server)
    const events: string[] = []
    const fenceCurrentRoomAgentSessions = vi.spyOn(server, 'fenceCurrentRoomAgentSessions').mockImplementation(() => {
      events.push('fence')
      return vi.fn()
    })
    const interruptRoom = vi.spyOn(server.agentClients, 'interruptRoom').mockImplementation(async () => {
      events.push('interrupt')
    })
    const owner = { id: 42, username: 'owner', role: 'admin', profiles: ['default'] }

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/full-local-access', 'PUT')

    const onCtx: any = {
      params: { roomId: 'room-1' },
      state: { user: owner },
      request: { body: { enabled: true } },
      status: 200,
      body: undefined,
    }
    await handler(onCtx, async () => {})
    expect(onCtx.status).toBe(200)
    expect(onCtx.body.room.fullLocalAccess).toBe(1)
    expect(storage.getRoom('room-1')?.fullLocalAccess).toBe(1)
    expect(events).toEqual(['fence', 'interrupt'])

    // same value: no fence/interrupt, no seed rotation
    const seed = storage.getRoom('room-1')?.sessionSeed
    events.length = 0
    const sameCtx: any = {
      params: { roomId: 'room-1' },
      state: { user: owner },
      request: { body: { enabled: true } },
      status: 200,
      body: undefined,
    }
    await handler(sameCtx, async () => {})
    expect(sameCtx.status).toBe(200)
    expect(events).toEqual([])
    expect(storage.getRoom('room-1')?.sessionSeed).toBe(seed)

    // off: fences again and restores 0
    events.length = 0
    const offCtx: any = {
      params: { roomId: 'room-1' },
      state: { user: owner },
      request: { body: { enabled: false } },
      status: 200,
      body: undefined,
    }
    await handler(offCtx, async () => {})
    expect(offCtx.status).toBe(200)
    expect(offCtx.body.room.fullLocalAccess).toBe(0)
    expect(storage.getRoom('room-1')?.fullLocalAccess).toBe(0)
    expect(events).toEqual(['fence', 'interrupt'])
    server.getIO().close()
  })

  it('lets a super_admin manage any room switch regardless of ownership', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1', undefined, { ownerAuthUserId: 99 })
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/full-local-access', 'PUT')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'super', role: 'super_admin' } },
      request: { body: { enabled: true } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})
    expect(ctx.status).toBe(200)
    expect(storage.getRoom('room-1')?.fullLocalAccess).toBe(1)
    server.getIO().close()
  })
})
