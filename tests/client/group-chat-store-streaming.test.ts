// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage, RoomInfo } from '@/api/hermes/group-chat'

const groupChatApiMock = vi.hoisted(() => {
  const handlers = new Map<string, Function[]>()
  const socket: any = {
    connected: true,
    id: 'socket-1',
    on: vi.fn((event: string, cb: Function) => {
      const existing = handlers.get(event) || []
      existing.push(cb)
      handlers.set(event, existing)
      return socket
    }),
    emit: vi.fn((event: string, _data?: unknown, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      return socket
    }),
    disconnect: vi.fn(),
  }
  return {
    handlers,
    socket,
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
}

function assistantMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    senderId: 'agent-1',
    senderName: 'bot',
    content: '',
    timestamp: 1,
    role: 'assistant',
    ...overrides,
  }
}

async function createJoinedStore(initialMessages: ChatMessage[] = []) {
  groupChatApiMock.getRoomDetail.mockResolvedValue({
    room,
    messages: initialMessages,
    agents: [],
    members: [],
  })
  const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
  const store = useGroupChatStore()
  store.connect()
  await store.joinRoom('room-1')
  groupChatApiMock.getRoomDetail.mockClear()
  return store
}

describe('group chat store streaming merge', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    groupChatApiMock.handlers.clear()
    for (const key of Object.keys(groupChatApiMock)) {
      const value = (groupChatApiMock as any)[key]
      if (value?.mockReset && key !== 'socket') value.mockReset()
    }
    groupChatApiMock.connectGroupChat.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.getSocket.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.getStoredUserId.mockReturnValue('user-1')
    groupChatApiMock.getStoredUserName.mockReturnValue('tester')
    clientApiMock.getApiKey.mockReturnValue('test-token')
    clientApiMock.getActiveProfileName.mockReturnValue('research')
    clientApiMock.getStoredUsername.mockReturnValue(null)
    authApiMock.fetchCurrentUser.mockRejectedValue(new Error('not signed in'))
    fetchMock.mockReset()
    groupChatApiMock.socket.on.mockClear()
    groupChatApiMock.socket.emit.mockReset()
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: unknown, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      return groupChatApiMock.socket
    })
    groupChatApiMock.socket.disconnect.mockClear()
  })

  it('preserves streamed reasoning when the final message supplies content only', async () => {
    const store = await createJoinedStore()

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1' }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: 'thinking...' })
    emitSocket('message', assistantMessage({ id: 'msg-1', content: '收到', reasoning: null, reasoning_content: null }))

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: '收到',
      reasoning: 'thinking...',
      reasoning_content: 'thinking...',
      isStreaming: false,
    })
  })

  it('preserves streamed content when the final message payload is blank', async () => {
    const store = await createJoinedStore()

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1' }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: 'final' })
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: ' answer' })
    emitSocket('message', assistantMessage({ id: 'msg-1', content: '', reasoning: 'thinking...' }))

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('ignores late content deltas for a completed message', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({ id: 'msg-1', content: 'final answer', reasoning: 'thinking...' }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: ' stale' })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('ignores late reasoning deltas for a completed message', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({ id: 'msg-1', content: 'final answer', reasoning: 'thinking...' }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: ' stale' })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('ignores a late empty stream start for a completed message', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({ id: 'msg-1', content: 'final answer', reasoning: 'thinking...' }))
    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1', content: '', timestamp: 2 }))

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('ignores a late stream start for a completed empty tool-call message', async () => {
    const store = await createJoinedStore()
    const toolCalls = [{ id: 'tool-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]

    emitSocket('message', assistantMessage({ id: 'msg-1', content: '', tool_calls: toolCalls }))
    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1', content: '', timestamp: 2 }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: ' stale' })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: '',
      tool_calls: toolCalls,
      isStreaming: false,
    })
  })

  it('refetches room detail when a stream ends with reasoning but no final content', async () => {
    vi.useFakeTimers()
    const store = await createJoinedStore()
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      agents: [],
      members: [],
      messages: [assistantMessage({ id: 'msg-1', content: 'final from db', reasoning: 'thinking...' })],
    })

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1' }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: 'thinking...' })
    emitSocket('message_stream_end', { roomId: 'room-1', id: 'msg-1' })

    await vi.runAllTimersAsync()

    expect(groupChatApiMock.getRoomDetail).toHaveBeenCalledWith('room-1')
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final from db',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('maps non-string and falsy tool payloads from room history', async () => {
    const store = await createJoinedStore([
      assistantMessage({
        id: 'msg-tool-call',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: false } }],
      } as unknown as Partial<ChatMessage>),
      assistantMessage({
        id: 'msg-tool-result',
        role: 'tool',
        tool_call_id: 'call-1',
        content: { ok: true },
      } as unknown as Partial<ChatMessage>),
    ])

    expect(store.sortedMessages).toHaveLength(1)
    expect(store.sortedMessages[0]).toMatchObject({
      role: 'tool',
      toolName: 'lookup',
      toolArgs: false,
      toolResult: { ok: true },
      toolStatus: 'done',
    })
  })

  it('rejoins the active room after socket reconnect and restores transient room state', async () => {
    const store = await createJoinedStore()
    store.loadedMessageCount = 300
    store.totalMessages = 500
    store.hasMoreBefore = true
    store.rooms = [room]
    groupChatApiMock.socket.emit.mockClear()
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        ack({
          members: [{ id: 'human-1', name: 'Human', online: true }],
          agents: [{ id: 'agent-row-1', agentId: 'agent-1', profile: 'worker', name: 'Worker' }],
          rooms: ['room-1', 'room-2'],
          messages: [assistantMessage({ id: 'missed-1', content: 'missed while offline', timestamp: 2 })],
          typingUsers: [{ userId: 'agent-1', userName: 'Worker' }],
          contextStatuses: [{ agentName: 'Worker', status: 'replying' }],
        })
      }
      return groupChatApiMock.socket
    })

    emitSocket('connect', undefined)
    await Promise.resolve()

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith(
      'join',
      expect.objectContaining({ roomId: 'room-1', name: 'tester' }),
      expect.any(Function),
    )
    expect(store.members).toEqual([expect.objectContaining({ id: 'human-1', name: 'Human' })])
    expect(store.agents).toEqual([expect.objectContaining({ profile: 'worker', name: 'Worker' })])
    expect(store.rooms).toEqual([room])
    expect(store.messages).toEqual([expect.objectContaining({ id: 'missed-1', content: 'missed while offline' })])
    expect(store.loadedMessageCount).toBe(300)
    expect(store.totalMessages).toBe(500)
    expect(store.hasMoreBefore).toBe(true)
    expect(store.typingNames).toEqual(['Worker'])
    expect(store.contextStatus).toEqual(expect.objectContaining({ agentName: 'Worker', status: 'replying' }))
  })

  it('ignores a stale reconnect join ack after the user switches rooms', async () => {
    const store = await createJoinedStore()
    let joinAck: Function | undefined
    groupChatApiMock.socket.emit.mockClear()
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join') joinAck = ack
      return groupChatApiMock.socket
    })

    emitSocket('connect', undefined)
    await Promise.resolve()
    expect(joinAck).toBeDefined()

    const roomTwoMessage = assistantMessage({ id: 'room-2-msg', roomId: 'room-2', content: 'current room', timestamp: 3 })
    store.currentRoomId = 'room-2'
    store.members = [{ id: 'human-2', name: 'Room 2 Human', online: true }]
    store.messages = [roomTwoMessage]

    joinAck?.({
      members: [{ id: 'human-1', name: 'Old Room Human', online: true }],
      messages: [assistantMessage({ id: 'old-room-msg', content: 'old room', timestamp: 2 })],
      typingUsers: [{ userId: 'agent-1', userName: 'Worker' }],
      contextStatuses: [{ agentName: 'Worker', status: 'replying' }],
    })
    await Promise.resolve()

    expect(store.currentRoomId).toBe('room-2')
    expect(store.members).toEqual([expect.objectContaining({ id: 'human-2', name: 'Room 2 Human' })])
    expect(store.messages).toEqual([roomTwoMessage])
    expect(store.typingNames).toEqual([])
  })

  it('does not rejoin when socket connects without an active room', async () => {
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()
    await store.connect()
    groupChatApiMock.socket.emit.mockClear()

    emitSocket('connect', undefined)
    await Promise.resolve()

    expect(groupChatApiMock.socket.emit).not.toHaveBeenCalledWith(
      'join',
      expect.anything(),
      expect.any(Function),
    )
  })

  it('uses authenticated account identity and restores the persisted room member name', async () => {
    groupChatApiMock.getStoredUserId.mockReturnValue('browser-local-id')
    groupChatApiMock.getStoredUserName.mockReturnValue(null)
    clientApiMock.getStoredUsername.mockReturnValue('alice-login')
    authApiMock.fetchCurrentUser.mockResolvedValue({
      id: 42,
      username: 'alice-login',
      role: 'admin',
      status: 'active',
      created_at: 1,
      updated_at: 1,
      last_login_at: null,
      avatar: '',
    })
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [],
      agents: [],
      members: [],
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        expect(data).toMatchObject({ roomId: 'room-1' })
        expect(data.name).toBeUndefined()
        ack({
          members: [{ id: 'member-1', userId: 'auth:42', name: 'Alice Display', description: '', joinedAt: 1 }],
          agents: [],
          typingUsers: [],
          contextStatuses: [],
        })
      }
      return groupChatApiMock.socket
    })
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()

    await store.connect()
    await store.joinRoom('room-1')

    expect(groupChatApiMock.connectGroupChat).toHaveBeenCalledWith({
      userId: 'auth:42',
      userName: undefined,
      authUserId: 42,
    })
    expect(store.userId).toBe('auth:42')
    expect(store.userName).toBe('Alice Display')
  })

  it('adds auth and active profile headers to group chat uploads', async () => {
    const store = await createJoinedStore()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ files: [{ name: 'note.txt', path: '/tmp/note.txt' }] }),
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: unknown, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      if (event === 'message' && ack) ack({ id: 'msg-server' })
      return groupChatApiMock.socket
    })

    await store.sendMessage('hello', [{
      id: 'file-1',
      name: 'note.txt',
      type: 'text/plain',
      size: 5,
      url: '',
      file: new File(['hello'], 'note.txt', { type: 'text/plain' }),
    }])

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/upload')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer test-token')
    expect(options.headers['X-Hermes-Profile']).toBe('research')
    expect(options.body).toBeInstanceOf(FormData)
  })
})
