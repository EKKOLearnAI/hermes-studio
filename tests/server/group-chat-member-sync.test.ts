import { describe, expect, it, vi, beforeEach } from 'vitest'

const { socketHandlers, mockSocket, mockIo } = vi.hoisted(() => {
  const socketHandlers = new Map<string, (...args: any[]) => void>()
  const mockSocket: any = {
    id: 'socket-1',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      socketHandlers.set(event, handler)
      if (event === 'connect') queueMicrotask(() => handler())
      return mockSocket
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  }
  const mockIo = vi.fn(() => mockSocket)
  return { socketHandlers, mockSocket, mockIo }
})

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

vi.mock('../../packages/server/src/middleware/user-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/middleware/user-auth')>()
  return {
    ...actual,
    loadActiveAuthenticatedUser: vi.fn((id: number | string) => Number(id) === 2
      ? { id: 2, username: 'ops', role: 'admin', profiles: ['default', 'research'] }
      : { id: Number(id), username: 'root', role: 'super_admin', profiles: [] }),
  }
})

import { AgentClients, groupBridgeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  const handler = layer.stack[0]
  return async (ctx: any, next: () => Promise<void>) => {
    ctx.state ??= { user: { id: 1, username: 'root', role: 'super_admin', profiles: [] } }
    return handler(ctx, next)
  }
}

