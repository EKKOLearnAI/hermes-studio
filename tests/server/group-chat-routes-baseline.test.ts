import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { createServer, type Server as HttpServer } from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refreshedAuth = vi.hoisted(() => ({
  active: true,
  role: 'super_admin' as 'super_admin' | 'admin' | 'user',
  profiles: [] as string[],
}))

vi.mock('../../packages/server/src/middleware/user-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/middleware/user-auth')>()
  return {
    ...actual,
    loadActiveAuthenticatedUser: vi.fn((id: number | string) => refreshedAuth.active
      ? { id: Number(id), username: 'root', role: refreshedAuth.role, profiles: [...refreshedAuth.profiles] }
      : null),
  }
})

import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

function listen(server: HttpServer): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing address')
    resolve(`http://127.0.0.1:${addr.port}`)
  }))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('group chat REST route baseline', () => {
  let httpServer: HttpServer
  let baseUrl: string
  let storage: any
  let agentClients: any
  let clearRoomRuntimeState: ReturnType<typeof vi.fn>
  let deleteRoomRuntimeState: ReturnType<typeof vi.fn>
  let forceCompress: ReturnType<typeof vi.fn>
  let authenticated: boolean

  beforeEach(async () => {
    authenticated = true
    refreshedAuth.active = true
    refreshedAuth.role = 'super_admin'
    refreshedAuth.profiles = []
    storage = {
      rooms: new Map<string, any>(),
      agents: new Map<string, any[]>(),
      messages: new Map<string, any[]>(),
      members: new Map<string, any[]>(),
      actors: new Map<string, any>(),
      capabilities: new Map<string, string[]>(),
      saveRoom: vi.fn((id, name, inviteCode, config) => storage.rooms.set(id, { id, name, inviteCode, totalTokens: 0, sessionSeed: '11111111111111111111111111111111', ...config })),
      createRoomWithOwner: vi.fn(({ id, name, inviteCode, config, owner }) => {
        storage.rooms.set(id, {
          id,
          name,
          inviteCode,
          totalTokens: 0,
          sessionSeed: '11111111111111111111111111111111',
          ownerAuthUserId: owner?.kind === 'authenticated' ? owner.authUserId : null,
          ...config,
        })
        if (owner?.kind === 'local') {
          const actorId = `actor-${id}`
          storage.actors.set(`${id}:${owner.localSubjectId}`, {
            id: actorId,
            roomId: id,
            actorType: 'local',
            localSubjectId: owner.localSubjectId,
            active: 1,
            authorizationRevision: 0,
            contextRevision: 0,
          })
          storage.capabilities.set(actorId, ['room.read', 'room.manage', 'approval.respond'])
        }
      }),
      getRoom: vi.fn((id) => storage.rooms.get(id)),
      findActiveActorByLocalSubjectId: vi.fn((roomId, localSubjectId) => storage.actors.get(`${roomId}:${localSubjectId}`) || null),
      getActorCapabilities: vi.fn((actorId) => storage.capabilities.get(actorId) || []),
      getAllRooms: vi.fn(() => [...storage.rooms.values()]),
      getRoomsForProfiles: vi.fn(() => [...storage.rooms.values()]),
      getRecentMessagesForUI: vi.fn((roomId, limit = 150, offset = 0) => (storage.messages.get(roomId) || []).slice(offset, offset + limit)),
      getMessageCount: vi.fn((roomId) => (storage.messages.get(roomId) || []).length),
      getRoomAgents: vi.fn((roomId) => storage.agents.get(roomId) || []),
      getRoomMembers: vi.fn((roomId) => storage.members.get(roomId) || []),
      listHandoffJobs: vi.fn(() => []),
      updateRoomConfig: vi.fn((roomId, config) => Object.assign(storage.rooms.get(roomId), config)),
      getRoomByInviteCode: vi.fn((code) => [...storage.rooms.values()].find((r: any) => r.inviteCode === code)),
      addRoomAgent: vi.fn((roomId, agentId, profile, name, description, invited, binding = {}) => {
        const row = { id: `row-${agentId}`, roomId, agentId, profile, name, description, invited, ...binding }
        storage.agents.set(roomId, [...(storage.agents.get(roomId) || []), row])
        return row
      }),
      getRoomAgent: vi.fn((roomId, ref) => (storage.agents.get(roomId) || []).find((a: any) => a.id === ref || a.agentId === ref) || null),
      removeAgentActorWithRetention: vi.fn((roomId, ref) => {
        const agent = (storage.agents.get(roomId) || []).find((candidate: any) => candidate.id === ref || candidate.agentId === ref) || null
        if (!agent) return null
        storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((candidate: any) => candidate.id !== ref && candidate.agentId !== ref))
        return { agent, actorId: null, sessionProfiles: [] }
      }),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn((roomId, ref) => storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((a: any) => a.id !== ref && a.agentId !== ref))),
      clearRoomContext: vi.fn((roomId) => { const room = storage.rooms.get(roomId); if (room) Object.assign(room, { totalTokens: 0, sessionSeed: 'rotated' }) }),
      updateRoomConfig: vi.fn((roomId, config) => { const room = storage.rooms.get(roomId); if (room) Object.assign(room, config) }),
      deleteRoom: vi.fn((roomId) => storage.rooms.delete(roomId)),
    }
    agentClients = {
      createAgent: vi.fn(async (cfg: any) => {
        if (cfg.profile === 'bad-profile') throw new Error('agent runtime unavailable')
        return { ...cfg, joinRoom: vi.fn(async () => ({})), disconnect: vi.fn() }
      }),
      addAgentToRoom: vi.fn(async () => ({})),
      interruptRoom: vi.fn(async () => true),
      removeAgentFromRoom: vi.fn(),
      interruptAgent: vi.fn(async () => {}),
      updateAgentIdentity: vi.fn(() => true),
      disconnectRoom: vi.fn(),
      getSummarySessionContext: vi.fn(() => ({
        profile: 'default',
        sessionRegistrar: () => ({
          sessionId: 'gc_h_test',
          authorizationGuard: () => true,
          release: vi.fn(),
        }),
      })),
    }
    clearRoomRuntimeState = vi.fn()
    deleteRoomRuntimeState = vi.fn()
    forceCompress = vi.fn(async () => ({ summary: 'summary' }))
    const cleanupRemovedAgentRuntime = vi.fn(async (removal: any) => {
      if (removal?.agent) agentClients.removeAgentFromRoom(removal.agent.roomId, removal.agent.agentId)
    })
    const resolveLocalCredentialSubject = vi.fn(async (credential: unknown) => credential === 'signed-local' ? 'local:11111111111111111111111111111111' : null)
    setGroupChatServer({
      getStorage: () => storage,
      agentClients,
      clearRoomRuntimeState,
      deleteRoomRuntimeState,
      cleanupRemovedAgentRuntime,
      resolveLocalCredentialSubject,
      getContextEngine: () => ({ forceCompress }),
    } as any)
    const app = new Koa()
    app.use(async (ctx, next) => {
      if (authenticated) {
        ctx.state.user = {
          id: 1,
          username: 'root',
          role: refreshedAuth.role,
          profiles: [...refreshedAuth.profiles],
        }
      }
      await next()
    })
    app.use(bodyParser())
    app.use(groupChatRoutes.routes())
    httpServer = createServer(app.callback())
    baseUrl = await listen(httpServer)
  })

  afterEach(() => {
    httpServer.close()
    setGroupChatServer(null as any)
  })

  it('generates an invite code when creating a room without an explicit code', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Room' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.room.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)
    expect(body.room).not.toHaveProperty('sessionSeed')
  })

  it('rejects reserved @all agent names when creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Room', inviteCode: 'ROOM1', agents: [{ profile: 'default', name: 'all' }] }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: '`all` is reserved for @all mentions' })
  })

  it('rejects incomplete scoped coding-agent launch tuples before creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Incomplete Room',
        inviteCode: 'INCOMPLETE1',
        agents: [{ profile: 'default', name: 'Incomplete Codex', runtime: 'coding_agent', codingAgentId: 'codex' }],
      }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'provider, model, and apiMode are required for coding_agent participants' })
    expect(storage.saveRoom).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('rejects OAuth/subscription providers for scoped coding-agent participants before persistence', async () => {
    const forbiddenParticipant = {
      profile: 'default',
      name: 'OAuth Codex',
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      mode: 'scoped',
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      apiMode: 'codex_responses',
    }

    const createRes = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Forbidden Room', inviteCode: 'FORBIDDEN1', agents: [forbiddenParticipant] }),
    })
    expect(createRes.status).toBe(400)
    await expect(createRes.json()).resolves.toMatchObject({ error: expect.stringContaining('does not support OAuth/subscription providers') })
    expect(storage.saveRoom).not.toHaveBeenCalled()
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()

    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    const addRes = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forbiddenParticipant),
    })
    expect(addRes.status).toBe(400)
    await expect(addRes.json()).resolves.toMatchObject({ error: expect.stringContaining('does not support OAuth/subscription providers') })
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('rejects cloning legacy scoped participants with forbidden providers before persisting a new room', async () => {
    storage.rooms.set('room-source', { id: 'room-source', name: 'Source', inviteCode: 'SOURCE', sessionSeed: '0' })
    storage.agents.set('room-source', [{
      id: 'row-agent',
      agentId: 'agent-1',
      profile: 'default',
      name: 'OAuth Codex',
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      mode: 'scoped',
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      apiMode: 'codex_responses',
      sessionId: 'legacy-session',
    }])
    storage.saveRoom.mockClear()

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-source/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rejected Clone', inviteCode: 'CLONE-BAD' }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('does not support OAuth/subscription providers') })
    expect(storage.saveRoom).not.toHaveBeenCalled()
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('creates a room, persists successful agents, and reports agent connection failures', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Room',
        inviteCode: 'ROOM1',
        agents: [
          { profile: 'default', name: 'Worker' },
          { profile: 'bad-profile', name: 'Broken' },
        ],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.room).toMatchObject({ name: 'Room', inviteCode: 'ROOM1' })
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0]).not.toHaveProperty('id')
    expect(body.agents[0]).not.toHaveProperty('sessionId')
    expect(body.agents[0]).not.toHaveProperty('sessionGeneration')
    expect(body.agentResults).toEqual([
      expect.objectContaining({ profile: 'default', ok: true }),
      expect.objectContaining({ profile: 'bad-profile', ok: false, code: 'PROFILE_AGENT_CONNECT_FAILED' }),
    ])
    expect(storage.createRoomWithOwner).toHaveBeenCalled()
  })

  it('rejects a nested create profile outside the authenticated requester assignments before room creation', async () => {
    refreshedAuth.role = 'admin'
    refreshedAuth.profiles = ['default']

    const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Room',
        agents: [{ profile: 'restricted-profile', name: 'Restricted' }],
      }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Profile "restricted-profile" is not available for this user' })
    expect(storage.createRoomWithOwner).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('rejects cloning source agents outside the authenticated requester assignments before room creation', async () => {
    refreshedAuth.role = 'admin'
    refreshedAuth.profiles = ['default']
    storage.rooms.set('source-room', {
      id: 'source-room',
      name: 'Source',
      inviteCode: 'SOURCE1',
      ownerAuthUserId: 1,
    })
    storage.agents.set('source-room', [{
      id: 'row-restricted',
      roomId: 'source-room',
      agentId: 'agent-restricted',
      profile: 'restricted-profile',
      name: 'Restricted',
      description: '',
      invited: 0,
    }])

    const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/source-room/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clone' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Profile "restricted-profile" is not available for this user' })
    expect(storage.createRoomWithOwner).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('binds auth-disabled REST discovery, reads, management, and creation to the signed local subject', async () => {
    authenticated = false
    const credentialHeaders = { 'X-Group-Chat-Local-Credential': 'signed-local' }
    storage.rooms.set('room-private', {
      id: 'room-private',
      name: 'Private',
      inviteCode: 'PRIVATE1',
      workspace: '/private/workspace',
      authorizationRevision: 0,
    })
    storage.messages.set('room-private', [{ id: 'secret-message' }])

    const anonymousList = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`)
    await expect(anonymousList.json()).resolves.toEqual({ rooms: [] })
    expect((await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-private`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-private`, {
      headers: { 'X-Group-Chat-Local-Credential': 'forged' },
    })).status).toBe(404)

    const missingIdentityCreate = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unowned' }),
    })
    expect(missingIdentityCreate.status).toBe(401)
    await expect(missingIdentityCreate.json()).resolves.toEqual({ error: 'Group chat identity required' })

    const ungrantedList = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, { headers: credentialHeaders })
    await expect(ungrantedList.json()).resolves.toEqual({ rooms: [] })

    const actor = {
      id: 'local-actor-1',
      roomId: 'room-private',
      actorType: 'local',
      authUserId: null,
      agentId: null,
      localSubjectId: 'local:11111111111111111111111111111111',
      systemKey: null,
      name: 'Local user',
      description: '',
      avatar: '',
      active: 1,
      authorizationRevision: 0,
      contextRevision: 0,
      tombstonedAt: null,
      createdAt: 1,
      updatedAt: 1,
    }
    storage.actors.set('room-private:local:11111111111111111111111111111111', actor)
    storage.capabilities.set(actor.id, ['room.read', 'approval.respond'])

    const readableList = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, { headers: credentialHeaders })
    const readableBody = await readableList.json() as any
    expect(readableBody.rooms).toEqual([
      expect.objectContaining({
        id: 'room-private',
        inviteCode: null,
        workspace: '',
        canManage: false,
        canApprove: true,
      }),
    ])
    const readableDetail = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-private`, { headers: credentialHeaders })
    expect(readableDetail.status).toBe(200)
    await expect(readableDetail.json()).resolves.toMatchObject({ messages: [{ id: 'secret-message' }] })
    expect((await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-private/invite-code`, {
      method: 'PUT',
      headers: { ...credentialHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteCode: 'ROTATED' }),
    })).status).toBe(403)

    storage.capabilities.set(actor.id, ['room.read', 'room.manage', 'approval.respond'])
    const managedList = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, { headers: credentialHeaders })
    await expect(managedList.json()).resolves.toEqual({
      rooms: [expect.objectContaining({
        id: 'room-private',
        inviteCode: 'PRIVATE1',
        workspace: '/private/workspace',
        canManage: true,
        canApprove: true,
      })],
    })

    const localCreate = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { ...credentialHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Owned locally' }),
    })
    expect(localCreate.status).toBe(200)
    expect(storage.createRoomWithOwner).toHaveBeenLastCalledWith(expect.objectContaining({
      owner: {
        kind: 'local',
        localSubjectId: 'local:11111111111111111111111111111111',
        username: 'Local user',
      },
    }))
  })

  it('preserves mixed-runtime bindings for initial room participants', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Mixed Room',
        inviteCode: 'MIXED1',
        agents: [
          { profile: 'default', name: 'Codex A', runtime: 'coding_agent', codingAgentId: 'codex', provider: 'openai', model: 'gpt-5-codex', apiMode: 'codex_responses', reasoningEffort: 'high' },
          { profile: 'default', name: 'Codex B', runtime: 'coding_agent', codingAgentId: 'codex', provider: 'openai', model: 'gpt-5-codex', apiMode: 'codex_responses', reasoningEffort: 'medium' },
          { profile: 'default', name: 'Claude A', runtime: 'coding_agent', codingAgentId: 'claude-code', provider: 'anthropic', model: 'claude-sonnet', apiMode: 'anthropic_messages', reasoningEffort: 'high' },
          { profile: 'default', name: 'Claude B', runtime: 'coding_agent', codingAgentId: 'claude-code', provider: 'anthropic', model: 'claude-sonnet', apiMode: 'anthropic_messages', reasoningEffort: 'medium' },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agents).toHaveLength(4)
    expect(body.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Codex A', runtime: 'coding_agent', codingAgentId: 'codex', apiMode: 'codex_responses', reasoningEffort: 'high' }),
      expect.objectContaining({ name: 'Claude A', runtime: 'coding_agent', codingAgentId: 'claude-code', apiMode: 'anthropic_messages', reasoningEffort: 'high' }),
    ]))
    expect(new Set(body.agents.map((agent: any) => agent.agentId)).size).toBe(4)
    expect(new Set(body.agents.map((agent: any) => agent.sessionId)).size).toBe(4)
  })

  it('returns room detail with paging metadata, agents, and members', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.messages.set('room-1', [{ id: 'msg-1' }, { id: 'msg-2' }])
    storage.agents.set('room-1', [{ id: 'row-agent', agentId: 'agent-1', profile: 'default', name: 'Agent' }])
    storage.members.set('room-1', [{ userId: 'user-1', name: 'Alice' }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1?limit=1&offset=1`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      room: { id: 'room-1', name: 'Room' },
      messages: [{ id: 'msg-2' }],
      agents: [{ agentId: 'agent-1' }],
      members: [{ userId: 'user-1' }],
      total: 2,
      offset: 1,
      limit: 1,
      hasMore: false,
    })
  })

  it('rejects an in-flight agent add when the requester is disabled before persistence', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1 })
    const runtimeClient = { agentId: 'provisional-agent', disconnect: vi.fn() }
    const creation = deferred<any>()
    agentClients.createAgent.mockReturnValueOnce(creation.promise)

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Agent' }),
    })
    await vi.waitFor(() => expect(agentClients.createAgent).toHaveBeenCalledOnce())

    refreshedAuth.active = false
    creation.resolve(runtimeClient)
    const response = await pendingResponse

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Room not found' })
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.addAgentToRoom).not.toHaveBeenCalled()
    expect(runtimeClient.disconnect).toHaveBeenCalledOnce()
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'provisional-agent')
  })

  it('rejects an in-flight agent add when the requested profile assignment is revoked before persistence', async () => {
    refreshedAuth.role = 'admin'
    refreshedAuth.profiles = ['default']
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1 })
    const runtimeClient = { agentId: 'provisional-profile-agent', disconnect: vi.fn() }
    const creation = deferred<any>()
    agentClients.createAgent.mockReturnValueOnce(creation.promise)

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Agent' }),
    })
    await vi.waitFor(() => expect(agentClients.createAgent).toHaveBeenCalledOnce())

    refreshedAuth.profiles = []
    creation.resolve(runtimeClient)
    const response = await pendingResponse

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Profile "default" is not available for this user' })
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.addAgentToRoom).not.toHaveBeenCalled()
    expect(runtimeClient.disconnect).toHaveBeenCalledOnce()
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'provisional-profile-agent')
  })

  it('rolls back an agent when the requested profile assignment is revoked during room join', async () => {
    refreshedAuth.role = 'admin'
    refreshedAuth.profiles = ['default']
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1 })
    const runtimeClient = { agentId: 'joined-profile-agent', disconnect: vi.fn() }
    const roomJoin = deferred<void>()
    agentClients.createAgent.mockResolvedValueOnce(runtimeClient)
    agentClients.addAgentToRoom.mockReturnValueOnce(roomJoin.promise)

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Agent' }),
    })
    await vi.waitFor(() => expect(agentClients.addAgentToRoom).toHaveBeenCalledOnce())
    expect(storage.addRoomAgent).toHaveBeenCalledOnce()

    refreshedAuth.profiles = []
    roomJoin.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Profile "default" is not available for this user' })
    expect(storage.removeAgentActorWithRetention).toHaveBeenCalledOnce()
    expect(storage.getRoomAgents('room-1')).toEqual([])
    expect(runtimeClient.disconnect).toHaveBeenCalledOnce()
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'joined-profile-agent')
  })

  it('rolls back a new room when an earlier agent profile is revoked during a later agent join', async () => {
    refreshedAuth.role = 'admin'
    refreshedAuth.profiles = ['profile-a', 'profile-b']
    const secondJoin = deferred<void>()
    agentClients.addAgentToRoom
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(secondJoin.promise)

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Provisioning Room',
        agents: [
          { profile: 'profile-a', name: 'Agent A' },
          { profile: 'profile-b', name: 'Agent B' },
        ],
      }),
    })
    await vi.waitFor(() => expect(agentClients.addAgentToRoom).toHaveBeenCalledTimes(2))
    const roomId = storage.createRoomWithOwner.mock.calls[0][0].id
    expect(storage.getRoomAgents(roomId)).toHaveLength(2)

    refreshedAuth.profiles = ['profile-b']
    secondJoin.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Profile "profile-a" is not available for this user' })
    expect(storage.rooms.has(roomId)).toBe(false)
    expect(storage.getRoomAgents(roomId)).toEqual([])
    expect(agentClients.disconnectRoom).toHaveBeenCalledWith(roomId)
  })

  it('rolls back only the clone when an earlier copied profile is revoked during a later agent join', async () => {
    refreshedAuth.role = 'admin'
    refreshedAuth.profiles = ['profile-a', 'profile-b']
    storage.rooms.set('source-room', {
      id: 'source-room',
      name: 'Source',
      inviteCode: 'SOURCE1',
      ownerAuthUserId: 1,
    })
    storage.agents.set('source-room', [
      { id: 'source-a', roomId: 'source-room', agentId: 'source-agent-a', profile: 'profile-a', name: 'Agent A', description: '', invited: 0 },
      { id: 'source-b', roomId: 'source-room', agentId: 'source-agent-b', profile: 'profile-b', name: 'Agent B', description: '', invited: 0 },
    ])
    const secondJoin = deferred<void>()
    agentClients.addAgentToRoom
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(secondJoin.promise)

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/source-room/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clone' }),
    })
    await vi.waitFor(() => expect(agentClients.addAgentToRoom).toHaveBeenCalledTimes(2))
    const clonedRoomId = storage.createRoomWithOwner.mock.calls[0][0].id
    expect(storage.getRoomAgents(clonedRoomId)).toHaveLength(2)

    refreshedAuth.profiles = ['profile-b']
    secondJoin.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Profile "profile-a" is not available for this user' })
    expect(storage.rooms.has('source-room')).toBe(true)
    expect(storage.getRoomAgents('source-room')).toHaveLength(2)
    expect(storage.rooms.has(clonedRoomId)).toBe(false)
    expect(storage.getRoomAgents(clonedRoomId)).toEqual([])
    expect(agentClients.disconnectRoom).toHaveBeenCalledWith(clonedRoomId)
  })

  it('rejects an in-flight local agent add after durable room.manage revocation', async () => {
    authenticated = false
    const localSubjectId = 'local:11111111111111111111111111111111'
    const actorId = 'actor-local-manager'
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.actors.set(`room-1:${localSubjectId}`, {
      id: actorId,
      roomId: 'room-1',
      actorType: 'local',
      localSubjectId,
      active: 1,
      authorizationRevision: 0,
      contextRevision: 0,
    })
    storage.capabilities.set(actorId, ['room.read', 'room.manage'])
    const runtimeClient = { agentId: 'provisional-local-agent', disconnect: vi.fn() }
    const creation = deferred<any>()
    agentClients.createAgent.mockReturnValueOnce(creation.promise)

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Group-Chat-Local-Credential': 'signed-local',
      },
      body: JSON.stringify({ profile: 'default', name: 'Agent' }),
    })
    await vi.waitFor(() => expect(agentClients.createAgent).toHaveBeenCalledOnce())

    storage.capabilities.set(actorId, ['room.read'])
    creation.resolve(runtimeClient)
    const response = await pendingResponse

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Access denied' })
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(runtimeClient.disconnect).toHaveBeenCalledOnce()
  })

  it('rolls back an agent persisted before management authority is revoked during room join', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1 })
    const roomJoin = deferred<void>()
    agentClients.addAgentToRoom.mockReturnValueOnce(roomJoin.promise)

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Agent' }),
    })
    await vi.waitFor(() => expect(agentClients.addAgentToRoom).toHaveBeenCalledOnce())
    expect(storage.addRoomAgent).toHaveBeenCalledOnce()

    refreshedAuth.active = false
    roomJoin.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(404)
    expect(storage.removeAgentActorWithRetention).toHaveBeenCalledOnce()
    expect(storage.getRoomAgents('room-1')).toEqual([])
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledOnce()
  })

  it('rejects duplicate room agent display names case-insensitively', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{
      id: 'row-agent',
      agentId: 'agent-1',
      profile: 'default',
      name: 'Agent A',
      runtime: 'hermes',
      sessionId: 'session-a',
    }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'another-profile', name: 'agent' }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'Agent display name already in room' })
  })

  it('removes an agent by row id and disconnects runtime by persisted agent id', async () => {
    const agent = { id: 'row-agent', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Agent' }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [agent])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/row-agent`, { method: 'DELETE' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.removeAgentActorWithRetention).toHaveBeenCalledWith('room-1', 'row-agent')
    expect(storage.removeRoomMembersForAgent).not.toHaveBeenCalled()
    expect(storage.removeRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-1')
    expect(body).toMatchObject({ success: true, agents: [], members: [] })
  })

  it('updates durable handoff settings and lists only public handoff fields', async () => {
    storage.rooms.set('room-1', {
      id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1,
      authorizationRevision: 0, handoffMode: 'mentions', handoffOrderJson: '[]',
    })
    storage.agents.set('room-1', [
      { id: 'row-a', agentId: 'agent-a', name: 'A' },
      { id: 'row-b', agentId: 'agent-b', name: 'B' },
    ])
    const configResponse = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgentMentionDepth: 6, handoffMode: 'fixed', handoffOrder: ['agent-a', 'agent-b'] }),
    })
    expect(configResponse.status).toBe(200)
    expect(storage.updateRoomConfig).toHaveBeenCalledWith('room-1', expect.objectContaining({
      maxAgentMentionDepth: 6, handoffMode: 'fixed', handoffOrderJson: '["agent-a","agent-b"]',
    }))

    storage.listHandoffJobs.mockReturnValueOnce([{
      id: 'job-1', roomId: 'room-1', chainId: 'chain-1', sourceMessageId: 'message-1', targetAgentId: 'agent-a',
      targetSessionId: 'private-session', leaseToken: 'private-lease', leaseOwner: 'private-owner',
      depth: 0, kind: 'mention', status: 'running', attemptCount: 1, lastError: '', createdAt: 1, updatedAt: 2, completedAt: 0,
    }])
    const jobsResponse = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/handoffs`)
    expect(jobsResponse.status).toBe(200)
    const jobs = await jobsResponse.json()
    expect(jobs.jobs[0]).toMatchObject({ id: 'job-1', targetAgentId: 'agent-a', status: 'running' })
    expect(jobs.jobs[0]).not.toHaveProperty('leaseToken')
    expect(jobs.jobs[0]).not.toHaveProperty('leaseOwner')
    expect(jobs.jobs[0]).not.toHaveProperty('targetSessionId')
  })

  it('aborts manual compression when requester authority changes during asynchronous compression', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1 })
    const compression = deferred<void>()
    forceCompress.mockImplementationOnce(async (_roomId: string, _profile: string, registerSession: () => { authorizationGuard: () => boolean }) => {
      const session = registerSession()
      await compression.promise
      if (!session.authorizationGuard()) throw new Error('authorization changed')
      return { summary: 'should not be returned' }
    })

    const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/compress`, { method: 'POST' })
    await vi.waitFor(() => expect(forceCompress).toHaveBeenCalledOnce())
    refreshedAuth.active = false
    compression.resolve()
    const response = await pending

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Room not found' })
  })

  it('does not delete persisted room data when management authority is revoked during runtime cleanup', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1 })
    const runtimeCleanup = deferred<void>()
    deleteRoomRuntimeState.mockImplementationOnce(async (_roomId: string, assertAuthorized: () => void) => {
      await runtimeCleanup.promise
      assertAuthorized()
    })

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1`, { method: 'DELETE' })
    await vi.waitFor(() => expect(deleteRoomRuntimeState).toHaveBeenCalledWith('room-1', expect.any(Function)))

    refreshedAuth.active = false
    runtimeCleanup.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Room not found' })
    expect(storage.deleteRoom).not.toHaveBeenCalled()
    expect(storage.rooms.has('room-1')).toBe(true)
  })

  it('does not clear persisted context when management authority is revoked during runtime cleanup', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99, ownerAuthUserId: 1 })
    const runtimeCleanup = deferred<void>()
    clearRoomRuntimeState.mockImplementationOnce(async (_roomId: string, assertAuthorized: () => void) => {
      await runtimeCleanup.promise
      assertAuthorized()
    })

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
    await vi.waitFor(() => expect(clearRoomRuntimeState).toHaveBeenCalledWith('room-1', expect.any(Function)))

    refreshedAuth.active = false
    runtimeCleanup.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Room not found' })
    expect(storage.clearRoomContext).not.toHaveBeenCalled()
    expect(storage.rooms.get('room-1').totalTokens).toBe(99)
  })

  it('clears room context and runtime state while returning the updated room', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99, sessionSeed: 'old' })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.clearRoomContext).toHaveBeenCalledWith('room-1')
    expect(clearRoomRuntimeState).toHaveBeenCalledWith('room-1', expect.any(Function))
    expect(body).toMatchObject({ success: true, room: { id: 'room-1', totalTokens: 0 } })
    expect(body.room).not.toHaveProperty('sessionSeed')
  })
})
