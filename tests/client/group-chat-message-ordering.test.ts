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

vi.mock('@/api/hermes/group-chat', () => groupChatApiMock)
vi.mock('@/api/client', () => clientApiMock)
vi.mock('@/api/auth', () => authApiMock)

function makeMsg(overrides: Partial<ChatMessage> & { id: string; roomId: string }): ChatMessage {
    return {
        senderId: 'agent-1',
        senderName: 'agent-1',
        content: '',
        timestamp: Date.now(),
        ...overrides,
    }
}

describe('sortedMessages uses stable firstSeenAt ordering', () => {
    beforeEach(async () => {
        setActivePinia(createPinia())
        vi.clearAllMocks()
        const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
        const store = useGroupChatStore()
        const handlers = groupChatApiMock.handlers
        return { store, handlers }
    })

    it('keeps agent messages in stream-start order even when second completes first', async () => {
        const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
        const store = useGroupChatStore()
        const handlers = groupChatApiMock.handlers
        const baseTime = 1000000

        store.currentRoomId = 'room-1'

        // Agent A starts streaming first (timestamp = baseTime)
        const msgAStart = makeMsg({ id: 'a', roomId: 'room-1', senderId: 'agent-a', senderName: 'Agent A', timestamp: baseTime, content: '' })
        const streamStart = handlers.get('message_stream_start')?.[0]
        streamStart?.(msgAStart)

        // Agent B starts second (timestamp = baseTime + 100)
        const msgBStart = makeMsg({ id: 'b', roomId: 'room-1', senderId: 'agent-b', senderName: 'Agent B', timestamp: baseTime + 100, content: '' })
        streamStart?.(msgBStart)

        // Agent B finishes first (timestamp = baseTime + 200, earlier than A's completion)
        const msgBFinal = makeMsg({ id: 'b', roomId: 'room-1', senderId: 'agent-b', senderName: 'Agent B', timestamp: baseTime + 200, content: 'B done', isStreaming: false })
        const messageHandler = handlers.get('message')?.[0]
        messageHandler?.(msgBFinal)

        // Agent A finishes later (timestamp = baseTime + 500)
        const msgAFinal = makeMsg({ id: 'a', roomId: 'room-1', senderId: 'agent-a', senderName: 'Agent A', timestamp: baseTime + 500, content: 'A done longer reply', isStreaming: false })
        messageHandler?.(msgAFinal)

        // A should still be first because it started first
        const ids = store.sortedMessages.map(m => m.id)
        expect(ids).toEqual(['a', 'b'])
    })

    it('sorts by firstSeenAt even when streaming deltas arrive out of order', async () => {
        const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
        const store = useGroupChatStore()
        const handlers = groupChatApiMock.handlers
        const baseTime = 2000000

        store.currentRoomId = 'room-2'

        // Start two agents
        const msgA = makeMsg({ id: 'a2', roomId: 'room-2', senderId: 'agent-a', senderName: 'Agent A', timestamp: baseTime, content: '' })
        const msgB = makeMsg({ id: 'b2', roomId: 'room-2', senderId: 'agent-b', senderName: 'Agent B', timestamp: baseTime + 50, content: '' })
        const streamStart = handlers.get('message_stream_start')?.[0]
        streamStart?.(msgA)
        streamStart?.(msgB)

        // Delta for B first
        const deltaHandler = handlers.get('message_stream_delta')?.[0]
        deltaHandler?.({ roomId: 'room-2', id: 'b2', delta: 'B content' })
        deltaHandler?.({ roomId: 'room-2', id: 'a2', delta: 'A content' })

        const ids = store.sortedMessages.map(m => m.id)
        expect(ids).toEqual(['a2', 'b2'])
    })

    it('falls back to timestamp when firstSeenAt is not set', async () => {
        const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
        const store = useGroupChatStore()
        const handlers = groupChatApiMock.handlers
        const baseTime = 3000000

        store.currentRoomId = 'room-3'

        // Direct message (no streaming) — no firstSeenAt set
        const messageHandler = handlers.get('message')?.[0]
        const msg1 = makeMsg({ id: 'm1', roomId: 'room-3', senderId: 'user', senderName: 'user', timestamp: baseTime, content: 'first' })
        const msg2 = makeMsg({ id: 'm2', roomId: 'room-3', senderId: 'user', senderName: 'user', timestamp: baseTime + 1, content: 'second' })
        messageHandler?.(msg2)
        messageHandler?.(msg1)

        const ids = store.sortedMessages.map(m => m.id)
        expect(ids).toEqual(['m1', 'm2'])
    })
})