describe('Group Chat member/agent identity sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    socketHandlers.clear()
  })

  it('does not promote runtime members when canonical actor lookups are unavailable', () => {
    for (const subject of [
      { source: 'agent', userId: 'agent-1', localSubjectId: null },
      { source: 'human', userId: 'local-1', localSubjectId: 'local-subject-1' },
    ]) {
      const server: any = Object.create(GroupChatServer.prototype)
      server.storage = { getRoom: vi.fn(() => ({ id: 'room-1', authorizationRevision: 0 })) }
      server.rooms = new Map([['room-1', {
        getOnlineMemberBySocketId: vi.fn(() => ({
          socketId: 'socket-1',
          userId: subject.userId,
          name: 'Runtime member',
          source: subject.source,
          online: true,
        })),
      }]])
      server.socketRequestedSourceMap = new Map([['socket-1', subject.source]])
      server.socketUserMap = new Map([['socket-1', subject.userId]])
      server.socketLocalSubjectIdMap = new Map(subject.localSubjectId ? [['socket-1', subject.localSubjectId]] : [])

      const decision = server.socketAccessPolicy({ id: 'socket-1', data: {} }, 'room-1')
      expect(decision).toMatchObject({
        canDiscover: false,
        canJoin: false,
        canRead: false,
        canWrite: false,
        canType: false,
        canManage: false,
        canInvokeAgents: false,
        canApprove: false,
      })
    }
  })

  it('uses the persisted group-chat agent id as the runtime agent id and socket user id', async () => {
    const clients = new AgentClients()

    const client = await clients.createAgent({
      agentId: 'agent-stable-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)

    expect(client.agentId).toBe('agent-stable-1')
    expect(mockIo).toHaveBeenCalledWith(
      'http://127.0.0.1:8648/group-chat',
      expect.objectContaining({
        auth: expect.objectContaining({
          token: 'test-token',
          userId: 'agent-stable-1',
          name: 'Worker',
          source: 'agent',
          agentSocketSecret: expect.any(String),
        }),
      }),
    )
  })

  it('passes the same persisted agent id into the runtime client when adding an agent', async () => {
    const calls: string[] = []
    const addRoomAgent = vi.fn((roomId: string, agentId: string, profile: string, name: string, description: string, invited: number) => {
      calls.push('persist-agent')
      return { id: 'row-1', roomId, agentId, profile, name, description, invited }
    })
    const chatServer = {
      getStorage: () => ({
        getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1' })),
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeRoomAgent: vi.fn(),
      }),
      agentClients: {
        createAgent: vi.fn(async () => ({ agentId: 'runtime-agent' })),
        addAgentToRoom: vi.fn(async () => { calls.push('join-room') }),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    const persisted = ctx.body.agent
    expect(persisted.agentId).toBeTruthy()
    expect(calls).toEqual(['persist-agent', 'join-room'])
    expect(chatServer.agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: persisted.agentId,
      profile: 'default',
      name: 'Worker',
    }))
  })

  it('normalizes inherited reasoning and persists a runtime-specific participant avatar', async () => {
    const addRoomAgent = vi.fn((roomId: string, agentId: string, profile: string, name: string, description: string, invited: number, binding: any) => ({
      id: 'row-1', roomId, agentId, profile, name, description, invited, ...binding,
    }))
    const chatServer = {
      getStorage: () => ({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeRoomAgent: vi.fn(),
      }),
      agentClients: {
        createAgent: vi.fn(async ({ agentId }: any) => ({ agentId })),
        addAgentToRoom: vi.fn(async () => {}),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: {
        body: {
          profile: 'default',
          name: 'Codex',
          runtime: 'coding_agent',
          codingAgentId: 'codex',
          provider: 'openai',
          model: 'gpt-test',
          apiMode: 'codex_responses',
          reasoningEffort: 'default',
        },
      },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(addRoomAgent).toHaveBeenCalledWith(
      'room-1',
      expect.any(String),
      'default',
      'Codex',
      '',
      0,
      expect.objectContaining({
        reasoningEffort: '',
        avatar: expect.stringContaining('/coding-agents/codex-openai.png'),
      }),
    )
    expect(ctx.body.agent.reasoningEffort).toBe('')
    expect(ctx.body.agent.avatar).toEqual({
      type: 'asset',
      assetUrl: '/coding-agents/codex-openai.png',
    })
  })

  it('does not persist an agent when the runtime client cannot connect', async () => {
    const addRoomAgent = vi.fn()
    const chatServer = {
      getStorage: () => ({
        getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1' })),
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
      }),
      agentClients: {
        createAgent: vi.fn(async () => {
          throw new Error('Connection timeout')
        }),
        addAgentToRoom: vi.fn(),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'Connection timeout',
    })
    expect(addRoomAgent).not.toHaveBeenCalled()
  })

  it('disconnects a newly created runtime agent when persistence fails before room join', async () => {
    const runtimeClient = { agentId: 'agent-stable-1', disconnect: vi.fn() }
    const addRoomAgent = vi.fn(() => {
      throw new Error('database locked')
    })
    const chatServer = {
      getStorage: () => ({
        getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1' })),
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeRoomAgent: vi.fn(),
      }),
      agentClients: {
        createAgent: vi.fn(async () => runtimeClient),
        addAgentToRoom: vi.fn(),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'database locked',
    })
    expect(chatServer.agentClients.addAgentToRoom).not.toHaveBeenCalled()
    expect(runtimeClient.disconnect).toHaveBeenCalled()
    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
  })

  it('does not leave a persisted agent row and disconnects runtime state when room join fails', async () => {
    const addRoomAgent = vi.fn((roomId: string, agentId: string, profile: string, name: string, description: string, invited: number) => ({ id: 'row-1', roomId, agentId, profile, name, description, invited }))
    const removeAgentActorWithRetention = vi.fn()
    const runtimeClient = { agentId: 'agent-stable-1' }
    const chatServer = {
      getStorage: () => ({
        getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1' })),
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeAgentActorWithRetention,
      }),
      agentClients: {
        createAgent: vi.fn(async () => runtimeClient),
        addAgentToRoom: vi.fn(async () => {
          throw new Error('join failed')
        }),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'join failed',
    })
    expect(addRoomAgent).toHaveBeenCalledWith('room-1', expect.any(String), 'default', 'Worker', '', 0)
    expect(removeAgentActorWithRetention).toHaveBeenCalledWith('room-1', 'row-1')
    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
  })

  it('rolls back AgentClients room state when joining a room fails', async () => {
    const clients = new AgentClients()
    const runtimeClient = {
      agentId: 'agent-stable-1',
      name: 'Worker',
      joinRoom: vi.fn(async () => {
        throw new Error('join failed')
      }),
      disconnect: vi.fn(),
    }

    await expect(clients.addAgentToRoom('room-1', runtimeClient as any)).rejects.toThrow('join failed')

    expect(runtimeClient.disconnect).toHaveBeenCalled()
    expect(clients.getAgents('room-1')).toEqual([])
  })

  it('removes the runtime agent by persisted agentId and returns synchronized room state', async () => {
    const agentsBefore = [{ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker', description: '', invited: 0 }]
    const removal = { agent: agentsBefore[0], actorId: 'actor-1', sessionProfiles: [] }
    const storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1' })),
      getRoomAgent: vi.fn(() => agentsBefore[0]),
      getRoomAgents: vi.fn(() => []),
      removeAgentActorWithRetention: vi.fn(() => removal),
      getRoomMembers: vi.fn(() => [{ id: 'member-1', userId: 'human-1', name: 'Han', description: '', joinedAt: 1 }]),
    }
    const chatServer = {
      getStorage: () => storage,
      agentClients: { removeAgentFromRoom: vi.fn() },
      cleanupRemovedAgentRuntime: vi.fn(async (retained: typeof removal) => {
        chatServer.agentClients.removeAgentFromRoom(retained.agent.roomId, retained.agent.agentId)
      }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1', agentId: 'row-1' },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.removeAgentActorWithRetention).toHaveBeenCalledWith('room-1', 'row-1')
    expect(chatServer.cleanupRemovedAgentRuntime).toHaveBeenCalledWith(removal)
    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
    expect(ctx.body).toEqual({
      success: true,
      agents: [],
      members: [{ id: 'member-1', userId: 'human-1', name: 'Han', description: '', joinedAt: 1 }],
    })
  })

  it('interrupts runtime room state before deleting persisted room data', async () => {
    const calls: string[] = []
    const storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1', ownerAuthUserId: 7 })),
      deleteRoom: vi.fn(() => { calls.push('storage-delete') }),
    }
    const chatServer = {
      getStorage: () => storage,
      deleteRoomRuntimeState: vi.fn(async (_roomId: string, assertAuthorized: () => void) => {
        assertAuthorized()
        calls.push('runtime-delete')
      }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(calls).toEqual(['runtime-delete', 'storage-delete'])
    expect(chatServer.deleteRoomRuntimeState).toHaveBeenCalledWith('room-1', expect.any(Function))
    expect(ctx.body).toEqual({ success: true })
  })

  it('does not delete persisted room data when runtime interrupt does not complete', async () => {
    const storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1', ownerAuthUserId: 7 })),
      deleteRoom: vi.fn(),
    }
    const chatServer = {
      getStorage: () => storage,
      deleteRoomRuntimeState: vi.fn(async () => { throw Object.assign(new Error('still running'), { status: 409 }) }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual({ error: 'still running' })
    expect(storage.deleteRoom).not.toHaveBeenCalled()
  })

  it('interrupts agents before evicting in-memory room sockets so deleted rooms reject late realtime messages', async () => {
    const calls: string[] = []
    const socketsLeave = vi.fn(() => { calls.push('sockets-leave') })
    const saveMessageAndRefreshRoom = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.typingState = new Map([['room-1', new Map([['human-1', { userName: 'Human', timer: setTimeout(() => {}, 1000) }]])]])
    server.contextStatusState = new Map([['room-1', new Map([['Worker', { agentName: 'Worker', status: 'replying' }]])]])
    server.pendingApprovals = new Map()
    server.agentClients = {
      interruptRoom: vi.fn(async () => { calls.push('interrupt') }),
      disconnectRoom: vi.fn(() => { calls.push('disconnect') }),
    }
    server.nsp = {
      in: vi.fn(() => ({ socketsLeave })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    }
    server.storage = { saveMessageAndRefreshRoom }

    await server.deleteRoomRuntimeState('room-1', () => {})
    const ack = vi.fn()
    server.handleMessage({ id: 'socket-1' }, { roomId: 'room-1', content: 'late', role: 'user' }, ack)

    expect(calls).toEqual(['interrupt', 'disconnect', 'sockets-leave'])
    expect(server.rooms.has('room-1')).toBe(false)
    expect(server.agentClients.disconnectRoom).toHaveBeenCalledWith('room-1')
    expect(server.nsp.in).toHaveBeenCalledWith('room-1')
    expect(socketsLeave).toHaveBeenCalledWith('room-1')
    expect(saveMessageAndRefreshRoom).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ error: 'Not in room' })
  })

  it('fails closed before deriving a Bridge session from a weak room seed', () => {
    const server = Object.create(GroupChatServer.prototype) as any
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', sessionSeed: '0' })),
      getRoomAgents: vi.fn(() => ([{
        id: 'row-1',
        roomId: 'room-1',
        agentId: 'agent-1',
        profile: 'default',
        name: 'Worker',
      }])),
      findActiveActorByAgentIdentity: vi.fn(() => null),
    }

    expect(() => server.fenceCurrentRoomAgentSessions('room-1')).toThrow(/cryptographic session seed/i)
  })

  it('rejects stale agent context and stream side-channel events after session rotation', () => {
    const broadcastEmit = vi.fn()
    const roomEmit = vi.fn()
    const updateRoomTotalTokens = vi.fn()
    const getActorCapabilities = vi.fn((): string[] => ['room.read', 'room.write'])
    const agentActor = {
      id: 'actor-agent-1',
      roomId: 'room-1',
      actorType: 'agent',
      active: 1,
      authUserId: null,
      agentId: 'agent-stable-1',
      localSubjectId: null,
      systemKey: null,
      name: 'Worker',
      description: '',
      avatar: '',
      authorizationRevision: 0,
      contextRevision: 0,
      tombstonedAt: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const agentMember = {
      id: 'agent-socket-1',
      userId: 'agent-stable-1',
      name: 'Worker',
      description: '',
      joinedAt: Date.now(),
      online: true,
      socketId: 'agent-socket-1',
      source: 'agent',
      avatar: '',
    }
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map([['room-1', {
      getOnlineMemberBySocketId: vi.fn(() => agentMember),
    }]])
    server.socketUserMap = new Map([['agent-socket-1', 'agent-stable-1']])
    server.socketRequestedSourceMap = new Map([['agent-socket-1', 'agent']])
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: '22222222222222222222222222222222', authorizationRevision: 0 })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker' })),
      findActiveActorByAgentIdentity: vi.fn(() => agentActor),
      getActorCapabilities,
      getRoomsForProfiles: vi.fn(() => []),
      updateRoomTotalTokens,
    }
    server.nsp = { to: vi.fn(() => ({ emit: broadcastEmit })) }
    server.emitToRoomReaders = vi.fn((_roomId: string, event: string, payload: unknown, excludeSocketId?: string) => {
      ;(excludeSocketId ? roomEmit : broadcastEmit)(event, payload)
    })
    const socket = { id: 'agent-socket-1', data: {}, to: vi.fn(() => ({ emit: roomEmit })) }
    const sessionIdentity = {
      actorId: agentActor.id,
      roomAuthorizationRevision: 0,
      actorAuthorizationRevision: 0,
      actorContextRevision: 0,
    }
    const staleSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', '11111111111111111111111111111111', sessionIdentity)
    const currentSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', '22222222222222222222222222222222', sessionIdentity)

    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      totalTokens: 123,
      agentSessionId: staleSessionId,
    })
    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'late-stream',
      agentSessionId: staleSessionId,
    })

    expect(updateRoomTotalTokens).not.toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
    expect(broadcastEmit).not.toHaveBeenCalled()
    expect(server.contextStatusState.size).toBe(0)

    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      totalTokens: 456,
      agentSessionId: currentSessionId,
    })
    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'current-stream',
      agentSessionId: currentSessionId,
    })

    expect(updateRoomTotalTokens).toHaveBeenCalledWith('room-1', 456)
    expect(roomEmit).toHaveBeenCalledWith('context_status', expect.objectContaining({ roomId: 'room-1', agentName: 'Worker', status: 'replying' }))
    expect(broadcastEmit).toHaveBeenCalledWith('room_updated', { roomId: 'room-1', totalTokens: 456 })
    expect(broadcastEmit).toHaveBeenCalledWith('message_stream_start', expect.objectContaining({ id: 'current-stream', senderName: 'Worker' }))

    getActorCapabilities.mockReturnValue([])
    expect(server.socketAccessPolicy(socket, 'room-1').canWrite).toBe(false)
    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'ready',
      totalTokens: 789,
      agentSessionId: currentSessionId,
    })
    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'revoked-stream',
      agentSessionId: currentSessionId,
    })

    expect(updateRoomTotalTokens).not.toHaveBeenCalledWith('room-1', 789)
    expect(roomEmit).not.toHaveBeenCalledWith('context_status', expect.objectContaining({ status: 'ready' }))
    expect(broadcastEmit).not.toHaveBeenCalledWith('message_stream_start', expect.objectContaining({ id: 'revoked-stream' }))
  })

  it('uses the persisted participant session as the authority for runtime events', () => {
    const broadcastEmit = vi.fn()
    const roomEmit = vi.fn()
    const updateRoomTotalTokens = vi.fn()
    const member = {
      id: 'agent-socket-1',
      userId: 'participant-1',
      name: 'Codex A',
      description: '',
      joinedAt: Date.now(),
      online: true,
      socketId: 'agent-socket-1',
      source: 'agent',
      avatar: '',
    }
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map([['room-1', { getOnlineMemberBySocketId: vi.fn(() => member) }]])
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', sessionSeed: 'legacy-seed' })),
      getRoomAgentByAgentId: vi.fn(() => ({
        id: 'row-1',
        roomId: 'room-1',
        agentId: 'participant-1',
        profile: 'default',
        name: 'Codex A',
        runtime: 'coding_agent',
        sessionId: 'participant-session-2',
      })),
      updateRoomTotalTokens,
    }
    server.nsp = { to: vi.fn(() => ({ emit: broadcastEmit })) }
    const socket = { id: 'agent-socket-1', to: vi.fn(() => ({ emit: roomEmit })) }

    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Codex A',
      status: 'replying',
      totalTokens: 111,
      agentSessionId: groupBridgeSessionId('room-1', 'default', 'Codex A', 'legacy-seed'),
    })
    expect(updateRoomTotalTokens).not.toHaveBeenCalled()

    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Codex A',
      status: 'replying',
      totalTokens: 222,
      agentSessionId: 'participant-session-2',
    })
    expect(updateRoomTotalTokens).toHaveBeenCalledWith('room-1', 222)
    expect(roomEmit).toHaveBeenCalledWith('context_status', expect.objectContaining({ agentName: 'Codex A' }))
  })

  it('does not drop queued mentions when room interrupt is not synchronized', async () => {
    const clients = new AgentClients() as any
    const agent = { name: 'Worker', interrupt: vi.fn(async () => false) }
    clients.rooms = new Map([['room-1', new Map([['agent-stable-1', agent]])]])
    clients._mentionQueue = new Map([
      ['room-1', [{ agent, msg: { content: '@Worker one', senderName: 'Han', senderId: 'user-1', timestamp: 1 } }]],
      ['room-1:Worker', [{ agent, msg: { content: '@Worker two', senderName: 'Han', senderId: 'user-1', timestamp: 2 } }]],
    ])

    await expect(clients.interruptRoom('room-1')).rejects.toMatchObject({ status: 409 })

    expect(clients._mentionQueue.has('room-1')).toBe(true)
    expect(clients._mentionQueue.has('room-1:Worker')).toBe(true)
  })

  it('rejects stale agent assistant/tool messages at persistence time after session rotation', () => {
    const emit = vi.fn()
    const saveMessageAndRefreshRoom = vi.fn()
    const agentMember = {
      id: 'agent-socket-1',
      userId: 'agent-stable-1',
      name: 'Worker',
      description: '',
      joinedAt: Date.now(),
      online: true,
      socketId: 'agent-socket-1',
      source: 'agent',
      avatar: '',
    }
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map([['room-1', {
      hasOnlineMember: vi.fn(() => true),
      getOnlineMemberBySocketId: vi.fn(() => agentMember),
    }]])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: '22222222222222222222222222222222' })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker' })),
      saveMessageAndRefreshRoom,
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const ack = vi.fn()
    const staleSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', '11111111111111111111111111111111')

    server.handleMessage({ id: 'agent-socket-1' }, {
      roomId: 'room-1',
      content: 'late',
      role: 'assistant',
      agentSessionId: staleSessionId,
    }, ack)

    expect(ack).toHaveBeenCalledWith({ error: 'Stale room session' })
    expect(saveMessageAndRefreshRoom).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('fences persisted participant sessions before clearing runtime state', async () => {
    const server = Object.create(GroupChatServer.prototype) as any
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.fencedRoomAgentSessions = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', sessionSeed: 'seed-1' })),
      getRoomAgents: vi.fn(() => [
        {
          agentId: 'agent-1',
          profile: 'default',
          name: 'Worker',
          sessionId: 'gc_room-1_agent-1_2',
        },
      ]),
    }
    server.agentClients = {
      interruptRoom: vi.fn(async () => {
        expect(server.fencedRoomAgentSessions.get('room-1')).toContain('gc_room-1_agent-1_2')
      }),
      resetRoomContext: vi.fn(),
    }
    server.nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }

    await server.clearRoomRuntimeState('room-1')
  })

  it('clears runtime state before rotating persisted room context', async () => {
    const calls: string[] = []
    const room = { id: 'room-1', name: 'Room 1', inviteCode: 'invite', ownerAuthUserId: 7, workspace: '/tmp/workspace' }
    const storage = {
      getRoom: vi.fn(() => room),
      clearRoomContext: vi.fn(() => { calls.push('storage-clear') }),
    }
    const chatServer = {
      getStorage: () => storage,
      clearRoomRuntimeState: vi.fn(async (_roomId: string, assertAuthorized: () => void) => {
        assertAuthorized()
        calls.push('runtime-clear')
      }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/clear-context', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(calls).toEqual(['runtime-clear', 'storage-clear'])
    expect(chatServer.clearRoomRuntimeState).toHaveBeenCalledWith('room-1', expect.any(Function))
    expect(ctx.body).toEqual({ success: true, room: expect.objectContaining({ id: 'room-1', workspace: '/tmp/workspace' }) })
  })

  it('does not clear persisted context when runtime interrupt does not complete', async () => {
    const room = { id: 'room-1', name: 'Room 1', inviteCode: 'invite', ownerAuthUserId: 7, workspace: '/tmp/workspace' }
    const storage = {
      getRoom: vi.fn(() => room),
      clearRoomContext: vi.fn(),
    }
    const chatServer = {
      getStorage: () => storage,
      clearRoomRuntimeState: vi.fn(async () => { throw Object.assign(new Error('still running'), { status: 409 }) }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/clear-context', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual({ error: 'still running' })
    expect(storage.clearRoomContext).not.toHaveBeenCalled()
  })

  it('rejects authenticated Socket.IO room joins without invite, membership, owner, or profile scope', () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      admitHumanMember: vi.fn(() => ({ status: 'not_found' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    server.currentAuthenticatedSocketUser = vi.fn(() => ({ id: 42, username: 'alice', role: 'admin', profiles: ['other'] }))
    const socket = {
      id: 'socket-1',
      data: {},
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.storage.admitHumanMember).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      userId: 'auth:42',
      inviteCode: undefined,
    }))
    expect(ack).toHaveBeenCalledWith({ error: 'Room not found' })
    expect(socket.join).not.toHaveBeenCalled()
  })

  it('denies read-only room members realtime management actions', async () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', ownerAuthUserId: 7, inviteCode: 'secret' })),
      getRoomsForProfiles: vi.fn(() => []),
    }
    server.agentClients = { interruptAgent: vi.fn() }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    server.removeUnauthorizedRoomSocket = vi.fn()
    server.currentAuthenticatedSocketUser = vi.fn(() => ({ id: 42, username: 'member', role: 'admin', profiles: ['other'] }))
    const socket = {
      id: 'socket-1',
      data: {},
    }
    const interruptAck = vi.fn()
    const approvalAck = vi.fn()

    await server.handleInterruptAgent(socket, { roomId: 'room-1', agentName: 'Worker' }, interruptAck)
    await server.handleApprovalRespond(socket, { roomId: 'room-1', approval_id: 'approval-1', choice: 'once' }, approvalAck)

    expect(interruptAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(approvalAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.removeUnauthorizedRoomSocket).toHaveBeenCalledWith(socket, 'room-1')
    expect(server.agentClients.interruptAgent).not.toHaveBeenCalled()
  })

  it('denies runtime agent sockets realtime management actions even after they join the room', async () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.socketRequestedSourceMap = new Map([['agent-socket', 'agent']])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', ownerAuthUserId: 7, inviteCode: 'secret' })),
      getRoomsForProfiles: vi.fn(() => []),
    }
    server.agentClients = { interruptAgent: vi.fn() }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    server.removeUnauthorizedRoomSocket = vi.fn()
    const socket = { id: 'agent-socket', data: {} }
    const interruptAck = vi.fn()
    const approvalAck = vi.fn()

    await server.handleInterruptAgent(socket, { roomId: 'room-1', agentName: 'Worker' }, interruptAck)
    await server.handleApprovalRespond(socket, { roomId: 'room-1', approval_id: 'approval-1', choice: 'once' }, approvalAck)

    expect(interruptAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(approvalAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.removeUnauthorizedRoomSocket).toHaveBeenCalledWith(socket, 'room-1')
    expect(server.agentClients.interruptAgent).not.toHaveBeenCalled()
  })

  it('requires a persisted read grant before pre-persisted agent sockets can join', () => {
    const getActorCapabilities = vi.fn((): string[] => [])
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-agent', 'agent-stable-1']])
    server.socketRequestedSourceMap = new Map([['socket-agent', 'agent']])
    server.socketAuthUserIdMap = new Map()
    server.userInfoMap = new Map([['agent-stable-1', { name: 'Worker', description: 'runtime agent' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: 'secret', ownerAuthUserId: 7 })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker', description: '', invited: 0 })),
      findActiveActorByAgentIdentity: vi.fn(() => ({
        id: 'actor-agent-1', roomId: 'room-1', actorType: 'agent', active: 1,
        authUserId: null, agentId: 'agent-stable-1', localSubjectId: null, systemKey: null,
        name: 'Worker', description: '', avatar: '', authorizationRevision: 0,
        contextRevision: 0, tombstonedAt: null, createdAt: 1, updatedAt: 1,
      })),
      getActorCapabilities,
      getRoomsForProfiles: vi.fn(() => []),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-agent',
      data: {},
      join: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)
    expect(ack).toHaveBeenLastCalledWith({ error: 'Room not found' })
    expect(socket.join).not.toHaveBeenCalled()

    getActorCapabilities.mockReturnValue(['room.read'])
    ack.mockClear()
    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.storage.getRoomAgentByAgentId).toHaveBeenCalledWith('room-1', 'agent-stable-1')
    expect(server.storage.addRoomMember).not.toHaveBeenCalled()
    expect(socket.join).toHaveBeenCalledWith('room-1')
    expect(ack.mock.calls[0][0]).toEqual(expect.objectContaining({ roomId: 'room-1', messages: [], agents: [] }))
  })

  it('allows Socket.IO room joins with the matching invite code and then persists membership', () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: 'secret', ownerAuthUserId: 7 })),
      admitHumanMember: vi.fn(() => ({
        status: 'admitted',
        room: { id: 'room-1', name: 'Room', inviteCode: 'secret', inviteGeneration: 0, ownerAuthUserId: 7 },
        userName: 'alice',
        description: '',
        avatar: '',
      })),
      getRoomAgentByAgentId: vi.fn(() => null),
      findActiveActorByAuthUserId: vi.fn(() => ({
        id: 'actor-human-42', roomId: 'room-1', actorType: 'authenticated_human', active: 1,
        authUserId: 42, agentId: null, localSubjectId: null, systemKey: null,
        name: 'alice', description: '', avatar: '', authorizationRevision: 0,
        contextRevision: 0, tombstonedAt: null, createdAt: 1, updatedAt: 1,
      })),
      getActorCapabilities: vi.fn(() => ['room.read']),
      getRoomsForProfiles: vi.fn(() => []),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    server.currentAuthenticatedSocketUser = vi.fn(() => ({ id: 42, username: 'alice', role: 'admin', profiles: ['other'] }))
    const socket = {
      id: 'socket-1',
      data: {},
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1', inviteCode: 'secret' }, ack)

    expect(server.storage.admitHumanMember).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      userId: 'auth:42',
      inviteCode: 'secret',
      requestedName: 'alice',
    }))
    expect(socket.join).toHaveBeenCalledWith('room-1')
    expect(ack.mock.calls[0][0]).toEqual(expect.objectContaining({ roomId: 'room-1', messages: [], agents: [] }))
  })

  it('reuses an authenticated member name when the browser has no local group-chat name', () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice-login', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: 'secret', ownerAuthUserId: 7 })),
      admitHumanMember: vi.fn(() => ({
        status: 'admitted',
        room: { id: 'room-1', name: 'Room', inviteCode: 'secret', inviteGeneration: 0, ownerAuthUserId: 7 },
        userName: 'Alice Display',
        description: 'saved description',
        avatar: '',
      })),
      getRoomAgentByAgentId: vi.fn(() => null),
      findActiveActorByAuthUserId: vi.fn(() => ({
        id: 'actor-human-42', roomId: 'room-1', actorType: 'authenticated_human', active: 1,
        authUserId: 42, agentId: null, localSubjectId: null, systemKey: null,
        name: 'Alice Display', description: 'saved description', avatar: '', authorizationRevision: 0,
        contextRevision: 0, tombstonedAt: null, createdAt: 1, updatedAt: 1,
      })),
      getActorCapabilities: vi.fn(() => ['room.read']),
      getRoomsForProfiles: vi.fn(() => []),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    server.currentAuthenticatedSocketUser = vi.fn(() => ({ id: 42, username: 'alice-login', role: 'admin', profiles: ['other'] }))
    const socket = {
      id: 'socket-1',
      data: {},
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.storage.admitHumanMember).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      userId: 'auth:42',
      requestedName: 'alice-login',
      requestedDescription: '',
    }))
    expect(ack.mock.calls[0][0].members).toEqual([
      expect.objectContaining({ userId: 'auth:42', name: 'Alice Display' }),
    ])
  })

  it('persists the room creator profile from the create form before realtime join', async () => {
    const addRoomMember = vi.fn()
    const storage = {
      setRoomOwnerAuthUserId: vi.fn(),
      addRoomMember,
      saveRoom: vi.fn(),
      getRoom: vi.fn((roomId: string) => ({
        id: roomId,
        name: 'Family Room',
        inviteCode: 'secret',
        ownerAuthUserId: 42,
      })),
    }
    setGroupChatServer({
      getStorage: () => storage,
      agentClients: {},
    } as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const ctx: any = {
      state: { user: { id: 42, username: 'alice-login', role: 'admin' } },
      request: {
        body: {
          name: 'Family Room',
          inviteCode: 'secret',
          memberName: '妈妈',
          memberDescription: 'family profile',
        },
      },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(addRoomMember).toHaveBeenCalledWith(
      expect.any(String),
      'auth:42',
      '妈妈',
      'family profile',
      '',
      42,
    )
    expect(ctx.body.room).toEqual(expect.objectContaining({ name: 'Family Room' }))
  })

  it('updates an explicitly requested human profile only in the joined room', () => {
    const emit = vi.fn()
    const liveMember: any = {
      id: 'socket-1',
      userId: 'auth:42',
      name: 'alice-login',
      description: '',
      source: 'human',
      avatar: 'avatar-data',
      online: true,
      socketId: 'socket-1',
    }
    const room = {
      getOnlineMemberBySocketId: vi.fn(() => liveMember),
      addOrUpdateMember: vi.fn((
        _socketId: string,
        _userId: string,
        name: string,
        description: string,
      ) => {
        liveMember.name = name
        liveMember.description = description
        return liveMember
      }),
      getMembersList: vi.fn(() => [liveMember]),
    }
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map([['room-family', room]])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice-login', description: '' }]])
    server.storage = { addRoomMember: vi.fn() }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const socket = { id: 'socket-1' }
    const ack = vi.fn()

    server.handleUpdateMemberProfile(socket, {
      roomId: 'room-family',
      name: '妈妈',
      description: 'family profile',
    }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-family',
      'auth:42',
      '妈妈',
      'family profile',
      'avatar-data',
      42,
    )
    expect(server.userInfoMap.get('auth:42')).toEqual({
      name: '妈妈',
      description: 'family profile',
    })
    expect(emit).toHaveBeenCalledWith('member_updated', expect.objectContaining({
      roomId: 'room-family',
      memberName: '妈妈',
    }))
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      member: expect.objectContaining({ name: '妈妈' }),
    }))
  })

  it('does not expose rooms to regular admins solely because an agent profile matches', async () => {
    const allRooms = [
      { id: 'room-default', name: 'Default', inviteCode: null },
      { id: 'room-private', name: 'Private', inviteCode: null },
    ]
    const storage = {
      getAllRooms: vi.fn(() => allRooms),
      getRoom: vi.fn((roomId: string) => allRooms.find(room => room.id === roomId) || null),
      getRoomAgents: vi.fn((roomId: string) => roomId === 'room-default'
        ? [{ profile: 'default' }]
        : [{ profile: 'private' }]),
      getRoomsForProfiles: vi.fn(() => [allRooms[0]]),
      findActiveActorByAuthUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      getActorCapabilities: vi.fn(() => []),
    }
    setGroupChatServer({ getStorage: () => storage } as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms', 'GET')
    const ctx: any = {
      state: { user: { id: 2, username: 'ops', role: 'admin', profiles: ['default', 'research'] } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.getAllRooms).toHaveBeenCalledOnce()
    expect(storage.getRoomsForProfiles).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ rooms: [] })
  })

  it('keeps room list unrestricted for super admins', async () => {
    const rooms = [{ id: 'room-1', name: 'All', inviteCode: null }]
    const storage = {
      getAllRooms: vi.fn(() => rooms),
      getRoom: vi.fn((roomId: string) => rooms.find(room => room.id === roomId) || null),
      getRoomsForProfiles: vi.fn(() => []),
    }
    setGroupChatServer({ getStorage: () => storage } as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms', 'GET')
    const ctx: any = {
      state: { user: { id: 1, username: 'admin', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.getAllRooms).toHaveBeenCalledOnce()
    expect(storage.getRoomsForProfiles).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ rooms: [expect.objectContaining({ id: 'room-1', inviteCode: null, canManage: true })] })
  })

  it('rejects an oversized human message before persistence or mention routing', () => {
    const server = Object.create(GroupChatServer.prototype) as any
    const saveMessageAndRefreshRoom = vi.fn()
    const processMentions = vi.fn()
    server.rooms = new Map([['room-1', {
      hasOnlineMember: vi.fn(() => true),
      getOnlineMemberBySocketId: vi.fn(() => ({ userId: 'human-1', name: 'Human', source: 'human' })),
    }]])
    server.socketUserMap = new Map([['human-socket', 'human-1']])
    server.socketRequestedSourceMap = new Map([['human-socket', 'human']])
    server.userInfoMap = new Map([['human-1', { name: 'Human', description: '' }]])
    server.agentClients = {
      validateMessageInput: vi.fn(() => ({
        ok: false,
        error: 'Message exceeds the safe input limit for @Worker (9600 tokens). Upload a file or split the message.',
      })),
      processMentions,
    }
    server.storage = { saveMessageAndRefreshRoom }
    server.nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const ack = vi.fn()

    server.handleMessage({ id: 'human-socket' }, {
      roomId: 'room-1', content: `@Worker ${'x'.repeat(50_000)}`, role: 'user',
    }, ack)

    expect(ack).toHaveBeenCalledWith({
      error: 'Message exceeds the safe input limit for @Worker (9600 tokens). Upload a file or split the message.',
    })
    expect(saveMessageAndRefreshRoom).not.toHaveBeenCalled()
    expect(processMentions).not.toHaveBeenCalled()
  })

  it('does not use the legacy in-memory mention path for persisted messages', () => {
    const server = Object.create(GroupChatServer.prototype) as any
    const emit = vi.fn()
    server.rooms = new Map([
      ['room-1', {
        hasOnlineMember: vi.fn(() => true),
        getOnlineMemberBySocketId: vi.fn((socketId: string) => socketId === 'agent-socket'
          ? { userId: 'agent-1', name: '丫鬟', source: 'agent' }
          : { userId: 'human-1', name: 'Human', source: 'human' }),
      }],
    ])
    server.socketUserMap = new Map([
      ['human-socket', 'human-1'],
      ['agent-socket', 'agent-1'],
    ])
    server.socketRequestedSourceMap = new Map([
      ['human-socket', 'human'],
      ['agent-socket', 'agent'],
    ])
    server.socketLocalSubjectIdMap = new Map([
      ['human-socket', 'local-subject-1'],
    ])
    server.userInfoMap = new Map([
      ['human-1', { name: 'Human', description: '' }],
      ['agent-1', { name: '丫鬟', description: '' }],
    ])
    server.agentClients = { processMentions: vi.fn(async () => undefined) }
    const agentSessionId = groupBridgeSessionId(
      'room-1',
      'default',
      '丫鬟',
      '11111111111111111111111111111111',
      {
        actorId: 'actor-agent-1',
        roomAuthorizationRevision: 0,
        actorAuthorizationRevision: 0,
        actorContextRevision: 0,
      },
    )
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: '11111111111111111111111111111111', authorizationRevision: 0 })),
      findActiveActorByLocalSubjectId: vi.fn(() => ({
        id: 'actor-human-1',
        roomId: 'room-1',
        actorType: 'local',
        localSubjectId: 'local-subject-1',
        active: true,
        authorizationRevision: 0,
        contextRevision: 0,
      })),
      findActiveActorByAgentIdentity: vi.fn(() => ({
        id: 'actor-agent-1',
        roomId: 'room-1',
        actorType: 'agent',
        agentId: 'agent-1',
        active: true,
        authorizationRevision: 0,
        contextRevision: 0,
      })),
      getActorCapabilities: vi.fn(() => ['room.read', 'room.write', 'agent.invoke']),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: '丫鬟' })),
      saveMessageAndRefreshRoom: vi.fn((msg: any) => ({ message: msg, totalTokens: 123 })),
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    server.scheduleHandoffDispatch = vi.fn()

    server.handleMessage({ id: 'human-socket' }, { roomId: 'room-1', content: '@all hi', role: 'user' }, vi.fn())

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, { roomId: 'room-1', content: '@all agent says hi', role: 'assistant', mentionDepth: 1, agentSessionId }, vi.fn())
    expect(server.agentClients.processMentions).toHaveBeenCalledTimes(1)
    expect(server.agentClients.processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      content: '@all agent says hi',
      senderId: 'agent-1',
      mentionDepth: 1,
    }))

    server.agentClients.processMentions.mockClear()
    server.storage.getActorCapabilities.mockReturnValue(['room.read', 'room.write'])
    server.handleMessage({ id: 'agent-socket' }, {
      roomId: 'room-1',
      content: '@all no invoke authority',
      role: 'assistant',
      mentionDepth: 1,
      agentSessionId,
    }, vi.fn())
    expect(server.agentClients.processMentions).not.toHaveBeenCalled()

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, { roomId: 'room-1', content: '@all too deep', role: 'assistant', mentionDepth: 4, agentSessionId }, vi.fn())
    expect(server.agentClients.processMentions).not.toHaveBeenCalled()
    expect(server.storage.saveMessageAndRefreshRoom).toHaveBeenCalledWith(
      expect.objectContaining({ content: '@all hi' }),
      expect.objectContaining({ handoffs: [] }),
    )
  })

  it('preserves per-room member name on rejoin when global userInfoMap has a different name', () => {
    // Reproduces hermes-agent #54774 / hermes-studio per-room member name bug:
    // switching rooms should not overwrite a member's per-room display name.
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    // User joined room B last, so global userInfoMap has "郑工" (work name).
    // But room A's DB record has "爸爸" (family name).
    server.userInfoMap = new Map([['auth:42', { name: '郑工', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Family Room', inviteCode: 'secret' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      // Room A's existing DB record has "爸爸" (per-room name)
      getMemberByUserId: vi.fn(() => ({
        id: 'member-1',
        userId: 'auth:42',
        name: '爸爸',
        description: 'family persona',
        joinedAt: 1000,
        avatar: '',
        authUserId: 42,
      })),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    // Per-room DB name ("爸爸") must be preserved, NOT overwritten by
    // the global userInfoMap entry ("郑工").
    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-1',
      'auth:42',
      '爸爸',
      'family persona',
      expect.any(String),
      42,
    )
  })

  it('uses requestedName on first join when no existing member record exists', () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'default-name', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-2', name: 'Work Room', inviteCode: 'work123' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null), // no existing member → first join
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    // Client passes name from the create-room form, plus invite code to pass
    // canSocketJoinRoom gate.
    server.handleJoin(socket, {
      roomId: 'room-2',
      inviteCode: 'work123',
      name: '郑工',
      description: 'work persona',
    }, ack)

    // On first join, requestedName is used
    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-2',
      'auth:42',
      '郑工',
      'work persona',
      expect.any(String),
      42,
    )
  })

  it('preserves per-room member description on rejoin when global userInfoMap has stale description', () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', {
      name: 'global-stale-name',
      description: 'global-stale-desc',
    }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => ({
        id: 'member-1',
        userId: 'auth:42',
        name: '爸爸',
        description: 'per-room-family-desc',
        joinedAt: 1000,
        avatar: '',
        authUserId: 42,
      })),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-1',
      'auth:42',
      '爸爸',
      'per-room-family-desc',
      expect.any(String),
      42,
    )
  })

})
