import Koa from 'koa'
import { createServer, type Server as HttpServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function listen(server: HttpServer): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    resolve(`http://127.0.0.1:${address.port}`)
  }))
}

describe('invite-scoped group chat attachments', () => {
  let stateDir = ''
  let httpServer: HttpServer | null = null
  let baseUrl = ''
  let setGroupChatServer: ((server: any) => void) | null = null
  let messages: any[] = []
  let agents: any[] = []

  beforeEach(async () => {
    vi.resetModules()
    stateDir = await mkdtemp(join(tmpdir(), 'hermes-group-attachments-'))
    vi.stubEnv('HERMES_WEB_UI_HOME', stateDir)
    vi.stubEnv('UPLOAD_DIR', join(stateDir, 'upload'))
    messages = []
    agents = []

    const routes = await import('../../packages/server/src/routes/hermes/group-chat')
    setGroupChatServer = routes.setGroupChatServer
    const rooms = new Map([
      ['ROOM1', { id: 'room-1', name: 'Room 1', inviteCode: 'ROOM1' }],
      ['ROOM2', { id: 'room-2', name: 'Room 2', inviteCode: 'ROOM2' }],
    ])
    setGroupChatServer({
      getStorage: () => ({
        getRoomByInviteCode: (code: string) => rooms.get(code) || null,
        getRoom: (roomId: string) => [...rooms.values()].find(room => room.id === roomId) || null,
        getRoomsForProfiles: () => [],
        getMemberByAuthUserId: () => null,
        getMessagesForContext: () => messages,
        getRoomAgents: () => agents,
      }),
    })

    const app = new Koa()
    app.use(async (ctx, next) => {
      if (ctx.get('x-test-denied-user')) {
        ctx.state.user = { id: 99, username: 'denied', role: 'admin', profiles: [] }
      }
      await next()
    })
    app.use(routes.groupChatPublicRoutes.routes())
    app.use(routes.groupChatRoutes.routes())
    httpServer = createServer(app.callback())
    baseUrl = await listen(httpServer)
  })

  afterEach(async () => {
    if (httpServer) await new Promise<void>(resolve => httpServer!.close(() => resolve()))
    setGroupChatServer?.(null)
    vi.unstubAllEnvs()
    vi.resetModules()
    if (stateDir) await rm(stateDir, { recursive: true, force: true })
  })

  it('uploads and previews an attachment only through the matching room invite', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('png-body')], { type: 'image/png' }), 'visitor.png')

    const upload = await fetch(`${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments`, {
      method: 'POST',
      body: form,
    })
    expect(upload.status).toBe(200)
    const body = await upload.json() as { files: Array<{ name: string; path: string }> }
    expect(body.files).toHaveLength(1)
    expect(body.files[0].name).toBe('visitor.png')
    expect(body.files[0].path).toMatch(/^[a-f0-9]{32}\.png$/)
    const storedName = basename(body.files[0].path)

    const preview = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments/${encodeURIComponent(storedName)}?name=visitor.png`,
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toBe('image/png')
    expect(preview.headers.get('content-disposition')).toContain('inline')
    expect(Buffer.from(await preview.arrayBuffer()).toString()).toBe('png-body')
    const injectedName = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments/${encodeURIComponent(storedName)}?name=${encodeURIComponent('image.png\r\nX-Injected: yes')}`,
    )
    expect(injectedName.status).toBe(200)
    expect(injectedName.headers.get('x-injected')).toBeNull()
    expect(injectedName.headers.get('content-disposition')).not.toContain('\r')
    expect(injectedName.headers.get('content-disposition')).not.toContain('\n')

    const crossRoom = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM2/attachments/${encodeURIComponent(storedName)}`,
    )
    expect(crossRoom.status).toBe(404)
  })

  it('returns a readable 413 response for an oversized group attachment', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.alloc(21 * 1024 * 1024, 0x61)]), 'too-large.bin')

    const upload = await fetch(`${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments`, {
      method: 'POST',
      body: form,
    })

    expect(upload.status).toBe(413)
    await expect(upload.json()).resolves.toEqual({
      error: 'Group chat attachment is too large (max 20MB)',
    })
  })

  it('uses the same isolated storage for authenticated room attachment routes', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('room-file')], { type: 'image/png' }), 'room.png')

    const upload = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/attachments`, {
      method: 'POST',
      body: form,
    })
    expect(upload.status).toBe(200)
    const body = await upload.json() as { files: Array<{ name: string; path: string }> }
    const storedName = basename(body.files[0].path)

    const preview = await fetch(
      `${baseUrl}/api/hermes/group-chat/rooms/room-1/attachments/${encodeURIComponent(storedName)}`,
    )
    expect(preview.status).toBe(200)
    expect(await preview.text()).toBe('room-file')
  })

  it('rebinds human attachment blocks to this room without exposing the server path', async () => {
    const attachments = await import('../../packages/server/src/services/hermes/group-chat/attachments')
    const storedName = `${'a'.repeat(32)}.png`
    const roomPath = attachments.getGroupChatAttachmentPath('room-1', storedName)
    expect(roomPath).toBeTruthy()
    await mkdir(join(stateDir, 'group-chat', 'attachments'), { recursive: true })
    await mkdir(attachments.getGroupChatAttachmentDir('room-1'), { recursive: true })
    await writeFile(roomPath!, 'room-image')

    const normalized = attachments.normalizeHumanGroupChatContent('room-1', [{
      type: 'image',
      name: 'visitor.png',
      path: `/untrusted/client/path/${storedName}`,
      media_type: 'image/png',
    }])

    expect(normalized.storageContent).toEqual([expect.objectContaining({
      type: 'image',
      name: 'visitor.png',
      path: storedName,
    })])
    expect(normalized.runtimeInput).toEqual([expect.objectContaining({
      type: 'image',
      path: roomPath,
    })])
    expect(() => attachments.normalizeHumanGroupChatContent('room-1', [{
      type: 'image',
      name: 'secret.png',
      path: '/etc/passwd',
      media_type: 'image/png',
    }])).toThrow('Invalid group chat attachment')
  })

  it('stores Agent-uploaded media in the same room attachment format as the composer', async () => {
    const attachments = await import('../../packages/server/src/services/hermes/group-chat/attachments')
    const sourcePath = join(stateDir, 'workspace', 'renders', 'final image.png')
    await mkdir(join(stateDir, 'workspace', 'renders'), { recursive: true })
    await writeFile(sourcePath, 'agent-image')

    const block = await attachments.storeAgentGroupChatAttachment(
      'room-1',
      sourcePath,
      'renders/final image.png',
    )

    expect(block).toEqual({
      type: 'image',
      name: 'final image.png',
      path: expect.stringMatching(/^[a-f0-9]{32}\.png$/),
      media_type: 'image/png',
    })
    const storedPath = attachments.getGroupChatAttachmentPath('room-1', block.path)
    expect(storedPath).toBeTruthy()
    expect(await readFile(storedPath!, 'utf8')).toBe('agent-image')
  })

  it('denies protected attachment routes to accounts without room read access', async () => {
    const response = await fetch(
      `${baseUrl}/api/hermes/group-chat/rooms/room-1/attachments/missing.png`,
      { headers: { 'x-test-denied-user': '1' } },
    )
    expect(response.status).toBe(403)
  })

  it('rejects invalid invites and traversal-style attachment names', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('secret')]), 'secret.txt')
    const invalidInvite = await fetch(`${baseUrl}/api/hermes/group-chat/invites/INVALID/attachments`, {
      method: 'POST',
      body: form,
    })
    expect(invalidInvite.status).toBe(404)

    const traversal = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments/${encodeURIComponent('../secret.txt')}`,
    )
    expect([400, 404]).toContain(traversal.status)
  })

  it('serves only images explicitly published by a room Agent outside the upload directory', async () => {
    const workspaceDir = join(stateDir, 'agent-workspace')
    await mkdir(workspaceDir, { recursive: true })
    const agentImagePath = join(workspaceDir, 'agent-result.png')
    const userImagePath = join(workspaceDir, 'user-secret.png')
    await writeFile(agentImagePath, 'agent-image')
    await writeFile(userImagePath, 'user-secret')
    agents = [{ agentId: 'agent-1', name: 'Worker' }]
    messages = [{
      senderId: 'agent-1',
      senderName: 'Worker',
      role: 'assistant',
      content: JSON.stringify([{
        type: 'image',
        name: 'agent-result.png',
        path: agentImagePath,
        media_type: 'image/png',
      }]),
    }, {
      senderId: 'guest-1',
      senderName: 'Visitor',
      role: 'user',
      content: JSON.stringify([{
        type: 'image',
        name: 'user-secret.png',
        path: userImagePath,
        media_type: 'image/png',
      }]),
    }]

    const agentPreview = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments/agent-result.png`,
    )
    expect(agentPreview.status).toBe(200)
    expect(await agentPreview.text()).toBe('agent-image')
    await rm(agentImagePath)
    const materializedPreview = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments/agent-result.png`,
    )
    expect(materializedPreview.status).toBe(200)
    expect(await materializedPreview.text()).toBe('agent-image')

    const userPreview = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments/user-secret.png`,
    )
    expect(userPreview.status).toBe(404)
  })

  it('previews legacy human uploads only when the exact upload path was published in the room', async () => {
    const legacyDir = join(stateDir, 'upload', 'default')
    await mkdir(legacyDir, { recursive: true })
    const legacyName = '0123456789abcdef.png'
    const legacyPath = join(legacyDir, legacyName)
    await writeFile(legacyPath, 'legacy-image')
    messages = [{
      senderId: 'guest-1',
      senderName: 'Visitor',
      role: 'user',
      content: JSON.stringify([{
        type: 'image',
        name: legacyName,
        path: legacyPath,
        media_type: 'image/png',
      }]),
    }]

    const preview = await fetch(
      `${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments/${legacyName}`,
    )
    expect(preview.status).toBe(200)
    expect(await preview.text()).toBe('legacy-image')
  })

  it('rate-limits repeated public uploads per room', async () => {
    for (let index = 0; index < 30; index += 1) {
      const form = new FormData()
      form.append('file', new Blob([String(index)]), `file-${index}.txt`)
      const response = await fetch(`${baseUrl}/api/hermes/group-chat/invites/ROOM2/attachments`, {
        method: 'POST',
        body: form,
      })
      expect(response.status).toBe(200)
    }
    const blockedForm = new FormData()
    blockedForm.append('file', new Blob(['blocked']), 'blocked.txt')
    const blocked = await fetch(`${baseUrl}/api/hermes/group-chat/invites/ROOM2/attachments`, {
      method: 'POST',
      body: blockedForm,
    })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('60')
  })

  it('rejects an oversized public attachment before writing it', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.alloc(20 * 1024 * 1024 + 1)]), 'oversized.bin')
    const response = await fetch(`${baseUrl}/api/hermes/group-chat/invites/ROOM1/attachments`, {
      method: 'POST',
      body: form,
    })
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('20MB'),
    })
  })
})
