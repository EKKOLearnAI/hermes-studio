import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server as HttpServer } from 'http'
import { mkdir, mkdtemp, rm } from 'fs/promises'
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
  const { groupChatRoutes } = await import('../../packages/server/src/routes/hermes/group-chat')
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

describe('group chat room workspace', () => {
  let httpServer: HttpServer
  let root: string
  let originalWorkspaceBase: string | undefined

  beforeEach(async () => {
    vi.resetModules()
    dbState.db = new DatabaseSync(':memory:')
    root = await mkdtemp(join(tmpdir(), 'hermes-gc-workspace-'))
    originalWorkspaceBase = process.env.WORKSPACE_BASE
    process.env.WORKSPACE_BASE = root
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
    await rm(root, { recursive: true, force: true })
  })

  it('defaults, persists, clears, and returns room workspace in list/detail rows', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    const workspace = join(root, 'repo')
    await mkdir(workspace)

    storage.saveRoom('room-1', 'Room 1')
    const initialSeed = storage.getRoom('room-1')?.sessionSeed
    expect(storage.getRoom('room-1')?.workspace).toBe('')

    const firstWorkspaceRoom = storage.updateRoomWorkspace('room-1', workspace)
    expect(firstWorkspaceRoom?.workspace).toBe(workspace)
    expect(firstWorkspaceRoom?.sessionSeed).not.toBe(initialSeed)
    const workspaceSeed = firstWorkspaceRoom?.sessionSeed
    expect(storage.getAllRooms()[0]?.workspace).toBe(workspace)
    expect(storage.getRoom('room-1')?.workspace).toBe(workspace)

    expect(storage.updateRoomWorkspace('room-1', workspace)?.sessionSeed).toBe(workspaceSeed)
    const clearedRoom = storage.updateRoomWorkspace('room-1', '')
    expect(clearedRoom?.workspace).toBe('')
    expect(clearedRoom?.sessionSeed).not.toBe(workspaceSeed)
    server.getIO().close()
  })

  it('sets a validated top-level workspace when creating a room', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    setGroupChatServer(server)
    const workspace = join(root, 'repo with spaces')
    await mkdir(workspace)

    const handler = await routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const ctx: any = {
      request: { body: { name: 'Room 1', inviteCode: 'invite-1', workspace, agents: [] } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.body.room.workspace).toBe(workspace)
    expect(server.getStorage().getRoom(ctx.body.room.id)?.workspace).toBe(workspace)
    server.getIO().close()
  })

  it('rejects invalid top-level workspace values when creating a room', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const ctx: any = {
      request: { body: { name: 'Room 1', inviteCode: 'invite-1', workspace: '/definitely/outside', agents: [] } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Workspace folder is not allowed' })
    expect(server.getStorage().getAllRooms()).toEqual([])
    server.getIO().close()
  })

  it('interrupts active room agents before changing the configured workspace', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    storage.saveRoom('room-1', 'Room 1')
    setGroupChatServer(server)
    const events: string[] = []
    const fenceCurrentRoomAgentSessions = vi.spyOn(server, 'fenceCurrentRoomAgentSessions').mockImplementation(() => {
      events.push('fence')
      return vi.fn()
    })
    const interruptRoom = vi.spyOn(server.agentClients, 'interruptRoom').mockImplementation(async () => {
      events.push('interrupt')
    })

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace', 'PUT')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { workspace } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(fenceCurrentRoomAgentSessions).toHaveBeenCalledWith('room-1')
    expect(interruptRoom).toHaveBeenCalledWith('room-1')
    expect(events).toEqual(['fence', 'interrupt'])
    expect(storage.getRoom('room-1')?.workspace).toBe(workspace)
    server.getIO().close()
  })

  it('does not switch workspace when active room agents do not finish interrupting', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    storage.saveRoom('room-1', 'Room 1')
    setGroupChatServer(server)
    const releaseSessionFence = vi.fn()
    vi.spyOn(server, 'fenceCurrentRoomAgentSessions').mockReturnValue(releaseSessionFence)
    vi.spyOn(server.agentClients, 'interruptRoom').mockRejectedValue(Object.assign(new Error('still running'), { status: 409 }))

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace', 'PUT')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { workspace } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual({ error: 'still running' })
    expect(releaseSessionFence).toHaveBeenCalledTimes(1)
    expect(storage.getRoom('room-1')?.workspace).toBe('')
    server.getIO().close()
  })

  it('ignores unvalidated workspace values hidden in create-room compression config', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const ctx: any = {
      request: {
        body: {
          name: 'Room 1',
          inviteCode: 'invite-1',
          compression: { triggerTokens: 123, workspace: '/definitely/outside' },
          agents: [],
        },
      },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.body.room.workspace).toBe('')
    expect(ctx.body.room.triggerTokens).toBe(123)
    server.getIO().close()
  })

  it('lets a regular admin reopen and list an agentless room they created', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    setGroupChatServer(server)
    const user = { id: 7, username: 'alice', role: 'admin', profiles: ['default'] }

    const create = await routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const createCtx: any = {
      state: { user },
      request: { body: { name: 'Agentless', inviteCode: 'agentless', agents: [] } },
      status: 200,
      body: undefined,
    }
    await create(createCtx, async () => {})
    const roomId = createCtx.body.room.id

    const detail = await routeHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')
    const detailCtx: any = { params: { roomId }, query: {}, state: { user }, status: 200, body: undefined }
    await detail(detailCtx, async () => {})
    expect(detailCtx.body.room.id).toBe(roomId)

    const list = await routeHandler('/api/hermes/group-chat/rooms', 'GET')
    const listCtx: any = { state: { user }, status: 200, body: undefined }
    await list(listCtx, async () => {})
    expect(listCtx.body.rooms.map((room: any) => room.id)).toContain(roomId)
    server.getIO().close()
  })

  it('does not expose configured workspace paths through invite-code lookup', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    server.getStorage().saveRoom('room-1', 'Room 1', 'invite-1')
    server.getStorage().updateRoomWorkspace('room-1', workspace)
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms/join/:code', 'GET')
    const ctx: any = { params: { code: 'invite-1' }, status: 200, body: undefined }
    await handler(ctx, async () => {})

    expect(ctx.body.room.id).toBe('room-1')
    expect(ctx.body.room.workspace).toBe('')
    expect(ctx.body.room.inviteCode).toBe(null)
    expect(ctx.body.room.canManage).toBe(false)
    server.getIO().close()
  })

  it('keeps invite-code members read-only and redacts workspace paths without profile access', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    storage.saveRoom('room-1', 'Room 1', 'invite-1')
    storage.updateRoomWorkspace('room-1', workspace)
    storage.addRoomAgent('room-1', 'agent-1', 'research', 'Researcher', '', 0)
    storage.addRoomMember('room-1', 'user-2', 'Bob', '', '', 2)
    setGroupChatServer(server)
    const user = { id: 2, username: 'bob', role: 'admin', profiles: ['default'] }

    const list = await routeHandler('/api/hermes/group-chat/rooms', 'GET')
    const listCtx: any = { state: { user }, status: 200, body: undefined }
    await list(listCtx, async () => {})
    expect(listCtx.body.rooms).toEqual([expect.objectContaining({ id: 'room-1', workspace: '', inviteCode: null, canManage: false })])

    const detail = await routeHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')
    const detailCtx: any = { params: { roomId: 'room-1' }, query: {}, state: { user }, status: 200, body: undefined }
    await detail(detailCtx, async () => {})
    expect(detailCtx.status).toBe(200)
    expect(detailCtx.body.room.workspace).toBe('')
    expect(detailCtx.body.room.inviteCode).toBe(null)
    expect(detailCtx.body.room.canManage).toBe(false)

    const updateWorkspace = await routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace', 'PUT')
    const workspaceCtx: any = { params: { roomId: 'room-1' }, request: { body: { workspace } }, state: { user }, status: 200, body: undefined }
    await updateWorkspace(workspaceCtx, async () => {})
    expect(workspaceCtx.status).toBe(403)
    expect(storage.getRoom('room-1')?.workspace).toBe(workspace)

    const clone = await routeHandler('/api/hermes/group-chat/rooms/:roomId/clone', 'POST')
    const cloneCtx: any = { params: { roomId: 'room-1' }, request: { body: { name: 'Copy' } }, state: { user }, status: 200, body: undefined }
    await clone(cloneCtx, async () => {})
    expect(cloneCtx.status).toBe(403)
    expect(storage.getAllRooms()).toHaveLength(1)
    server.getIO().close()
  })

  it('rejects workspace updates for rooms outside a regular admin profile scope', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    storage.saveRoom('room-private', 'Private Room')
    storage.addRoomAgent('room-private', 'agent-1', 'research', 'Researcher', '', 0)
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace', 'PUT')
    const ctx: any = {
      params: { roomId: 'room-private' },
      state: { user: { id: 2, username: 'ops', role: 'admin', profiles: ['default'] } },
      request: { body: { workspace } },
      status: 200,
      body: undefined,
    }

    await handler(ctx, async () => {})

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Access denied' })
    expect(storage.getRoom('room-private')?.workspace).toBe('')
    server.getIO().close()
  })

  it('rejects room detail and clone reads outside a regular admin profile scope', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    storage.saveRoom('room-private', 'Private Room')
    storage.updateRoomWorkspace('room-private', workspace)
    storage.addRoomAgent('room-private', 'agent-1', 'research', 'Researcher', '', 0)
    setGroupChatServer(server)
    const user = { id: 2, username: 'ops', role: 'admin', profiles: ['default'] }

    const detail = await routeHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')
    const detailCtx: any = { params: { roomId: 'room-private' }, query: {}, state: { user }, status: 200, body: undefined }
    await detail(detailCtx, async () => {})
    expect(detailCtx.status).toBe(403)
    expect(detailCtx.body).toEqual({ error: 'Access denied' })

    const clone = await routeHandler('/api/hermes/group-chat/rooms/:roomId/clone', 'POST')
    const cloneCtx: any = { params: { roomId: 'room-private' }, request: { body: { name: 'Copy' } }, state: { user }, status: 200, body: undefined }
    await clone(cloneCtx, async () => {})
    expect(cloneCtx.status).toBe(403)
    expect(cloneCtx.body).toEqual({ error: 'Access denied' })
    expect(storage.getAllRooms()).toHaveLength(1)
    server.getIO().close()
  })

  it('adds workspace to existing gc_rooms tables with a default value', async () => {
    dbState.db?.exec('DROP TABLE gc_rooms')
    dbState.db?.exec(`CREATE TABLE gc_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      inviteCode TEXT UNIQUE,
      triggerTokens INTEGER NOT NULL DEFAULT 100000,
      maxHistoryTokens INTEGER NOT NULL DEFAULT 32000,
      tailMessageCount INTEGER NOT NULL DEFAULT 10,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      sessionSeed TEXT NOT NULL DEFAULT '0'
    )`)
    dbState.db?.prepare('INSERT INTO gc_rooms (id, name) VALUES (?, ?)').run('old-room', 'Old Room')

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()

    const row = dbState.db?.prepare('SELECT workspace FROM gc_rooms WHERE id = ?').get('old-room') as { workspace: string }
    expect(row.workspace).toBe('')
  })

  it('validates workspace updates through the group room REST route', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const { setGroupChatServer } = await import('../../packages/server/src/routes/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    server.getStorage().saveRoom('room-1', 'Room 1')
    setGroupChatServer(server)

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace', 'PUT')
    const okCtx: any = { params: { roomId: 'room-1' }, request: { body: { workspace } }, status: 200, body: undefined }
    await handler(okCtx, async () => {})
    expect(okCtx.body.room.workspace).toBe(workspace)

    const badCtx: any = { params: { roomId: 'room-1' }, request: { body: { workspace: '/definitely/outside' } }, status: 200, body: undefined }
    await handler(badCtx, async () => {})
    expect(badCtx.status).toBe(403)
    expect(server.getStorage().getRoom('room-1')?.workspace).toBe(workspace)

    const missingCtx: any = { params: { roomId: 'room-1' }, request: { body: {} }, status: 200, body: undefined }
    await handler(missingCtx, async () => {})
    expect(missingCtx.status).toBe(400)
    expect(server.getStorage().getRoom('room-1')?.workspace).toBe(workspace)

    const nullCtx: any = { params: { roomId: 'room-1' }, request: { body: { workspace: null } }, status: 200, body: undefined }
    await handler(nullCtx, async () => {})
    expect(nullCtx.status).toBe(400)
    expect(server.getStorage().getRoom('room-1')?.workspace).toBe(workspace)

    const clearCtx: any = { params: { roomId: 'room-1' }, request: { body: { workspace: '' } }, status: 200, body: undefined }
    await handler(clearCtx, async () => {})
    expect(clearCtx.body.room.workspace).toBe('')
    server.getIO().close()
  })
})
