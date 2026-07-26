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

import { countTokens, SUMMARY_PREFIX } from '../../packages/server/src/lib/context-compressor'
import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import { AgentClients, groupBridgeSessionId, mentionMessageToStoredContextMessage } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { sortGroupMessagesCanonical } from '../../packages/server/src/services/hermes/group-chat/group-message-ordering'

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

  it('persists a monotonic room sequence and preserves it across message upserts', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'msg-a', timestamp: 100 }) as any)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'msg-b', timestamp: 1 }) as any)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'msg-a', timestamp: 999, content: 'updated' }) as any)

    const rows = dbMock.current?.prepare(
      'SELECT id, roomSeq, timestamp, content FROM gc_messages WHERE roomId = ? ORDER BY roomSeq ASC',
    ).all('room-1') as Array<{ id: string; roomSeq: number; timestamp: number; content: string }>
    expect(rows).toEqual([
      { id: 'msg-a', roomSeq: 1, timestamp: 999, content: 'updated' },
      { id: 'msg-b', roomSeq: 2, timestamp: 1, content: 'hello' },
    ])
    expect(storage.getMessagesForContext('room-1').map(message => message.roomSeq)).toEqual([2, 1])
  })

  it('selects a context window by room sequence before applying presentation order', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'z-prior', timestamp: 100, content: 'prior despite later clock' }) as any)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'a-trigger', timestamp: 1, content: 'trigger after clock rollback' }) as any)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'z-same-ms-prior', timestamp: 200, content: 'same-ms prior' }) as any)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'a-same-ms-trigger', timestamp: 200, content: 'same-ms trigger' }) as any)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'later', timestamp: 0, content: 'must stay after trigger' }) as any)
    dbMock.current?.prepare(
      `INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, role, roomSeq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy-unknown-seq', 'room-1', 'user-1', 'Alice', 'unknown sequence', 50, 'user', 0)

    expect(storage.getMessagesForContext('room-1', { throughRoomSeq: 2 } as any).map(message => message.id)).toEqual([
      'a-trigger',
      'z-prior',
    ])
    expect(storage.getMessagesForContext('room-1', { throughRoomSeq: 4 } as any).map(message => message.id)).toEqual([
      'a-trigger',
      'z-prior',
      'a-same-ms-trigger',
      'z-same-ms-prior',
    ])
    expect(storage.getMessagesForContext('room-1').map(message => message.id)).toContain('legacy-unknown-seq')
  })

  it('does not reuse a pruned high room sequence after timestamp rollback', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'msg-a', timestamp: 100 }) as any)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'msg-b', timestamp: 1 }) as any)
    storage.pruneMessages('room-1', 1)
    storage.saveMessageAndRefreshRoom(makeMessage({ id: 'msg-c', timestamp: 101 }) as any)

    expect(dbMock.current?.prepare(
      'SELECT id, roomSeq FROM gc_messages WHERE roomId = ? ORDER BY roomSeq ASC',
    ).all('room-1')).toEqual([
      { id: 'msg-a', roomSeq: 1 },
      { id: 'msg-c', roomSeq: 3 },
    ])
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

  it('preserves snapshot summary tokens when the snapshot anchor was pruned from retained history', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1')

    const seeded = Array.from({ length: 501 }, (_value, index) => makeMessage({
      id: `msg-${index + 1}`,
      content: `message-${index + 1}`,
      timestamp: index + 1,
    }))

    storage.saveMessageAndRefreshRoom(seeded[0] as any)
    storage.saveContextSnapshot('room-1', 'Earlier summary', 'msg-1', 1)

    let latest: { totalTokens: number } | null = null
    for (const message of seeded.slice(1)) latest = storage.saveMessageAndRefreshRoom(message as any)

    const retained = storage.getMessagesForContext('room-1')
    const expectedTotalTokens = countTokens(SUMMARY_PREFIX + 'Earlier summary')
      + retained.reduce((sum, message) => sum + countTokens(String(message.content)), 0)

    expect(retained).toHaveLength(500)
    expect(retained.some(message => message.id === 'msg-1')).toBe(false)
    expect(storage.getContextSnapshot('room-1')?.lastMessageId).toBe('msg-1')
    expect(latest?.totalTokens).toBe(expectedTotalTokens)
    expect(storage.getRoom('room-1')?.totalTokens).toBe(expectedTotalTokens)
  })

  it('uses the full context transcript for the final AgentClient room estimate', async () => {
    const messages = Array.from({ length: 160 }, (_value, index) => ({
      senderId: 'user-1',
      senderName: 'Alice',
      content: `message ${index + 1}`,
      role: 'user',
      timestamp: index + 1,
    }))
    const sessionId = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-1')
    const storage = {
      getMessagesForContext: vi.fn(() => messages),
      getRecentMessagesForUI: vi.fn(() => messages.slice(-150)),
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-1' })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Worker' })),
      updateRoomTotalTokens: vi.fn(),
    }
    const bridge = {
      contextEstimate: vi.fn(async (_sessionId: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => ({
        token_count: 4321,
        fixed_context_tokens: 0,
        message_count: history.length,
      })),
    }

    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)
    client.setStorage(storage as any)

    await (client as any).refreshRoomFullContextEstimate('room-1', sessionId, bridge, undefined, { model: '', provider: '' })

    expect(storage.getMessagesForContext).toHaveBeenCalledWith('room-1')
    expect(storage.getRecentMessagesForUI).not.toHaveBeenCalled()
    expect(bridge.contextEstimate).toHaveBeenCalledTimes(1)
    expect(bridge.contextEstimate.mock.calls[0][1]).toHaveLength(160)
    expect(storage.updateRoomTotalTokens).toHaveBeenCalledWith('room-1', 4321)
    expect(mockSocket.emit).toHaveBeenCalledWith('context_status', expect.objectContaining({
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      totalTokens: 4321,
    }))

    client.disconnect()
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
      'Inspect the room before calling lookup.',
    )

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        id: 'run-1_part_0_toolcall_call-1',
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
