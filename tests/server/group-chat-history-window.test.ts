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

  it('returns bounded UI and context windows in canonical order', () => {
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

  it('computes room total tokens from the context window, not the UI page window', () => {
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

  it('retains older messages while limiting shared context to the latest 500', () => {
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

    let latest: { totalTokens: number } | null = null
    for (const message of seeded.slice(1)) latest = storage.saveMessageAndRefreshRoom(message as any)

    const contextMessages = storage.getMessagesForContext('room-1')
    const context = groupServer.getRoomSummaryService().buildRuntimeContext('room-1')

    expect(storage.getMessageCount('room-1')).toBe(501)
    expect(storage.getMessage('msg-1')).not.toBeNull()
    expect(storage.getRecentMessagesForUI('room-1', 500).map(message => message.id)).toEqual(
      seeded.slice(1).map(message => message.id),
    )
    expect(storage.getRecentMessagesForUI('room-1', 150, 450).map(message => message.id)).toEqual(
      seeded.slice(1, 51).map(message => message.id),
    )
    expect(storage.getRecentMessagesForUI('room-1', 150, 500)).toEqual([])
    expect(contextMessages).toHaveLength(500)
    expect(contextMessages.some(message => message.id === 'msg-1')).toBe(false)
    expect(context.summary).toBe('Earlier summary')
    expect(context.history).toHaveLength(500)
    expect(context.history[0]?.id).toBe('msg-2')
    expect(context.history.at(-1)?.id).toBe('msg-501')
    expect(latest?.totalTokens).toBe(
      seeded.slice(1).reduce((sum, message) => sum + countTokens(String(message.content)), 0),
    )

    storage.clearRoomContext('room-1')

    expect(storage.getMessageCount('room-1')).toBe(0)
    expect(storage.getMessage('msg-1')).toBeNull()
    expect(storage.getMessagesForContext('room-1')).toEqual([])
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

  it('keeps a completed tool result recoverable until Room persistence succeeds', async () => {
    let resultAttempts = 0
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        resultAttempts += 1
        if (typeof ack === 'function') {
          ack(resultAttempts === 1
            ? { error: 'temporary Room persistence failure' }
            : { id: payload.id })
        }
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
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

    await (client as any).recordToolStarted(
      'room-1',
      'session-1',
      { tool_name: 'lookup', tool_call_id: 'call-retry', args: {} },
      'run-retry_part_0',
      'run-retry',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed',
      tool_name: 'lookup',
      tool_call_id: 'call-retry',
      output: 'literal @all result must survive retry',
    })

    expect(resultAttempts).toBe(1)
    expect(Array.from((client as any).pendingToolRunIds.values())).toContain('run-retry')

    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-retry')

    expect(resultAttempts).toBe(2)
    expect(mockSocket.emit).toHaveBeenLastCalledWith(
      'message',
      expect.objectContaining({
        id: 'run-retry_part_0_toolresult_call-retry',
        role: 'tool',
        tool_call_id: 'call-retry',
        content: 'literal @all result must survive retry',
      }),
      expect.any(Function),
    )
    expect((client as any).pendingToolRunIds.size).toBe(0)
    expect((client as any).pendingToolBaseIds.size).toBe(0)
    expect((client as any).pendingToolNames.size).toBe(0)

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(resultPayloads.map((payload: any) => payload.id)).toEqual([
      'run-retry_part_0_toolresult_call-retry',
      'run-retry_part_0_toolresult_call-retry',
    ])

    client.disconnect()
  })

  it('keeps parallel anonymous tool completions correlated when the first persistence attempt fails', async () => {
    const attempts = new Map<string, number>()
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        const callId = String(payload.tool_call_id)
        const attempt = (attempts.get(callId) || 0) + 1
        attempts.set(callId, attempt)
        if (typeof ack === 'function') ack(attempt === 1 && callId.endsWith('_1')
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', args: { index: 1 } }, 'run-parallel_part_0', 'run-parallel',
    )
    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', args: { index: 2 } }, 'run-parallel_part_0', 'run-parallel',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', output: 'first result',
    })
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', output: 'second result',
    })
    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-parallel')

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    const toolCallIds = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'assistant' && call[1]?.tool_calls)
      .map((call: any[]) => call[1].tool_calls[0].id)
    expect(toolCallIds).toHaveLength(2)
    expect(resultPayloads.map((payload: any) => [payload.tool_call_id, payload.content])).toEqual([
      [toolCallIds[0], 'first result'],
      [toolCallIds[1], 'second result'],
      [toolCallIds[0], 'first result'],
    ])
    expect((client as any).pendingToolRunIds.size).toBe(0)
    client.disconnect()
  })

  it('keeps sequential acknowledged anonymous tool ids distinct when wall time does not advance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1775860000000)
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const output of ['first', 'second']) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', args: {} },
        'run-sequential_part_0', 'run-sequential',
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', output,
      })
    }

    const toolCallIds = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'assistant' && call[1]?.tool_calls)
      .map((call: any[]) => call[1].tool_calls[0].id)
    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(toolCallIds).toHaveLength(2)
    expect(new Set(toolCallIds).size).toBe(2)
    expect(new Set(resultPayloads.map((payload: any) => payload.id)).size).toBe(2)
    expect(resultPayloads.map((payload: any) => payload.tool_call_id)).toEqual(toolCallIds)
    client.disconnect()
  })

  it('keeps colliding sanitized tool call ids distinct in persisted message ids', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const toolCallId of ['call/a', 'call?a']) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: toolCallId, args: {} },
        'run-collision_part_0', 'run-collision',
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: toolCallId, output: toolCallId,
      })
    }

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(resultPayloads).toHaveLength(2)
    expect(new Set(resultPayloads.map((payload: any) => payload.id)).size).toBe(2)
    expect(resultPayloads.map((payload: any) => payload.tool_call_id)).toEqual(['call/a', 'call?a'])
    client.disconnect()
  })

  it('bounds long persisted tool message ids without changing external tool call ids', async () => {
    const resultAttempts = new Map<string, number>()
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        const toolCallId = String(payload.tool_call_id)
        const attempt = (resultAttempts.get(toolCallId) || 0) + 1
        resultAttempts.set(toolCallId, attempt)
        if (typeof ack === 'function') ack(attempt === 1
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)
    const runMessageId = `${'r'.repeat(153)}_part_0`
    const toolCallIds = [`call_${'x'.repeat(74)}a`, `call_${'x'.repeat(74)}b`]

    for (const toolCallId of toolCallIds) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: toolCallId, args: {} },
        runMessageId, 'run-long',
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: toolCallId, output: toolCallId,
      })
    }
    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-long')

    const messagePayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message')
      .map((call: any[]) => call[1])
    expect(messagePayloads.every((payload: any) => payload.id.length <= 160)).toBe(true)

    const toolCallPayloads = messagePayloads.filter((payload: any) => payload.role === 'assistant')
    expect(toolCallPayloads.map((payload: any) => payload.tool_calls[0].id)).toEqual(toolCallIds)
    expect(toolCallPayloads.every((payload: any) => payload.id.includes('_toolcall_'))).toBe(true)

    const resultPayloads = messagePayloads.filter((payload: any) => payload.role === 'tool')
    expect(resultPayloads.map((payload: any) => payload.tool_call_id)).toEqual([
      toolCallIds[0], toolCallIds[1], toolCallIds[0], toolCallIds[1],
    ])
    expect(resultPayloads.every((payload: any) => payload.id.includes('_toolresult_'))).toBe(true)
    for (const toolCallId of toolCallIds) {
      const ids = resultPayloads
        .filter((payload: any) => payload.tool_call_id === toolCallId)
        .map((payload: any) => payload.id)
      expect(new Set(ids).size).toBe(1)
    }
    expect(new Set(resultPayloads.map((payload: any) => payload.id)).size).toBe(2)
    client.disconnect()
  })

  it('retries terminal tool persistence with stable ids until bounded success', async () => {
    let resultAttempts = 0
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        resultAttempts += 1
        if (typeof ack === 'function') ack(resultAttempts < 3
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: 'call-bounded-retry', args: {} },
      'run-bounded-retry_part_0', 'run-bounded-retry',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-bounded-retry', output: 'preserved',
    })
    await (client as any).completePendingToolsForRun('room-1', 'session-1', 'run-bounded-retry')

    expect(resultAttempts).toBe(3)
    const ids = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1].id)
    expect(new Set(ids)).toEqual(new Set(['run-bounded-retry_part_0_toolresult_call-bounded-retry']))
    expect((client as any).pendingToolRunIds.size).toBe(0)
    client.disconnect()
  })

  it('clears retained tool recovery state on explicit disconnect', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        if (typeof ack === 'function') ack({ error: 'persistent Room failure' })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)
    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: 'call-disconnect', args: {} },
      'run-disconnect_part_0', 'run-disconnect',
    )
    await (client as any).recordToolCompleted('room-1', 'session-1', {
      event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-disconnect', output: 'retained',
    })
    expect((client as any).pendingToolCompletionEvents.size).toBe(1)

    client.disconnect()

    expect((client as any).pendingToolCallIds.size).toBe(0)
    expect((client as any).pendingToolBaseIds.size).toBe(0)
    expect((client as any).pendingToolRunIds.size).toBe(0)
    expect((client as any).pendingToolNames.size).toBe(0)
    expect((client as any).pendingToolExternalIds.size).toBe(0)
    expect((client as any).pendingToolCompletionEvents.size).toBe(0)
  })

  it('discards only the stale run tool recovery state after bounded reconciliation', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        if (typeof ack === 'function') ack({ error: 'stale session' })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const [toolCallId, runId] of [['call-stale', 'run-stale'], ['call-current', 'run-current']]) {
      await (client as any).recordToolStarted(
        'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: toolCallId, args: {} },
        `${runId}_part_0`, runId,
      )
      await (client as any).recordToolCompleted('room-1', 'session-1', {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: toolCallId, output: toolCallId,
      })
    }

    ;(client as any).discardPendingToolsForRun('run-stale')

    expect(Array.from((client as any).pendingToolRunIds.values())).toEqual(['run-current'])
    expect((client as any).pendingToolBaseIds.size).toBe(1)
    expect((client as any).pendingToolNames.size).toBe(1)
    expect((client as any).pendingToolExternalIds.size).toBe(1)
    expect((client as any).pendingToolCompletionEvents.size).toBe(1)
    client.disconnect()
  })

  it('ignores a replayed acknowledged tool completion', async () => {
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (typeof ack === 'function') ack({ id: payload?.id })
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)
    await (client as any).recordToolStarted(
      'room-1', 'session-1', { tool_name: 'lookup', tool_call_id: 'call-replay', args: {} },
      'run-replay_part_0', 'run-replay',
    )
    const completion = {
      event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-replay', output: 'one result',
    }
    await (client as any).recordToolCompleted('room-1', 'session-1', completion)
    await (client as any).recordToolCompleted('room-1', 'session-1', completion)

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
    expect(resultPayloads).toHaveLength(1)
    client.disconnect()
  })

  it('keeps reused native tool call ids isolated across rooms and runs', async () => {
    const attempts = new Map<string, number>()
    mockSocket.emit.mockImplementation((event: string, payload?: any, ack?: Function) => {
      if (event === 'message' && payload?.role === 'tool') {
        const key = `${payload.roomId}:${payload.run_id}`
        const attempt = (attempts.get(key) || 0) + 1
        attempts.set(key, attempt)
        if (typeof ack === 'function') ack(attempt === 1
          ? { error: 'temporary Room persistence failure' }
          : { id: payload.id })
      } else if (typeof ack === 'function') {
        ack({ id: payload?.id })
      }
      return mockSocket
    })
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0,
    } as any)

    for (const [roomId, runId] of [['room-1', 'run-1'], ['room-2', 'run-2']]) {
      await (client as any).recordToolStarted(
        roomId, `session-${roomId}`, { tool_name: 'lookup', tool_call_id: 'call-shared', args: { roomId } },
        `${runId}_part_0`, runId,
      )
    }
    for (const [roomId, runId] of [['room-1', 'run-1'], ['room-2', 'run-2']]) {
      await (client as any).recordToolCompleted(roomId, `session-${roomId}`, {
        event: 'tool.completed', tool_name: 'lookup', tool_call_id: 'call-shared', output: `${roomId} result`,
      })
      await (client as any).completePendingToolsForRun(roomId, `session-${roomId}`, runId)
    }

    const resultPayloads = mockSocket.emit.mock.calls
      .filter((call: any[]) => call[0] === 'message' && call[1]?.role === 'tool')
      .map((call: any[]) => call[1])
    expect(resultPayloads.map((payload: any) => [payload.roomId, payload.run_id, payload.content])).toEqual([
      ['room-1', 'run-1', 'room-1 result'],
      ['room-1', 'run-1', 'room-1 result'],
      ['room-2', 'run-2', 'room-2 result'],
      ['room-2', 'run-2', 'room-2 result'],
    ])
    expect((client as any).pendingToolRunIds.size).toBe(0)
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
