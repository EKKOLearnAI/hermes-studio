import { describe, expect, it, vi } from 'vitest'
import { countTokens } from '../../packages/server/src/lib/context-compressor'
import {
  estimateGroupHistoryMessageTokens,
  groupBridgeReasoningDeltaFromEvent,
  groupContextTokensWithFixedOverhead,
} from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { ContextEngine } from '../../packages/server/src/services/hermes/context-engine/compressor'
import type {
  GatewayCaller,
  MessageFetcher,
  StoredMessage,
} from '../../packages/server/src/services/hermes/context-engine/types'
import {
  sliceGroupMessagesCanonical,
  sliceGroupMessagesForSnapshotTail,
  sortGroupMessagesCanonical,
} from '../../packages/server/src/services/hermes/group-chat/group-message-ordering'

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

function makeFetcher(messages: StoredMessage[], snapshot: ReturnType<MessageFetcher['getContextSnapshot']> = null): MessageFetcher {
  return {
    getMessagesForContext: vi.fn((_roomId: string, cutoff) => sliceGroupMessagesCanonical(messages, cutoff).messages),
    getContextSnapshot: vi.fn(() => snapshot),
    saveContextSnapshot: vi.fn(),
    deleteContextSnapshot: vi.fn(),
  }
}

function makeEngine(fetcher: MessageFetcher, summarize = vi.fn()): { engine: ContextEngine; summarize: ReturnType<typeof vi.fn> } {
  const gatewayCaller: GatewayCaller = {
    summarize: summarize.mockResolvedValue({ summary: 'Updated summary', sessionId: 'summary-session' }),
  }
  return {
    engine: new ContextEngine({
      config: { triggerTokens: 100_000, maxHistoryTokens: 32_000, tailMessageCount: 10, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller,
    }),
    summarize,
  }
}

describe('group chat fixed context cache helpers', () => {
  it('adds cached fixed context to group chat message tokens', () => {
    const history = [
      { role: 'user', content: '[Alice]: hello' },
      { role: 'assistant', content: '[Bot]: hi there' },
    ]

    const messageTokens = estimateGroupHistoryMessageTokens(history)

    expect(messageTokens).toBe(countTokens('[Alice]: hello') + countTokens('[Bot]: hi there'))
    expect(groupContextTokensWithFixedOverhead(20_000, history)).toBe(20_000 + messageTokens)
  })

  it('signals fallback when fixed context is unavailable', () => {
    expect(groupContextTokensWithFixedOverhead(undefined, [{ content: 'hello' }])).toBeUndefined()
    expect(groupContextTokensWithFixedOverhead(null, [{ content: 'hello' }])).toBeUndefined()
  })

  it('keeps spinner thinking events out of persisted group-chat reasoning', () => {
    expect(groupBridgeReasoningDeltaFromEvent({
      event: 'thinking.delta',
      text: '(◕‿◕✿) pondering...',
    })).toBeNull()
    expect(groupBridgeReasoningDeltaFromEvent({
      event: 'reasoning.delta',
      text: 'real reasoning',
    })).toBe('real reasoning')
    expect(groupBridgeReasoningDeltaFromEvent({
      event: 'reasoning.delta',
      text: '',
    })).toBeNull()
  })
})

describe('group chat context cursors', () => {
  it('orders multipart assistant/toolcall/toolresult groups canonically before cursor slicing', () => {
    const ordered = sortGroupMessagesCanonical([
      makeMessage({ id: 'run-1_part_1_toolcall_weather', content: 'call-2', timestamp: 1_000, role: 'assistant' }),
      makeMessage({ id: 'run-1_part_0_toolresult_weather', content: 'result-1', timestamp: 1_000, role: 'tool' }),
      makeMessage({ id: 'run-1_part_1', content: 'assistant-2', timestamp: 1_000, role: 'assistant' }),
      makeMessage({ id: 'run-1_part_0', content: 'assistant-1', timestamp: 1_000, role: 'assistant' }),
      makeMessage({ id: 'run-1_part_1_toolresult_weather', content: 'result-2', timestamp: 1_000, role: 'tool' }),
      makeMessage({ id: 'run-1_part_0_toolcall_weather', content: 'call-1', timestamp: 1_000, role: 'assistant' }),
      makeMessage({ id: 'run-2', content: 'later run', timestamp: 2_000, role: 'assistant' }),
    ])

    expect(ordered.map(message => message.id)).toEqual([
      'run-1_part_0',
      'run-1_part_0_toolcall_weather',
      'run-1_part_0_toolresult_weather',
      'run-1_part_1',
      'run-1_part_1_toolcall_weather',
      'run-1_part_1_toolresult_weather',
      'run-2',
    ])

    const snapshotTail = sliceGroupMessagesForSnapshotTail(ordered, 'run-1_part_0_toolresult_weather')
    expect(snapshotTail.snapshotCursorFound).toBe(true)
    expect(snapshotTail.messages.map(message => message.id)).toEqual([
      'run-1_part_1',
      'run-1_part_1_toolcall_weather',
      'run-1_part_1_toolresult_weather',
      'run-2',
    ])
  })

  it('uses the current message id as the same-timestamp context boundary', async () => {
    const messages = sortGroupMessagesCanonical([
      makeMessage({ id: 'm1', content: 'first', timestamp: 1_000 }),
      makeMessage({ id: 'm2', content: 'second', timestamp: 1_000 }),
      makeMessage({ id: 'm3', content: 'third', timestamp: 1_000 }),
    ])
    const fetcher = makeFetcher(messages)
    const { engine, summarize } = makeEngine(fetcher)

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket',
      roomName: 'general',
      memberNames: ['Alice'],
      members: [{ userId: 'user-1', name: 'Alice', description: '' }],
      upstream: '',
      apiKey: null,
      currentMessage: messages[1],
    })

    expect(fetcher.getMessagesForContext).toHaveBeenCalledWith('room-1', { throughMessageId: 'm2' })
    expect(result.conversationHistory.map(message => message.content)).toEqual([
      '[Alice]: first',
      '[Alice]: second',
    ])
    expect(summarize).not.toHaveBeenCalled()
  })

  it('increments snapshots from lastMessageId even when timestamps are identical', async () => {
    const messages = sortGroupMessagesCanonical([
      makeMessage({ id: 'm1', content: 'first', timestamp: 1_000 }),
      makeMessage({ id: 'm2', content: 'second', timestamp: 1_000 }),
      makeMessage({ id: 'm3', content: 'third', timestamp: 1_000 }),
    ])
    const fetcher = makeFetcher(messages, {
      roomId: 'room-1',
      summary: 'Earlier summary',
      lastMessageId: 'm1',
      lastMessageTimestamp: 1_000,
      updatedAt: Date.now(),
    })
    const { engine, summarize } = makeEngine(fetcher)

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket',
      roomName: 'general',
      memberNames: ['Alice'],
      members: [{ userId: 'user-1', name: 'Alice', description: '' }],
      upstream: '',
      apiKey: null,
      currentMessage: messages[2],
    })

    expect(result.conversationHistory.map(message => message.content)).toEqual([
      '[Previous conversation summary]\nEarlier summary',
      'I have reviewed the conversation history and understand the context.',
      '[Alice]: second',
      '[Alice]: third',
    ])
    expect(summarize).not.toHaveBeenCalled()
  })

  it('preserves snapshot summaries when the snapshot anchor was pruned from retained history', async () => {
    const messages = sortGroupMessagesCanonical([
      makeMessage({ id: 'm2', content: 'second', timestamp: 1_000 }),
      makeMessage({ id: 'm3', content: 'third', timestamp: 1_000 }),
    ])
    const fetcher = makeFetcher(messages, {
      roomId: 'room-1',
      summary: 'Stale summary',
      lastMessageId: 'm1',
      lastMessageTimestamp: 1_000,
      updatedAt: Date.now(),
    })
    const { engine, summarize } = makeEngine(fetcher)

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket',
      roomName: 'general',
      memberNames: ['Alice'],
      members: [{ userId: 'user-1', name: 'Alice', description: '' }],
      upstream: '',
      apiKey: null,
      currentMessage: messages[1],
    })

    expect(result.conversationHistory.map(message => message.content)).toEqual([
      '[Previous conversation summary]\nStale summary',
      'I have reviewed the conversation history and understand the context.',
      '[Alice]: second',
      '[Alice]: third',
    ])
    expect(result.meta.hadSnapshot).toBe(true)
    expect(result.meta.verbatimCount).toBe(2)
    expect(summarize).not.toHaveBeenCalled()
  })
})


