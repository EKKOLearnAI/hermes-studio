import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

function createContext(path = '') {
  const headers: Record<string, string> = {}
  return {
    params: { roomId: 'room-1' },
    query: path ? { path } : {},
    request: { body: {} },
    state: { user: { role: 'super_admin' } },
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

  it('returns a live Git diff for a workspace file', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before\n')
    execFileSync('git', ['init', '--quiet'], { cwd: workspace })
    execFileSync('git', ['config', 'user.name', 'Hermes Test'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'hermes@example.com'], { cwd: workspace })
    execFileSync('git', ['add', '.'], { cwd: workspace })
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace })
    await writeFile(join(workspace, 'notes.txt'), 'after\n')

    const diff = routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace-file/diff', 'GET')
    const ctx = createContext('notes.txt')
    await diff(ctx)

    expect(ctx.body).toMatchObject({
      path: 'notes.txt',
      gitStatus: 'modified',
      additions: 1,
      deletions: 1,
    })
    expect((ctx.body as any).patch).toContain('+after')
  })

  it('does not expose workspace files to room members without management access', async () => {
    await writeFile(join(workspace, 'private.txt'), 'secret')
    const read = routeHandler('/api/hermes/group-chat/rooms/:roomId/workspace-file/read', 'GET')
    const ctx = createContext('private.txt')
    ctx.state.user = { role: 'admin', id: 2, profiles: [] }
    await read(ctx)
    expect(ctx.status).toBe(403)
    expect(ctx.body).toMatchObject({ code: 'permission_denied' })
  })
})
