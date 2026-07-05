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
    expect(storage.getRoom('room-1')?.workspace).toBe('')

    expect(storage.updateRoomWorkspace('room-1', workspace)?.workspace).toBe(workspace)
    expect(storage.getAllRooms()[0]?.workspace).toBe(workspace)
    expect(storage.getRoom('room-1')?.workspace).toBe(workspace)

    expect(storage.updateRoomWorkspace('room-1', '')?.workspace).toBe('')
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
