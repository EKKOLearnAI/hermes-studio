// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage, MemberInfo, RoomAgent, RoomInfo } from '@/api/hermes/group-chat'

const groupChatApiMock = vi.hoisted(() => {
  const handlers = new Map<string, Function[]>()
  let joinAck: any = { members: [], agents: [], typingUsers: [], contextStatuses: [] }
  const socket: any = {
    connected: true,
    id: 'socket-1',
    on: vi.fn((event: string, cb: Function) => {
      const existing = handlers.get(event) || []
      existing.push(cb)
      handlers.set(event, existing)
      return socket
    }),
    once: vi.fn((event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        socket.off(event, wrapped)
        cb(...args)
      }
      return socket.on(event, wrapped)
    }),
    off: vi.fn((event: string, cb?: Function) => {
      if (!cb) {
        handlers.delete(event)
        return socket
      }
      const existing = handlers.get(event) || []
      handlers.set(event, existing.filter(handler => handler !== cb))
      return socket
    }),
    emit: vi.fn((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) ack(joinAck)
      if (event === 'message' && ack) ack({ id: data?.id })
      return socket
    }),
    disconnect: vi.fn(),
  }
  return {
    handlers,
    socket,
    setJoinAck: (value: any) => { joinAck = value },
    connectGroupChat: vi.fn(() => socket),
    disconnectGroupChat: vi.fn(),
    getSocket: vi.fn(() => socket),
    getStoredUserId: vi.fn(() => 'user-1'),
    getStoredUserName: vi.fn(() => 'tester'),
    createRoom: vi.fn(),
    listRooms: vi.fn(),
    getRoomDetail: vi.fn(),
    joinRoomByCode: vi.fn(),
    addAgent: vi.fn(),
    listAgents: vi.fn(),
    removeAgent: vi.fn(),
    cloneRoom: vi.fn(),
    deleteRoom: vi.fn(),
    clearRoomContext: vi.fn(),
  }
})
const clientApiMock = vi.hoisted(() => ({
  getApiKey: vi.fn(() => 'test-token'),
  getActiveProfileName: vi.fn(() => 'research'),
  getStoredUsername: vi.fn(() => null),
}))
const authApiMock = vi.hoisted(() => ({
  fetchCurrentUser: vi.fn(),
}))
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/group-chat', () => groupChatApiMock)
vi.mock('@/api/client', () => clientApiMock)
vi.mock('@/api/auth', () => authApiMock)
vi.mock('@/api/hermes/download', () => ({ getDownloadUrl: vi.fn((path: string) => `/download?path=${path}`) }))
vi.stubGlobal('fetch', fetchMock)

function emitSocket(event: string, payload: unknown) {
  for (const cb of groupChatApiMock.handlers.get(event) || []) cb(payload)
}

const room: RoomInfo = {
  id: 'room-1',
  name: 'Test Room',
  inviteCode: 'ROOM1',
  totalTokens: 7,
} as RoomInfo

const member: MemberInfo = {
  id: 'member-1',
  userId: 'user-1',
  name: 'tester',
  joinedAt: 1,
  online: true,
  socketId: 'socket-1',
} as MemberInfo

const agent: RoomAgent = {
  id: 'row-agent',
  roomId: 'room-1',
  agentId: 'agent-1',
  profile: 'default',
  name: 'Agent',
  description: '',
  invited: 0,
} as RoomAgent

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    senderId: 'user-1',
    senderName: 'tester',
    content: 'hello',
    timestamp: 1,
    role: 'user',
    ...overrides,
  }
}

async function loadStore() {
  const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
  return useGroupChatStore()
}