describe('group chat fallback trimming', () => {
  it('drops oldest verbatim turns first when full compression falls back to trimming', async () => {
    const messages = Array.from({ length: 6 }, (_value, index) => makeMessage({
      id: `m${index + 1}`,
      timestamp: index + 1,
      content: `message-${index + 1} `.repeat(10),
    }))
    const fetcher = makeFetcher(messages)
    const summarize = vi.fn().mockRejectedValue(new Error('summary unavailable'))
    const gatewayCaller: GatewayCaller = { summarize }
    const engine = new ContextEngine({
      config: { triggerTokens: 1, maxHistoryTokens: 60, tailMessageCount: 2, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller,
    })

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket',
      roomName: 'general',
      memberNames: ['Alice'],
      members: [{ userId: 'user-1', name: 'Alice', description: '' }],
      upstream: '',
      apiKey: null,
      currentMessage: messages[messages.length - 1],
      contextTokenEstimator: vi.fn().mockResolvedValue(999),
    })

    expect(result.conversationHistory.some(message => message.content.includes('message-1'))).toBe(false)
    expect(result.conversationHistory.some(message => message.content.includes('message-2'))).toBe(false)
    expect(result.conversationHistory).toHaveLength(2)
    expect(result.conversationHistory[0]?.content).toContain('message-5')
    expect(result.conversationHistory[1]?.content).toContain('message-6')
  })

  it('preserves the summary prefix while trimming oldest post-summary turns first', async () => {
    const messages = Array.from({ length: 5 }, (_value, index) => makeMessage({
      id: `m${index + 1}`,
      timestamp: index + 1,
      content: `message-${index + 1} `.repeat(10),
    }))
    const fetcher = makeFetcher(messages, {
      roomId: 'room-1',
      summary: 'Earlier summary',
      lastMessageId: 'm1',
      lastMessageTimestamp: 1,
      updatedAt: Date.now(),
    })
    const summarize = vi.fn().mockRejectedValue(new Error('summary unavailable'))
    const gatewayCaller: GatewayCaller = { summarize }
    const engine = new ContextEngine({
      config: { triggerTokens: 1, maxHistoryTokens: 90, tailMessageCount: 2, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller,
    })

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket',
      roomName: 'general',
      memberNames: ['Alice'],
      members: [{ userId: 'user-1', name: 'Alice', description: '' }],
      upstream: '',
      apiKey: null,
      currentMessage: messages[messages.length - 1],
      contextTokenEstimator: vi.fn().mockResolvedValue(999),
    })

    expect(result.conversationHistory[0]).toEqual({ role: 'user', content: '[Previous conversation summary]\nEarlier summary' })
    expect(result.conversationHistory[1]).toEqual({ role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' })
    expect(result.conversationHistory.some(message => message.content.includes('message-2'))).toBe(false)
    expect(result.conversationHistory[2]?.content).toContain('message-4')
    expect(result.conversationHistory[3]?.content).toContain('message-5')
  })

  it('keeps the newest verbatim turn even when full fallback budget is smaller than a single message', async () => {
    const messages = Array.from({ length: 4 }, (_value, index) => makeMessage({
      id: `m${index + 1}`,
      timestamp: index + 1,
      content: `message-${index + 1} `.repeat(10),
    }))
    const fetcher = makeFetcher(messages)
    const summarize = vi.fn().mockRejectedValue(new Error('summary unavailable'))
    const gatewayCaller: GatewayCaller = { summarize }
    const engine = new ContextEngine({
      config: { triggerTokens: 1, maxHistoryTokens: 1, tailMessageCount: 2, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller,
    })

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket',
      roomName: 'general',
      memberNames: ['Alice'],
      members: [{ userId: 'user-1', name: 'Alice', description: '' }],
      upstream: '',
      apiKey: null,
      currentMessage: messages[messages.length - 1],
      contextTokenEstimator: vi.fn().mockResolvedValue(999),
    })

    expect(result.conversationHistory).toHaveLength(1)
    expect(result.conversationHistory[0]?.content).toContain('message-4')
  })

  it('keeps the summary prefix and newest verbatim turn when snapshot fallback budget is tiny', async () => {
    const messages = Array.from({ length: 5 }, (_value, index) => makeMessage({
      id: `m${index + 1}`,
      timestamp: index + 1,
      content: `message-${index + 1} `.repeat(10),
    }))
    const fetcher = makeFetcher(messages, {
      roomId: 'room-1',
      summary: 'Earlier summary',
      lastMessageId: 'm1',
      lastMessageTimestamp: 1,
      updatedAt: Date.now(),
    })
    const summarize = vi.fn().mockRejectedValue(new Error('summary unavailable'))
    const gatewayCaller: GatewayCaller = { summarize }
    const engine = new ContextEngine({
      config: { triggerTokens: 1, maxHistoryTokens: 1, tailMessageCount: 2, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller,
    })

    const result = await engine.buildContext({
      roomId: 'room-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      agentDescription: '',
      agentSocketId: 'agent-socket',
      roomName: 'general',
      memberNames: ['Alice'],
      members: [{ userId: 'user-1', name: 'Alice', description: '' }],
      upstream: '',
      apiKey: null,
      currentMessage: messages[messages.length - 1],
      contextTokenEstimator: vi.fn().mockResolvedValue(999),
    })

    expect(result.conversationHistory).toEqual([
      { role: 'user', content: '[Previous conversation summary]\nEarlier summary' },
      { role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' },
      expect.objectContaining({ role: 'user', content: expect.stringContaining('message-5') }),
    ])
  })
})
