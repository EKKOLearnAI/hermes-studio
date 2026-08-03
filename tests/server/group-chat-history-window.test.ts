import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server as HttpServer } from 'http'

const dbMock = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

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

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbMock.current,
}))

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

import { countTokens } from '../../packages/server/src/lib/context-compressor'
import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import { AgentClients, mentionMessageToStoredContextMessage } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { sortGroupMessagesCanonical } from '../../packages/server/src/services/hermes/group-chat/group-message-ordering'
import { GroupRoomSummaryService } from '../../packages/server/src/services/hermes/group-chat/room-summary'

function makeDb(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function makeMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'hello',
    timestamp: 1,
    role: 'user',
    ...overrides,
  }
}

describe('group chat history windows', () => {
  it('maps routed mention ids into context-engine current message cursors', () => {
    const current = mentionMessageToStoredContextMessage('room-1', {
      messageId: 'trigger-msg',
      content: '@Worker use the context through this message only',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 123,
      senderKind: 'user',
    })

    expect(current.id).toBe('trigger-msg')
    expect(current.roomId).toBe('room-1')
    expect(current.role).toBe('user')
  })

  let httpServer: HttpServer
  let groupServer: GroupChatServer

  beforeEach(() => {
    vi.clearAllMocks()
    dbMock.current = makeDb()
    initAllHermesTables()
    httpServer = createServer()
    groupServer = new GroupChatServer(httpServer)
  })

  afterEach(() => {
    groupServer?.getIO().close()
    httpServer?.close()
    dbMock.current?.close()
    dbMock.current = null
  })

  it('returns a bounded recent UI page while context reads the full retained transcript in canonical order', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 160 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `message ${index + 1}`,
      timestamp: index + 1,
    }))

    for (const message of seeded) storage.saveMessageAndRefreshRoom(message as any)

    const recentMessages = storage.getRecentMessagesForUI('room-1')
    const contextMessages = storage.getMessagesForContext('room-1')

    expect(recentMessages).toHaveLength(150)
    expect(recentMessages[0]?.id).toBe('msg-11')
    expect(recentMessages.at(-1)?.id).toBe('msg-160')
    expect(contextMessages).toHaveLength(160)
    expect(contextMessages.map(message => message.id)).toEqual(
      sortGroupMessagesCanonical(seeded as Array<{ id: string; timestamp: number }>).map(message => message.id),
    )
  })

  it('does not split same-timestamp multipart assistant/tool runs across UI page boundaries', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = [
      makeMessage({ id: 'run-1_part_0', role: 'assistant', senderId: 'agent-1', senderName: 'Agent', content: 'assistant', timestamp: 100 }),
      makeMessage({ id: 'run-1_part_0_toolcall_t', role: 'assistant', senderId: 'agent-1', senderName: 'Agent', content: '', timestamp: 100 }),
      makeMessage({ id: 'run-1_part_0_toolresult_t', role: 'tool', senderId: 'agent-1', senderName: 'Agent', content: 'tool result', timestamp: 100 }),
      makeMessage({ id: 'run-2', role: 'user', senderId: 'user-1', senderName: 'Human', content: 'next', timestamp: 100 }),
    ]

    for (const message of seeded) storage.saveMessageAndRefreshRoom(message as any)

    expect(storage.getRecentMessagesForUI('room-1', 2, 0).map(message => message.id)).toEqual([
      'run-1_part_0',
      'run-1_part_0_toolcall_t',
      'run-1_part_0_toolresult_t',
      'run-2',
    ])
    expect(storage.getRecentMessagesForUI('room-1', 2, 2).map(message => message.id)).toEqual([
      'run-1_part_0',
      'run-1_part_0_toolcall_t',
      'run-1_part_0_toolresult_t',
    ])
  })

  it('computes room total tokens from the full retained context transcript, not the UI page window', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 160 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `message-${index + 1}`,
      timestamp: index + 1,
    }))

    let latest: { totalTokens: number } | null = null
    for (const message of seeded) latest = storage.saveMessageAndRefreshRoom(message as any)

    const expectedTotalTokens = seeded.reduce((sum, message) => sum + countTokens(String(message.content)), 0)

    expect(storage.getRecentMessagesForUI('room-1')).toHaveLength(150)
    expect(storage.getMessagesForContext('room-1')).toHaveLength(160)
    expect(latest?.totalTokens).toBe(expectedTotalTokens)
    expect(storage.getRoom('room-1')?.totalTokens).toBe(expectedTotalTokens)
  })

  it('continues shared context by timestamp when the summary anchor was pruned', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 501 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `message-${index + 1}`,
      timestamp: index + 1,
    }))

    storage.saveMessageAndRefreshRoom(seeded[0] as any)
    storage.saveRoomSummary({
      roomId: 'room-1',
      summary: 'Earlier summary',
      summaryThroughMessageId: 'msg-1',
      summaryThroughMessageTimestamp: 1,
      summarizedTurnCount: 1,
      status: 'success',
      version: 1,
      updatedAt: 1,
      lastError: null,
    })

    for (const message of seeded.slice(1)) storage.saveMessageAndRefreshRoom(message as any)

    const retained = storage.getMessagesForContext('room-1')
    const context = groupServer.getRoomSummaryService().buildRuntimeContext('room-1')

    expect(retained).toHaveLength(500)
    expect(retained.some(message => message.id === 'msg-1')).toBe(false)
    expect(context.summary).toBe('Earlier summary')
    expect(context.history).toHaveLength(500)
    expect(context.history[0]?.id).toBe('msg-2')
    expect(context.history.at(-1)?.id).toBe('msg-501')
  })

  it('builds Agent context from the full retained transcript rather than the UI page', () => {
    const messages = Array.from({ length: 160 }, (_value, index) => ({
      id: `message-${index + 1}`,
      senderId: 'user-1',
      senderName: 'Alice',
      content: `message ${index + 1}`,
      role: 'user',
      timestamp: index + 1,
    }))
    const storage = {
      getMessagesForContext: vi.fn(() => messages),
      getRecentMessagesForUI: vi.fn(() => messages.slice(-150)),
      getRoom: vi.fn(() => ({
        id: 'room-1',
        summaryProfile: 'default',
        summaryProvider: 'openai',
        summaryModel: 'test',
        summaryApiMode: '',
        summaryEveryTurns: 200,
      })),
      getRoomSummary: vi.fn(() => null),
      saveRoomSummary: vi.fn(),
    }

    const context = new GroupRoomSummaryService(storage as any).buildRuntimeContext('room-1')

    expect(storage.getMessagesForContext).toHaveBeenCalledWith('room-1')
    expect(storage.getRecentMessagesForUI).not.toHaveBeenCalled()
    expect(context.summary).toBe('')
    expect(context.history).toHaveLength(160)
    expect(context.history[0]?.id).toBe('message-1')
    expect(context.history.at(-1)?.id).toBe('message-160')
  })

  it('includes the active reasoning segment in persisted group tool-call messages', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)

    ;(client as any).recordToolStarted(
      'room-1',
      'session-1',
      {
        tool_name: 'lookup',
        tool_call_id: 'call-1',
        args: { room: 'room-1' },
      },
      'run-1_part_0',
      'run-1',
      'Inspect the room before calling lookup.',
    )

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        id: 'run-1_part_0_toolcall_call-1',
        run_id: 'run-1',
        role: 'assistant',
        reasoning: 'Inspect the room before calling lookup.',
        reasoning_content: 'Inspect the room before calling lookup.',
        tool_calls: [expect.objectContaining({ id: 'call-1' })],
      }),
      expect.any(Function),
    )

    client.disconnect()
  })
})
