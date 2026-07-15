import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockIo, mockSocket } = vi.hoisted(() => {
  const mockSocket: any = {
    id: 'agent-socket-1',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === 'connect') queueMicrotask(() => handler())
      return mockSocket
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  }
  return {
    mockSocket,
    mockIo: vi.fn(() => mockSocket),
  }
})

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

import { ContextEngine } from '../../packages/server/src/services/hermes/context-engine/compressor'
import type {
  GatewayCaller,
  MessageFetcher,
  StoredMessage,
} from '../../packages/server/src/services/hermes/context-engine/types'
import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import {
  buildProjectedGroupChatHistory,
  projectGroupChatMessage,
} from '../../packages/server/src/services/hermes/group-chat/context-projection'

function makeMessage(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'm1',
    roomId: 'room-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'hello',
    timestamp: 1,
    role: 'user',
    ...overrides,
  }
}

describe('group chat context projection', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('projects own agent messages as assistant and other participants with attribution as user', () => {
    expect(projectGroupChatMessage(makeMessage({ senderId: 'agent-1', senderName: 'Worker', role: 'assistant', content: '@Bob I handled it' }), {
      agentId: 'agent-1',
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'assistant', content: '[Worker]: I handled it' })

    expect(projectGroupChatMessage(makeMessage({ senderId: 'user-2', senderName: 'Alice', role: 'user', content: '@Worker please help' }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'user', content: '[Alice]: please help' })
  })

  it('does not project same-name humans as the own agent when sender ids differ', () => {
    expect(projectGroupChatMessage(makeMessage({
      senderId: 'user-2',
      senderName: 'Worker',
      role: 'user',
      content: '@Worker I am a different participant',
    }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'user', content: '[Worker]: I am a different participant' })
  })

  it('formats tool results and assistant tool calls consistently', () => {
    expect(projectGroupChatMessage(makeMessage({
      senderName: 'Worker',
      senderId: 'agent-socket-1',
      role: 'tool',
      tool_name: 'search',
      content: 'found docs',
    }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({ role: 'user', content: '[Worker] [Tool result: search]\nfound docs' })

    expect(projectGroupChatMessage(makeMessage({
      senderName: 'Reviewer',
      senderId: 'agent-reviewer',
      role: 'assistant',
      content: '@Worker let me check',
      tool_calls: [{ function: { name: 'search', arguments: '{"q":"docs"}' } }],
    }), {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })).toEqual({
      role: 'user',
      content: '[Reviewer]: let me check\n[Reviewer]: [Calling tool: search with arguments: {"q":"docs"}]',
    })
  })

  it('preserves summary prefix while stripping mentions from projected content', () => {
    const history = buildProjectedGroupChatHistory('Earlier summary', [
      makeMessage({ senderName: 'Alice', content: '@Worker compare this with @Bob' }),
    ], {
      socketId: 'agent-socket-1',
      name: 'Worker',
    })

    expect(history).toEqual([
      { role: 'user', content: '[Previous conversation summary]\nEarlier summary' },
      { role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' },
      { role: 'user', content: '[Alice]: compare this with ' },
    ])
  })

  it('uses the same projection semantics for actual model context and final room token estimates', async () => {
    const messages = [
      makeMessage({ id: 'm1', senderName: 'Alice', senderId: 'user-1', role: 'user', content: '@Worker please compare options' }),
      makeMessage({ id: 'm2', senderName: 'Worker', senderId: 'agent-1', role: 'assistant', content: '@Bob I will take this' }),
      makeMessage({ id: 'm3', senderName: 'Reviewer', senderId: 'agent-reviewer', role: 'assistant', content: '@Worker checking', tool_calls: [{ function: { name: 'search', arguments: '{"q":"options"}' } }], timestamp: 3 }),
      makeMessage({ id: 'm4', senderName: 'Worker', senderId: 'agent-1', role: 'tool', tool_name: 'search', content: 'docs found', timestamp: 4 }),
    ]

    const fetcher: MessageFetcher = {
      getMessagesForContext: vi.fn(() => messages),
      getContextSnapshot: vi.fn(() => null),
      saveContextSnapshot: vi.fn(),
      deleteContextSnapshot: vi.fn(),
    }
    const gatewayCaller: GatewayCaller = {
      summarize: vi.fn(),
    }
    const engine = new ContextEngine({
      config: { triggerTokens: 100_000, maxHistoryTokens: 32_000, tailMessageCount: 10, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller,
    })

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket-1',
      roomName: 'general',
      memberNames: ['Alice', 'Worker', 'Reviewer'],
      members: [],
      upstream: '',
      apiKey: null,
      currentMessage: messages[messages.length - 1],
    })

    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)
    client.setStorage({
      getMessagesForContext: vi.fn(() => messages),
    } as any)

    expect((client as any).buildRoomEstimateHistory('room-1')).toEqual(result.conversationHistory)

    client.disconnect()
  })

  it('includes persisted summary snapshots in final room token estimate history', async () => {
    const messages = [
      makeMessage({ id: 'm1', senderName: 'Alice', senderId: 'user-1', role: 'user', content: 'older request', timestamp: 1 }),
      makeMessage({ id: 'm2', senderName: 'Worker', senderId: 'agent-1', role: 'assistant', content: 'old answer', timestamp: 2 }),
      makeMessage({ id: 'm3', senderName: 'Alice', senderId: 'user-1', role: 'user', content: '@Worker latest request', timestamp: 3 }),
    ]

    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)
    client.setStorage({
      getMessagesForContext: vi.fn(() => messages),
      getContextSnapshot: vi.fn(() => ({
        roomId: 'room-1',
        summary: 'Earlier room summary',
        lastMessageId: 'm1',
        lastMessageTimestamp: 1,
        updatedAt: Date.now(),
      })),
    } as any)

    expect((client as any).buildRoomEstimateHistory('room-1')).toEqual([
      { role: 'user', content: '[Previous conversation summary]\nEarlier room summary' },
      { role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' },
      { role: 'assistant', content: '[Worker]: old answer' },
      { role: 'user', content: '[Alice]: latest request' },
    ])

    client.disconnect()
  })
})
