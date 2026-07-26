import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const refreshedAuth = vi.hoisted(() => ({ active: true }))

vi.mock('../../packages/server/src/middleware/user-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/middleware/user-auth')>()
  return {
    ...actual,
    loadActiveAuthenticatedUser: vi.fn((id: number | string) => refreshedAuth.active
      ? Number(id) === 1
        ? { id: 1, username: 'root', role: 'super_admin', profiles: [] }
        : { id: Number(id), username: 'reader', role: 'admin', profiles: [] }
      : null),
  }
})

import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

function createContext(path = ''): any {
  const headers: Record<string, string> = {}
  return {
    params: { roomId: 'room-1' },
    query: path ? { path } : {},
    request: { body: {} },
    state: { user: { id: 1, username: 'root', role: 'super_admin', profiles: [] } },
    status: 200,
    body: undefined as unknown,
    headers,
    set(name: string, value: string) { headers[name] = value },
  }
}

describe('group chat workspace file routes', () => {
  let root: string
  let workspace: string
  let originalHermesHome: string | undefined
  let room: any
  let agents: any[]
  let storage: any

  beforeEach(async () => {
    refreshedAuth.active = true
    root = await mkdtemp(join(tmpdir(), 'hermes-group-files-'))
    workspace = join(root, 'room-workspace')
    await mkdir(workspace)
    originalHermesHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = join(root, 'hermes-home')
    await mkdir(process.env.HERMES_HOME, { recursive: true })
    room = { id: 'room-1', workspace, ownerAuthUserId: 1 }
    agents = [{ profile: 'default' }]
    storage = {
      getRoom: (id: string) => id === room.id ? room : null,
      getRoomAgents: () => agents,
      getRoomsForProfiles: () => [],
      getMemberByAuthUserId: () => null,
    }
    setGroupChatServer({ getStorage: () => storage } as any)
  })

  afterEach(async () => {
    setGroupChatServer(null)
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    await rm(root, { recursive: true, force: true })
  })

  it('lists the managed room workspace and blocks traversal', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'hello')
    const list = routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace-files/list', 'GET')
    const ctx = createContext()
    await list(ctx)
    expect(ctx.body).toMatchObject({
      path: '',
      entries: [expect.objectContaining({ name: 'notes.txt', path: 'notes.txt', size: 5 })],
    })

    const escaped = createContext('../outside.txt')
    await list(escaped)
    expect(escaped.status).toBe(400)
    expect(escaped.body).toMatchObject({ code: 'invalid_path' })
  })

  it('previews exact bytes from an Agent Hermes workspace with safe response headers', async () => {
    const agentWorkspace = join(process.env.HERMES_HOME!, 'workspace')
    await mkdir(agentWorkspace, { recursive: true })
    const deckPath = join(agentWorkspace, 'deck.pptx')
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])
    await writeFile(deckPath, bytes)

    const content = routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace-file/content', 'GET')
    const ctx = createContext(deckPath)
    await content(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual(bytes)
    expect(ctx.headers['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(ctx.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(ctx.headers['Cache-Control']).toContain('no-store')
  })

  it('blocks a workspace write when the requester is disabled after path resolution starts', async () => {
    const target = join(workspace, 'protected.txt')
    await writeFile(target, 'original')
    const write = routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace-file/write', 'PUT')
    const ctx = createContext()
    ctx.request.body = { path: 'protected.txt', content: 'revoked write' }

    const operation = write(ctx)
    refreshedAuth.active = false
    await operation

    expect(ctx.status).toBe(404)
    expect(ctx.body).toMatchObject({ error: 'Room not found', code: 'not_found' })
    await expect(readFile(target, 'utf-8')).resolves.toBe('original')
  })

  it('blocks a workspace write when the configured workspace changes during path resolution', async () => {
    const originalWorkspace = workspace
    const replacementWorkspace = join(root, 'replacement')
    await mkdir(replacementWorkspace)
    const target = join(originalWorkspace, 'protected.txt')
    await writeFile(target, 'original')
    const ctx = createContext()
    ctx.request.body = { path: 'protected.txt', content: 'changed' }

    const write = routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace-file/write', 'PUT')
    const operation = write(ctx)
    room.workspace = replacementWorkspace
    await operation

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Workspace authorization changed', code: 'permission_denied' })
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('returns the missing-room shape for workspace file reads without room access', async () => {
    await writeFile(join(workspace, 'private.txt'), 'secret')
    const read = routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace-file/read', 'GET')
    const ctx = createContext('private.txt')
    ctx.state.user = { role: 'admin', id: 2, profiles: [] }
    await read(ctx)
    expect(ctx.status).toBe(404)
    expect(ctx.body).toMatchObject({ error: 'Room not found', code: 'not_found' })
  })
})
