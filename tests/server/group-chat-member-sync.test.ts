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

import { AgentClients, groupBridgeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

describe('Group Chat member/agent identity sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    socketHandlers.clear()
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

  it('does not persist an agent when the runtime client cannot connect', async () => {
    const addRoomAgent = vi.fn()
    const chatServer = {
      getStorage: () => ({
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
    const removeRoomAgent = vi.fn()
    const runtimeClient = { agentId: 'agent-stable-1' }
    const chatServer = {
      getStorage: () => ({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeRoomAgent,
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
    expect(removeRoomAgent).toHaveBeenCalledWith('room-1', 'row-1')
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
    const storage = {
      getRoomAgent: vi.fn(() => agentsBefore[0]),
      getRoomAgents: vi.fn(() => []),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn(),
      getRoomMembers: vi.fn(() => [{ id: 'member-1', userId: 'human-1', name: 'Han', description: '', joinedAt: 1 }]),
    }
    const chatServer = {
      getStorage: () => storage,
      agentClients: { removeAgentFromRoom: vi.fn() },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1', agentId: 'row-1' },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
    expect(storage.removeRoomMembersForAgent).toHaveBeenCalledWith('room-1', agentsBefore[0])
    expect(storage.removeRoomAgent).toHaveBeenCalledWith('room-1', 'row-1')
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
      deleteRoomRuntimeState: vi.fn(async () => { calls.push('runtime-delete') }),
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
    expect(chatServer.deleteRoomRuntimeState).toHaveBeenCalledWith('room-1')
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
    server.agentClients = {
      interruptRoom: vi.fn(async () => { calls.push('interrupt') }),
      disconnectRoom: vi.fn(() => { calls.push('disconnect') }),
    }
    server.nsp = {
      in: vi.fn(() => ({ socketsLeave })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    }
    server.storage = { saveMessageAndRefreshRoom }

    await server.deleteRoomRuntimeState('room-1')
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

  it('rejects stale agent context and stream side-channel events after session rotation', () => {
    const broadcastEmit = vi.fn()
    const roomEmit = vi.fn()
    const updateRoomTotalTokens = vi.fn()
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
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-2' })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker' })),
      updateRoomTotalTokens,
    }
    server.nsp = { to: vi.fn(() => ({ emit: broadcastEmit })) }
    const socket = { id: 'agent-socket-1', to: vi.fn(() => ({ emit: roomEmit })) }
    const staleSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-1')
    const currentSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-2')

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
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-2' })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker' })),
      saveMessageAndRefreshRoom,
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const ack = vi.fn()
    const staleSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-1')

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

  it('clears runtime state before rotating persisted room context', async () => {
    const calls: string[] = []
    const room = { id: 'room-1', name: 'Room 1', inviteCode: 'invite', ownerAuthUserId: 7, workspace: '/tmp/workspace' }
    const storage = {
      getRoom: vi.fn(() => room),
      clearRoomContext: vi.fn(() => { calls.push('storage-clear') }),
    }
    const chatServer = {
      getStorage: () => storage,
      clearRoomRuntimeState: vi.fn(async () => { calls.push('runtime-clear') }),
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
    expect(chatServer.clearRoomRuntimeState).toHaveBeenCalledWith('room-1')
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
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: 'secret', ownerAuthUserId: 7 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'alice', role: 'admin', profiles: ['other'] } },
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(ack).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.storage.addRoomMember).not.toHaveBeenCalled()
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
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'member', role: 'admin', profiles: ['other'] } },
    }
    const interruptAck = vi.fn()
    const approvalAck = vi.fn()

    await server.handleInterruptAgent(socket, { roomId: 'room-1', agentName: 'Worker' }, interruptAck)
    await server.handleApprovalRespond(socket, { roomId: 'room-1', approval_id: 'approval-1', choice: 'once' }, approvalAck)

    expect(interruptAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(approvalAck).toHaveBeenCalledWith({ error: 'Access denied' })
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
    const socket = { id: 'agent-socket', data: {} }
    const interruptAck = vi.fn()
    const approvalAck = vi.fn()

    await server.handleInterruptAgent(socket, { roomId: 'room-1', agentName: 'Worker' }, interruptAck)
    await server.handleApprovalRespond(socket, { roomId: 'room-1', approval_id: 'approval-1', choice: 'once' }, approvalAck)

    expect(interruptAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(approvalAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.agentClients.interruptAgent).not.toHaveBeenCalled()
  })

  it('allows pre-persisted agent sockets to join without creating human membership', () => {
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
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'alice', role: 'admin', profiles: ['other'] } },
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1', inviteCode: 'secret' }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith('room-1', 'auth:42', 'alice', '', expect.any(String), 42)
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
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => ({
        id: 'member-old',
        userId: 'browser-local-id',
        name: 'Alice Display',
        description: 'saved description',
        joinedAt: 1,
        avatar: '',
        authUserId: 42,
      })),
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
      'Alice Display',
      'saved description',
      '',
      42,
    )
    expect(ack.mock.calls[0][0].members).toEqual([
      expect.objectContaining({ userId: 'auth:42', name: 'Alice Display' }),
    ])
  })

  it('filters room list to rooms containing one of the regular admin profiles', async () => {
    const allRooms = [
      { id: 'room-default', name: 'Default', inviteCode: null },
      { id: 'room-private', name: 'Private', inviteCode: null },
    ]
    const visibleRooms = [allRooms[0]]
    const storage = {
      getAllRooms: vi.fn(() => allRooms),
      getRoomsForProfiles: vi.fn(() => visibleRooms),
    }
    setGroupChatServer({ getStorage: () => storage } as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms', 'GET')
    const ctx: any = {
      state: { user: { id: 2, username: 'ops', role: 'admin', profiles: ['default', 'research'] } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.getRoomsForProfiles).toHaveBeenCalledWith(['default', 'research'])
    expect(storage.getAllRooms).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ rooms: [expect.objectContaining({ id: 'room-default', inviteCode: null, canManage: true })] })
  })

  it('keeps room list unrestricted for super admins', async () => {
    const rooms = [{ id: 'room-1', name: 'All', inviteCode: null }]
    const storage = {
      getAllRooms: vi.fn(() => rooms),
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

  it('routes @mentions from users and bounded agent replies', () => {
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
    server.userInfoMap = new Map([
      ['human-1', { name: 'Human', description: '' }],
      ['agent-1', { name: '丫鬟', description: '' }],
    ])
    server.agentClients = { processMentions: vi.fn(async () => undefined) }
    const agentSessionId = groupBridgeSessionId('room-1', 'default', '丫鬟', 'seed-1')
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-1' })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: '丫鬟' })),
      saveMessageAndRefreshRoom: vi.fn((msg: any) => ({ message: msg, totalTokens: 123 })),
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }

    server.handleMessage({ id: 'human-socket' }, { roomId: 'room-1', content: '@all hi', role: 'user' }, vi.fn())
    expect(server.agentClients.processMentions).toHaveBeenCalledTimes(1)
    expect(server.agentClients.processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      content: '@all hi',
      senderId: 'human-1',
      mentionDepth: 0,
    }))

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, { roomId: 'room-1', content: '@all agent says hi', role: 'assistant', mentionDepth: 1, agentSessionId }, vi.fn())
    expect(server.agentClients.processMentions).toHaveBeenCalledTimes(1)
    expect(server.agentClients.processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      content: '@all agent says hi',
      senderId: 'agent-1',
      mentionDepth: 1,
    }))

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, { roomId: 'room-1', content: '@all too deep', role: 'assistant', mentionDepth: 4, agentSessionId }, vi.fn())
    expect(server.agentClients.processMentions).not.toHaveBeenCalled()
  })
})
