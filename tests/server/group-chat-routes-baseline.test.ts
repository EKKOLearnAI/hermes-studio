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
import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

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
  let cleanupRemovedAgentRuntime: ReturnType<typeof vi.fn>
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
      captureRoomDeletionGuard: vi.fn((roomId) => ({
        roomId,
        roomAuthorizationRevision: Number(storage.rooms.get(roomId)?.authorizationRevision || 0),
        participants: (storage.agents.get(roomId) || []).map((participant: any) => ({ ...participant })),
      })),
      captureParticipantDeletionGuard: vi.fn((roomId, ref) => {
        const participant = (storage.agents.get(roomId) || []).find((candidate: any) => candidate.id === ref || candidate.agentId === ref)
        return {
          roomId,
          roomAuthorizationRevision: Number(storage.rooms.get(roomId)?.authorizationRevision || 0),
          participants: (storage.agents.get(roomId) || []).map((participant: any) => ({ ...participant })),
          participantId: participant?.id || '',
          actorAuthorizationRevision: null,
        }
      }),
      getRoomMembers: vi.fn((roomId) => storage.members.get(roomId) || []),
      listHandoffJobs: vi.fn(() => []),
      beginParticipantRuntimeMutation: vi.fn((_roomId, targetAgentId) => ({
        token: `participant-fence-${targetAgentId}`,
        roomId: _roomId,
        actorId: `actor-${targetAgentId}`,
        affectedTargets: [{ targetAgentId, targetSessionId: `session-${targetAgentId}` }],
      })),
      beginRoomRuntimeMutation: vi.fn((roomId) => ({ token: `room-fence-${roomId}`, roomId, actorId: '' })),
      renewRuntimeMutation: vi.fn(() => true),
      releaseRuntimeMutation: vi.fn(() => true),
      cancelHandoffJobs: vi.fn(),
      updateRoomConfig: vi.fn((roomId, config) => Object.assign(storage.rooms.get(roomId), config)),
      getRoomByInviteCode: vi.fn((code) => [...storage.rooms.values()].find((r: any) => r.inviteCode === code)),
      addRoomAgent: vi.fn((roomId, agentId, profile, name, description, invited) => {
        const row = { id: `row-${agentId}`, roomId, agentId, profile, name, description, invited }
        storage.agents.set(roomId, [...(storage.agents.get(roomId) || []), row])
        return row
      }),
      getRoomAgent: vi.fn((roomId, ref) => (storage.agents.get(roomId) || []).find((a: any) => a.id === ref || a.agentId === ref) || null),
      updateRoomAgent: vi.fn((roomId, ref, updates) => {
        const rows = storage.agents.get(roomId) || []
        const row = rows.find((candidate: any) => candidate.id === ref || candidate.agentId === ref)
        if (!row) return null
        Object.assign(row, updates)
        return row
      }),
      removeAgentActorWithRetention: vi.fn((roomId, ref, guard) => {
        const agent = (storage.agents.get(roomId) || []).find((candidate: any) => candidate.id === ref || candidate.agentId === ref) || null
        if (!agent) return null
        if (guard) {
          const captured = guard.participants.find((candidate: any) => candidate.id === guard.participantId)
          if (!captured || JSON.stringify(agent) !== JSON.stringify(captured)) {
            throw Object.assign(new Error('Participant runtime identity changed during synchronized deletion'), { status: 409 })
          }
        }
        storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((candidate: any) => candidate.id !== ref && candidate.agentId !== ref))
        return { agent, actorId: null, sessionProfiles: [] }
      }),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn((roomId, ref) => storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((a: any) => a.id !== ref && a.agentId !== ref))),
      clearRoomContext: vi.fn((roomId, guard) => {
        if (guard && JSON.stringify(storage.agents.get(roomId) || []) !== JSON.stringify(guard.participants)) {
          throw Object.assign(new Error('Room runtime identity changed during synchronized context rotation'), { status: 409 })
        }
        const room = storage.rooms.get(roomId)
        if (room) Object.assign(room, { totalTokens: 0, sessionSeed: 'rotated' })
      }),
      deleteRoom: vi.fn((roomId, guard) => {
        if (guard && JSON.stringify(storage.agents.get(roomId) || []) !== JSON.stringify(guard.participants)) {
          throw Object.assign(new Error('Room runtime identity changed during synchronized deletion'), { status: 409 })
        }
        storage.rooms.delete(roomId)
      }),
    }
    agentClients = {
      createAgent: vi.fn(async (cfg: any) => {
        if (cfg.profile === 'bad-profile') throw new Error('agent runtime unavailable')
        return { ...cfg, joinRoom: vi.fn(async () => ({})), disconnect: vi.fn() }
      }),
      addAgentToRoom: vi.fn(async () => ({})),
      interruptRoom: vi.fn(async () => true),
      updateAgentIdentity: vi.fn(),
      pauseRoom: vi.fn(() => vi.fn()),
      interruptAgent: vi.fn(async () => true),
      interruptHandoffTarget: vi.fn(async (roomId, agentId) => agentClients.interruptAgent(roomId, agentId)),
      getAgent: vi.fn((roomId, agentId) => (storage.agents.get(roomId) || []).find((agent: any) => agent.agentId === agentId)),
      removeAgentFromRoom: vi.fn(),
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
    clearRoomRuntimeState = vi.fn(async () => vi.fn())
    deleteRoomRuntimeState = vi.fn(async () => vi.fn())
    forceCompress = vi.fn(async () => ({ summary: 'summary' }))
    cleanupRemovedAgentRuntime = vi.fn(async (removal: any) => {
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

  it('updates next-run participant controls while preserving a legacy Room identity', async () => {
    storage.rooms.set('room-legacy', { id: 'room-legacy', name: 'Legacy', inviteCode: 'LEGACY1', ownerAuthUserId: 1 })
    storage.agents.set('room-legacy', [{
      id: 'row-legacy', roomId: 'room-legacy', agentId: 'agent-legacy', profile: 'default',
      name: 'Legacy Hermes', description: '', invited: 0,
      // Legacy rows may not have the newer participant fields materialized in fixtures/imports.
      runtime: 'hermes', codingAgentId: '', mode: 'scoped',
      provider: '', model: '', apiMode: '', reasoningEffort: '',
      avatar: undefined,
    }])

    const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-legacy/agents/agent-legacy`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom:legacy', model: 'legacy-model', apiMode: 'anthropic_messages', reasoningEffort: 'high',
      }),
    })

    expect(response.status).toBe(200)
    expect(agentClients.interruptRoom).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      agent: expect.objectContaining({
        roomId: 'room-legacy', agentId: 'agent-legacy', profile: 'default', name: 'Legacy Hermes',
        runtime: 'hermes', codingAgentId: '', mode: 'scoped',
        provider: 'custom:legacy', model: 'legacy-model', apiMode: 'anthropic_messages', reasoningEffort: 'high',
      }),
    })
  })

  it('interrupts the Room when participant identity fields change', async () => {
    storage.rooms.set('room-identity-change', { id: 'room-identity-change', name: 'Identity', inviteCode: 'IDENTITY1', ownerAuthUserId: 1 })
    storage.agents.set('room-identity-change', [{
      id: 'row-identity', roomId: 'room-identity-change', agentId: 'agent-identity', profile: 'default',
      name: 'Before', description: '', invited: 1,
      runtime: 'hermes', codingAgentId: '', mode: 'scoped',
      provider: '', model: '', apiMode: '', reasoningEffort: '', avatar: '',
    }])

    const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-identity-change/agents/agent-identity`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'After' }),
    })

    expect(response.status).toBe(200)
    expect(agentClients.interruptRoom).toHaveBeenCalledWith('room-identity-change')
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
    storage.agents.set('room-1', [{ id: 'row-agent', agentId: 'agent-1', profile: 'default', name: 'Agent' }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'another-profile', name: 'agent' }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'Agent display name already in room' })
  })

  it('removes an agent by row id and disconnects runtime by persisted agent id', async () => {
    const agent = { id: 'row-agent', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Agent', sessionId: 'session-agent-1' }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [agent])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/row-agent`, { method: 'DELETE' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.beginParticipantRuntimeMutation).toHaveBeenCalledWith('room-1', 'agent-1', 'Participant is being deleted')
    expect(storage.beginParticipantRuntimeMutation.mock.invocationCallOrder[0]).toBeLessThan(
      agentClients.pauseRoom.mock.invocationCallOrder[0],
    )
    expect(agentClients.pauseRoom).toHaveBeenCalledWith('room-1')
    expect(agentClients.pauseRoom.mock.invocationCallOrder[0]).toBeLessThan(
      agentClients.interruptHandoffTarget.mock.invocationCallOrder[0],
    )
    expect(agentClients.interruptHandoffTarget).toHaveBeenCalledWith('room-1', 'agent-1', 'session-agent-1')
    expect(agentClients.interruptRoom).not.toHaveBeenCalled()
    expect(agentClients.interruptHandoffTarget.mock.invocationCallOrder[0]).toBeLessThan(
      storage.removeAgentActorWithRetention.mock.invocationCallOrder[0],
    )
    expect(storage.removeAgentActorWithRetention).toHaveBeenCalledWith('room-1', 'row-agent', expect.objectContaining({ participantId: 'row-agent' }))
    expect(storage.removeRoomMembersForAgent).not.toHaveBeenCalled()
    expect(storage.removeRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-1')
    const releasePause = agentClients.pauseRoom.mock.results[0]?.value
    expect(releasePause).toHaveBeenCalledOnce()
    expect(storage.removeAgentActorWithRetention.mock.invocationCallOrder[0]).toBeLessThan(
      releasePause.mock.invocationCallOrder[0],
    )
    expect(body).toMatchObject({ success: true, agents: [], members: [] })
  })

  it('keeps local admission paused through committed runtime cleanup', async () => {
    const agent = {
      id: 'row-agent-cleanup-pause', roomId: 'room-1', agentId: 'agent-cleanup-pause',
      profile: 'default', name: 'Agent', sessionId: 'session-cleanup-pause',
    }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [agent])
    const cleanup = deferred<void>()
    cleanupRemovedAgentRuntime.mockReturnValueOnce(cleanup.promise)

    const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${agent.id}`, { method: 'DELETE' })
    await vi.waitFor(() => expect(storage.removeAgentActorWithRetention).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(cleanupRemovedAgentRuntime).toHaveBeenCalledOnce())
    const releasePause = agentClients.pauseRoom.mock.results.at(-1)?.value
    expect(releasePause).not.toHaveBeenCalled()

    cleanup.resolve()
    const response = await pending

    expect(response.status).toBe(200)
    expect(releasePause).toHaveBeenCalledOnce()
  })

  it('fences and synchronizes a running successor before deleting its source participant', async () => {
    const source = { id: 'row-source', roomId: 'room-1', agentId: 'agent-source', profile: 'default', name: 'Source', sessionId: 'source-session' }
    const successor = { id: 'row-successor', roomId: 'room-1', agentId: 'agent-successor', profile: 'default', name: 'Successor', sessionId: 'successor-session' }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [source, successor])
    storage.beginParticipantRuntimeMutation.mockReturnValueOnce({
      token: 'participant-fence-source',
      fencedJobs: 1,
      affectedTargets: [
        { targetAgentId: source.agentId, targetSessionId: 'source-session' },
        { targetAgentId: successor.agentId, targetSessionId: 'successor-session' },
      ],
    })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/row-source`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(storage.beginParticipantRuntimeMutation).toHaveBeenCalledWith(
      'room-1',
      source.agentId,
      'Participant is being deleted',
    )
    expect(agentClients.interruptHandoffTarget).toHaveBeenCalledWith('room-1', source.agentId, 'source-session')
    expect(agentClients.interruptHandoffTarget).toHaveBeenCalledWith('room-1', successor.agentId, 'successor-session')
    expect(agentClients.interruptHandoffTarget).toHaveBeenCalledTimes(2)
    expect(Math.max(...agentClients.interruptHandoffTarget.mock.invocationCallOrder)).toBeLessThan(
      storage.removeAgentActorWithRetention.mock.invocationCallOrder[0],
    )
    expect(agentClients.interruptRoom).not.toHaveBeenCalled()
  })

  it('fails participant deletion closed when its runtime mutation fence cannot be renewed during a long stop', async () => {
    vi.useFakeTimers()
    try {
      const source = {
        id: 'row-source-fence-expiry', roomId: 'room-1', agentId: 'agent-source-fence-expiry',
        profile: 'default', name: 'Source', sessionId: 'source-session-fence-expiry',
      }
      storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
      storage.agents.set('room-1', [source])
      const interrupt = deferred<void>()
      storage.beginParticipantRuntimeMutation.mockReturnValueOnce({
        token: 'participant-fence-expiry',
        roomId: 'room-1',
        actorId: `actor-${source.agentId}`,
        affectedTargets: [{ targetAgentId: source.agentId, targetSessionId: source.sessionId }],
      })
      storage.renewRuntimeMutation.mockReturnValueOnce(false)
      agentClients.interruptHandoffTarget.mockReturnValueOnce(interrupt.promise)

      const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${source.id}`, { method: 'DELETE' })
      await vi.waitFor(() => expect(agentClients.interruptHandoffTarget).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(60_000)
      interrupt.resolve()
      const response = await pending

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/fence expired|fence.*changed/i) })
      expect(storage.renewRuntimeMutation).toHaveBeenCalledWith(
        'participant-fence-expiry', 'room-1', `actor-${source.agentId}`,
      )
      expect(storage.removeAgentActorWithRetention).not.toHaveBeenCalled()
      expect(storage.getRoomAgents('room-1')).toEqual([source])
      expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith(
        'participant-fence-expiry', 'room-1', `actor-${source.agentId}`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps renewing the exact participant fence throughout a stop longer than its original TTL', async () => {
    vi.useFakeTimers()
    try {
      const source = {
        id: 'row-source-long-stop', roomId: 'room-1', agentId: 'agent-source-long-stop',
        profile: 'default', name: 'Source', sessionId: 'source-session-long-stop',
      }
      storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
      storage.agents.set('room-1', [source])
      const interrupt = deferred<void>()
      storage.beginParticipantRuntimeMutation.mockReturnValueOnce({
        token: 'participant-fence-long-stop', roomId: 'room-1', actorId: `actor-${source.agentId}`,
        affectedTargets: [{ targetAgentId: source.agentId, targetSessionId: source.sessionId }],
      })
      agentClients.interruptHandoffTarget.mockReturnValueOnce(interrupt.promise)

      const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${source.id}`, { method: 'DELETE' })
      await vi.waitFor(() => expect(agentClients.interruptHandoffTarget).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      expect(storage.renewRuntimeMutation).toHaveBeenCalledTimes(6)
      for (const call of storage.renewRuntimeMutation.mock.calls) {
        expect(call).toEqual(['participant-fence-long-stop', 'room-1', `actor-${source.agentId}`])
      }

      interrupt.resolve()
      const response = await pending
      expect(response.status).toBe(200)
      expect(storage.removeAgentActorWithRetention).toHaveBeenCalledOnce()
      expect(storage.releaseRuntimeMutation).not.toHaveBeenCalledWith('participant-fence-long-stop')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a competing claimed handoff while participant deletion is waiting for runtime synchronization', async () => {
    const source = {
      id: 'row-source-admission-race', roomId: 'room-1', agentId: 'agent-source-admission-race',
      profile: 'default', name: 'Source', sessionId: 'source-session-admission-race',
    }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [source])
    const interrupt = deferred<void>()
    storage.beginParticipantRuntimeMutation.mockReturnValueOnce({
      token: 'participant-fence-admission-race', roomId: 'room-1', actorId: `actor-${source.agentId}`,
      affectedTargets: [{ targetAgentId: source.agentId, targetSessionId: source.sessionId }],
    })
    const runtimeClients = new AgentClients() as any
    const replyToMention = vi.fn(async () => {})
    const runtimeParticipant = {
      ...source,
      replyToMention,
      emitContextStatus: vi.fn(),
      setStorage: vi.fn(),
    }
    runtimeClients.rooms.set('room-1', new Map([[source.agentId, runtimeParticipant]]))
    runtimeClients.setStorage({
      getRoomAgentByAgentId: vi.fn(() => source),
      getHandoffJob: vi.fn(() => ({ id: 'job-admission-race', status: 'completed' })),
    })
    agentClients.pauseRoom.mockImplementation((roomId: string) => {
      const releasePause = runtimeClients.pauseRoom(roomId)
      return vi.fn(releasePause)
    })
    agentClients.interruptHandoffTarget.mockReturnValueOnce(interrupt.promise)

    const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${source.id}`, { method: 'DELETE' })
    await vi.waitFor(() => expect(agentClients.interruptHandoffTarget).toHaveBeenCalledOnce())
    const releasePause = agentClients.pauseRoom.mock.results.at(-1)?.value
    expect(releasePause).not.toHaveBeenCalled()

    const competingClaim = runtimeClients.processHandoffJob({
      id: 'job-admission-race', roomId: 'room-1', chainId: 'chain-admission-race',
      targetAgentId: source.agentId, targetSessionId: source.sessionId,
      depth: 0, kind: 'mention', leaseToken: 'lease-admission-race',
    }, {
      messageId: 'source-admission-race', content: '@Source run', senderName: 'Customer',
      senderId: 'human-1', timestamp: 1, role: 'user',
    })
    await expect(competingClaim).rejects.toMatchObject({ retryWithoutAttempt: true })
    expect(replyToMention).not.toHaveBeenCalled()
    expect(storage.removeAgentActorWithRetention).not.toHaveBeenCalled()

    interrupt.resolve()
    const response = await pending

    expect(response.status).toBe(200)
    expect(storage.removeAgentActorWithRetention).toHaveBeenCalledOnce()
    expect(releasePause).toHaveBeenCalledOnce()
  })

  it('returns conflict without deleting participant state when an affected runtime cannot synchronize', async () => {
    const source = { id: 'row-source-fail', roomId: 'room-1', agentId: 'agent-source-fail', profile: 'default', name: 'Source', sessionId: 'source-session-fail' }
    const successor = { id: 'row-successor-fail', roomId: 'room-1', agentId: 'agent-successor-fail', profile: 'default', name: 'Successor', sessionId: 'successor-session-fail' }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [source, successor])
    storage.beginParticipantRuntimeMutation.mockReturnValueOnce({
      token: 'participant-fence-source',
      roomId: 'room-1',
      actorId: `actor-${source.agentId}`,
      fencedJobs: 1,
      affectedTargets: [{ targetAgentId: successor.agentId, targetSessionId: successor.sessionId }],
    })
    agentClients.interruptHandoffTarget.mockRejectedValueOnce(new Error('runtime still active'))

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${source.id}`, { method: 'DELETE' })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'runtime still active' })
    expect(storage.removeAgentActorWithRetention).not.toHaveBeenCalled()
    expect(storage.getRoomAgents('room-1')).toEqual([source, successor])
    expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith(
      'participant-fence-source', 'room-1', `actor-${source.agentId}`,
    )
    expect(agentClients.pauseRoom.mock.results.at(-1)?.value).toHaveBeenCalledOnce()
  })

  it('returns conflict without deleting a participant whose runtime binding rotates after synchronization starts', async () => {
    const source = { id: 'row-source-race', roomId: 'room-1', agentId: 'agent-source-race', profile: 'default', name: 'Source', sessionId: 'source-session-old' }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [source])
    const interrupt = deferred<void>()
    storage.beginParticipantRuntimeMutation.mockReturnValueOnce({
      token: 'participant-fence-source-race',
      roomId: 'room-1',
      actorId: `actor-${source.agentId}`,
      fencedJobs: 0,
      affectedTargets: [{ targetAgentId: source.agentId, targetSessionId: source.sessionId }],
    })
    agentClients.interruptHandoffTarget.mockReturnValueOnce(interrupt.promise)

    const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${source.id}`, { method: 'DELETE' })
    await vi.waitFor(() => expect(agentClients.interruptHandoffTarget).toHaveBeenCalledWith(
      'room-1', source.agentId, 'source-session-old',
    ))
    source.sessionId = 'source-session-new'
    interrupt.resolve()
    const response = await pending

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/runtime identity changed/i) })
    expect(storage.getRoomAgents('room-1')).toEqual([source])
    expect(agentClients.removeAgentFromRoom).not.toHaveBeenCalled()
    expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith(
      'participant-fence-source-race', 'room-1', `actor-${source.agentId}`,
    )
    expect(agentClients.pauseRoom.mock.results.at(-1)?.value).toHaveBeenCalledOnce()
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
    expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith('room-fence-room-1', 'room-1', '')
  })

  it('does not delete a Room when its participant set changes after runtime synchronization starts', async () => {
    const first = { id: 'row-first', agentId: 'agent-first', profile: 'default', name: 'First', sessionId: 'session-first' }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', ownerAuthUserId: 1 })
    storage.agents.set('room-1', [first])
    const runtimeCleanup = deferred<void>()
    const releaseFence = vi.fn()
    const disconnectRuntime = vi.fn()
    const finalizeRuntime = vi.fn((committed: boolean) => {
      if (committed) disconnectRuntime()
      releaseFence()
    })
    deleteRoomRuntimeState.mockImplementationOnce(async () => {
      await runtimeCleanup.promise
      return finalizeRuntime
    })

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1`, { method: 'DELETE' })
    await vi.waitFor(() => expect(deleteRoomRuntimeState).toHaveBeenCalledOnce())
    storage.agents.set('room-1', [first, {
      id: 'row-late', agentId: 'agent-late', profile: 'default', name: 'Late', sessionId: 'session-late',
    }])
    runtimeCleanup.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/runtime identity changed/i) })
    expect(storage.rooms.has('room-1')).toBe(true)
    expect(finalizeRuntime).toHaveBeenCalledWith(false)
    expect(releaseFence).toHaveBeenCalledOnce()
    expect(disconnectRuntime).not.toHaveBeenCalled()
    expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith('room-fence-room-1', 'room-1', '')
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
    expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith('room-fence-room-1', 'room-1', '')
  })

  it('does not rotate Room context when its participant set changes after runtime synchronization starts', async () => {
    const first = { id: 'row-clear-first', agentId: 'agent-clear-first', profile: 'default', name: 'First', sessionId: 'session-clear-first' }
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99, ownerAuthUserId: 1 })
    storage.agents.set('room-1', [first])
    const runtimeCleanup = deferred<void>()
    const releaseFence = vi.fn()
    const resetRuntime = vi.fn()
    const finalizeRuntime = vi.fn((committed: boolean) => {
      if (committed) resetRuntime()
      releaseFence()
    })
    clearRoomRuntimeState.mockImplementationOnce(async () => {
      await runtimeCleanup.promise
      return finalizeRuntime
    })

    const pendingResponse = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
    await vi.waitFor(() => expect(clearRoomRuntimeState).toHaveBeenCalledOnce())
    storage.agents.set('room-1', [first, {
      id: 'row-clear-late', agentId: 'agent-clear-late', profile: 'default', name: 'Late', sessionId: 'session-clear-late',
    }])
    runtimeCleanup.resolve()
    const response = await pendingResponse

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/runtime identity changed/i) })
    expect(storage.rooms.get('room-1').totalTokens).toBe(99)
    expect(finalizeRuntime).toHaveBeenCalledWith(false)
    expect(releaseFence).toHaveBeenCalledOnce()
    expect(resetRuntime).not.toHaveBeenCalled()
  })

  it('clears room context and runtime state while returning the updated room', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99, sessionSeed: 'old' })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.clearRoomContext).toHaveBeenCalledWith(
      'room-1', expect.objectContaining({ roomId: 'room-1', participants: [] }),
    )
    expect(clearRoomRuntimeState).toHaveBeenCalledWith('room-1', expect.any(Function))
    expect(body).toMatchObject({ success: true, room: { id: 'room-1', totalTokens: 0 } })
    expect(body.room).not.toHaveProperty('sessionSeed')
  })

  it('stops the Room deletion fence heartbeat even when the committed runtime finalizer throws', async () => {
    vi.useFakeTimers()
    try {
      storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
      const finalizeRuntime = vi.fn(() => {
        throw new Error('disconnect finalizer failed')
      })
      deleteRoomRuntimeState.mockResolvedValueOnce(finalizeRuntime)

      const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1`, { method: 'DELETE' })
      await vi.waitFor(() => expect(finalizeRuntime).toHaveBeenCalledWith(true))
      const response = await pending
      expect(response.status).toBe(500)

      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(storage.renewRuntimeMutation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops and releases the clear-context fence even when the committed runtime finalizer throws', async () => {
    vi.useFakeTimers()
    try {
      storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99 })
      const finalizeRuntime = vi.fn(() => {
        throw new Error('reset finalizer failed')
      })
      clearRoomRuntimeState.mockResolvedValueOnce(finalizeRuntime)

      const pending = fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
      await vi.waitFor(() => expect(finalizeRuntime).toHaveBeenCalledWith(true))
      const response = await pending
      expect(response.status).toBe(500)

      expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith('room-fence-room-1', 'room-1', '')
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(storage.renewRuntimeMutation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops and releases the Room deletion fence when an abort finalizer throws', async () => {
    vi.useFakeTimers()
    try {
      const first = { id: 'row-abort-delete', agentId: 'agent-abort-delete', profile: 'default', name: 'First', sessionId: 'session-abort-delete' }
      storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
      storage.agents.set('room-1', [first])
      const finalizeRuntime = vi.fn(() => {
        throw new Error('abort disconnect finalizer failed')
      })
      deleteRoomRuntimeState.mockImplementationOnce(async () => {
        storage.agents.set('room-1', [first, {
          id: 'row-abort-delete-late', agentId: 'agent-abort-delete-late', profile: 'default',
          name: 'Late', sessionId: 'session-abort-delete-late',
        }])
        return finalizeRuntime
      })

      const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1`, { method: 'DELETE' })
      expect(response.status).toBe(500)
      expect(finalizeRuntime).toHaveBeenCalledWith(false)
      expect(storage.rooms.has('room-1')).toBe(true)
      expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith('room-fence-room-1', 'room-1', '')

      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(storage.renewRuntimeMutation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops and releases the clear-context fence when an abort finalizer throws', async () => {
    vi.useFakeTimers()
    try {
      const first = { id: 'row-abort-clear', agentId: 'agent-abort-clear', profile: 'default', name: 'First', sessionId: 'session-abort-clear' }
      storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99 })
      storage.agents.set('room-1', [first])
      const finalizeRuntime = vi.fn(() => {
        throw new Error('abort reset finalizer failed')
      })
      clearRoomRuntimeState.mockImplementationOnce(async () => {
        storage.agents.set('room-1', [first, {
          id: 'row-abort-clear-late', agentId: 'agent-abort-clear-late', profile: 'default',
          name: 'Late', sessionId: 'session-abort-clear-late',
        }])
        return finalizeRuntime
      })

      const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
      expect(response.status).toBe(500)
      expect(finalizeRuntime).toHaveBeenCalledWith(false)
      expect(storage.rooms.get('room-1').totalTokens).toBe(99)
      expect(storage.releaseRuntimeMutation).toHaveBeenCalledWith('room-fence-room-1', 'room-1', '')

      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(storage.renewRuntimeMutation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