describe('group chat store baseline lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    localStorage.clear()
    groupChatApiMock.handlers.clear()
    groupChatApiMock.setJoinAck({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
    for (const key of Object.keys(groupChatApiMock)) {
      const value = (groupChatApiMock as any)[key]
      if (value?.mockReset && key !== 'socket') value.mockReset()
    }
    groupChatApiMock.connectGroupChat.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.disconnectGroupChat.mockReset()
    groupChatApiMock.getSocket.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.getStoredUserId.mockReturnValue('user-1')
    groupChatApiMock.getStoredUserName.mockReturnValue('Stored User')
    groupChatApiMock.getRoomDetail.mockResolvedValue({ room, messages: [], agents: [], members: [], total: 0, hasMore: false })
    groupChatApiMock.clearRoomContext.mockResolvedValue({ success: true, room: { ...room, totalTokens: 0 } })
    clientApiMock.getApiKey.mockReturnValue('test-token')
    clientApiMock.getActiveProfileName.mockReturnValue('research')
    clientApiMock.getStoredUsername.mockReturnValue(null)
    authApiMock.fetchCurrentUser.mockRejectedValue(new Error('not signed in'))
    fetchMock.mockReset()
    groupChatApiMock.socket.connected = true
    groupChatApiMock.socket.on.mockClear()
    groupChatApiMock.socket.once.mockClear()
    groupChatApiMock.socket.off.mockClear()
    groupChatApiMock.socket.emit.mockReset()
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      if (event === 'message' && ack) ack({ id: data?.id })
      return groupChatApiMock.socket
    })
    groupChatApiMock.socket.disconnect.mockClear()
  })

  it('connects with stored user data and registers realtime handlers', async () => {
    const store = await loadStore()

    await store.connect()

    expect(groupChatApiMock.connectGroupChat).toHaveBeenCalledWith({
      userId: 'user-1',
      userName: 'Stored User',
      authUserId: undefined,
    })
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('message', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('approval.requested', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('room_cleared', expect.any(Function))
  })

  it('joins a room from REST detail and realtime ack state', async () => {
    const store = await loadStore()
    const detailMessage = userMessage({ id: 'msg-1' })
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [detailMessage],
      agents: [agent],
      members: [member],
      total: 5,
      hasMore: true,
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) ack({
        roomName: 'Realtime Room',
        members: [{ ...member, name: 'Realtime User' }],
        agents: [agent],
        typingUsers: [],
        contextStatuses: [{ agentName: 'Agent', status: 'replying' }],
      })
      return groupChatApiMock.socket
    })

    await store.connect()
    await store.joinRoom('room-1')

    expect(groupChatApiMock.getRoomDetail).toHaveBeenCalledWith('room-1')
    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('join', expect.objectContaining({ roomId: 'room-1' }), expect.any(Function))
    expect(store.currentRoomId).toBe('room-1')
    expect(store.roomName).toBe('Realtime Room')
    expect(store.messages.map((m: ChatMessage) => m.id)).toEqual(['msg-1'])
    expect(store.members.map((m: MemberInfo) => m.name)).toEqual(['Realtime User'])
    expect(store.agents.map((a: RoomAgent) => a.agentId)).toEqual(['agent-1'])
    expect(store.totalMessages).toBe(5)
    expect(store.hasMoreBefore).toBe(true)
    expect(store.contextStatuses.get('Agent')).toEqual({ agentName: 'Agent', status: 'replying' })
  })

  it('joins invite rooms over realtime before fetching protected detail when the socket starts disconnected', async () => {
    const store = await loadStore()
    const order: string[] = []

    groupChatApiMock.socket.connected = false
    groupChatApiMock.getSocket.mockImplementation((options?: { requireConnected?: boolean }) => (
      groupChatApiMock.socket.connected || options?.requireConnected === false ? groupChatApiMock.socket : null
    ))
    groupChatApiMock.socket.once.mockImplementation((event: string, cb: Function) => {
      if (event === 'connect') {
        setTimeout(() => {
          groupChatApiMock.socket.connected = true
          cb()
        }, 0)
      }
      return groupChatApiMock.socket
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        order.push(data?.inviteCode ? 'invite-join' : 'detail-join')
        ack({ roomName: 'Realtime Room', members: [member], agents: [], typingUsers: [], contextStatuses: [] })
      }
      return groupChatApiMock.socket
    })
    groupChatApiMock.joinRoomByCode.mockResolvedValue({ room })
    groupChatApiMock.getRoomDetail.mockImplementation(async () => {
      order.push('detail')
      return { room, messages: [], agents: [], members: [member], total: 0, hasMore: false }
    })

    await store.joinByCode('ROOM1')

    expect(groupChatApiMock.connectGroupChat).toHaveBeenCalled()
    expect(groupChatApiMock.getRoomDetail).toHaveBeenCalledWith('room-1')
    expect(order).toEqual(['invite-join', 'detail', 'detail-join'])
    expect(store.currentRoomId).toBe('room-1')
  })

  it('sends text-only messages through the room socket', async () => {
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')

    await store.sendMessage('hello room')

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      content: 'hello room',
    }), expect.any(Function))
    expect(store.error).toBeNull()
  })

  it('clears local room context from API response and room_cleared event', async () => {
    const store = await loadStore()
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [userMessage()],
      agents: [agent],
      members: [member],
      total: 1,
      hasMore: false,
    })
    await store.connect()
    await store.joinRoom('room-1')
    store.rooms = [room]
    emitSocket('typing', { roomId: 'room-1', userId: 'user-2', userName: 'Bob' })
    store.contextStatuses.set('Agent', { agentName: 'Agent', status: 'replying' })
    store.pendingApprovals.set('approval-1', {
      roomId: 'room-1',
      agentName: 'Agent',
      approvalId: 'approval-1',
      command: 'touch file',
      description: 'needs approval',
      choices: ['once', 'session', 'deny'],
      allowPermanent: false,
      isMemoryWrite: false,
      requestedAt: 1,
    })

    await store.clearCurrentRoomContext()

    expect(groupChatApiMock.clearRoomContext).toHaveBeenCalledWith('room-1')
    expect(store.messages).toEqual([])
    expect(store.typingNames).toEqual([])
    expect(store.contextStatuses.size).toBe(0)
    expect(store.rooms[0].totalTokens).toBe(0)

    emitSocket('room_cleared', { roomId: 'room-1', totalTokens: 0 })
    expect(store.pendingApprovals.size).toBe(0)
  })

  it('tracks pending approvals and removes them when resolved', async () => {
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')

    emitSocket('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-1',
      command: 'touch file',
      description: 'needs approval',
      choices: ['once', 'session', 'deny'],
    })

    expect(store.pendingApprovals.get('approval-1')).toMatchObject({
      roomId: 'room-1',
      agentName: 'Agent',
      approvalId: 'approval-1',
      choices: ['once', 'session', 'deny'],
    })
    emitSocket('approval.resolved', { approval_id: 'approval-1' })
    expect(store.pendingApprovals.size).toBe(0)
  })

  it('updates the current room token display on room_updated', async () => {
    const store = await loadStore()
    store.rooms = [{ ...room, totalTokens: 7 }]
    await store.connect()

    emitSocket('room_updated', { roomId: 'room-1', totalTokens: 42 })

    expect(store.rooms[0].totalTokens).toBe(42)
  })
})
