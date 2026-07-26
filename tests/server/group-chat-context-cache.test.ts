import { describe, expect, it, vi } from 'vitest'
import { countTokens } from '../../packages/server/src/lib/context-compressor'
import {
  effectiveGroupCompressionConfig,
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

describe('group chat participant context budgets', () => {
  it('clamps a Room threshold to 60 percent of a small participant model window', () => {
    expect(effectiveGroupCompressionConfig({
      triggerTokens: 100_000,
      maxHistoryTokens: 32_000,
      tailMessageCount: 10,
    }, 64_000)).toEqual({
      triggerTokens: 38_400,
      maxHistoryTokens: 19_200,
      tailMessageCount: 10,
    })
  })

  it('preserves the default 100k Room threshold for the existing unknown-model 256k fallback', () => {
    expect(effectiveGroupCompressionConfig({
      triggerTokens: 100_000,
      maxHistoryTokens: 32_000,
      tailMessageCount: 10,
    }, 256_000)).toEqual({
      triggerTokens: 100_000,
      maxHistoryTokens: 32_000,
      tailMessageCount: 10,
    })
  })
})

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

  it('keeps snapshot tails anchored in canonical presentation order when room sequence differs', () => {
    const messages = [
      makeMessage({ id: 'presentation-first', roomSeq: 2, content: 'first by time', timestamp: 1 }),
      makeMessage({ id: 'snapshot-anchor', roomSeq: 1, content: 'anchor by time', timestamp: 2 }),
      makeMessage({ id: 'presentation-tail', roomSeq: 3, content: 'tail by time', timestamp: 3 }),
    ]

    const snapshotTail = sliceGroupMessagesForSnapshotTail(messages, 'snapshot-anchor')

    expect(snapshotTail.snapshotCursorFound).toBe(true)
    expect(snapshotTail.messages.map(message => message.id)).toEqual(['presentation-tail'])
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
      authorizationGuard: () => true,
      summarySessionRegistrar: () => ({ sessionId: `gc_h_${'a'.repeat(32)}`, authorizationGuard: () => true, release: () => undefined }),
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
      authorizationGuard: () => true,
      summarySessionRegistrar: () => ({ sessionId: `gc_h_${'a'.repeat(32)}`, authorizationGuard: () => true, release: () => undefined }),
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

  it('uses a sequence-bounded participant checkpoint before retained verbatim messages', async () => {
    const messages = [
      makeMessage({ id: 'm25', roomSeq: 25, timestamp: 25, content: 'retained 25' }),
      makeMessage({ id: 'm26', roomSeq: 26, timestamp: 26, content: 'retained 26' }),
      makeMessage({ id: 'm27', roomSeq: 27, timestamp: 27, content: 'trigger 27' }),
      makeMessage({ id: 'future', roomSeq: 28, timestamp: 28, content: 'future must not leak' }),
    ]
    const fetcher = makeFetcher(messages)
    const { engine, summarize } = makeEngine(fetcher)

    const result = await engine.buildContext({
      roomId: 'room-1', agentId: 'agent-1', agentName: 'Worker', agentDescription: '',
      agentSocketId: 'agent-socket', roomName: 'general', memberNames: [], members: [],
      upstream: '', apiKey: null, currentMessage: messages[2], participantCursor: 20,
      participantCheckpoint: {
        summary: 'Summary of Room messages 21 through 24',
        fromRoomSeq: 21,
        throughRoomSeq: 24,
      },
    })

    expect(fetcher.getMessagesForContext).toHaveBeenCalledWith('room-1', {
      afterRoomSeq: 24,
      throughRoomSeq: 27,
    })
    expect(result.conversationHistory.map(message => message.content)).toEqual([
      '[Previous conversation summary]\nSummary of Room messages 21 through 24',
      'I have reviewed the conversation history and understand the context.',
      '[Alice]: retained 25',
      '[Alice]: retained 26',
      '[Alice]: trigger 27',
    ])
    expect(result.conversationHistory.some(message => message.content.includes('future must not leak'))).toBe(false)
    expect(summarize).not.toHaveBeenCalled()
    expect(fetcher.saveContextSnapshot).not.toHaveBeenCalled()
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
      authorizationGuard: () => true,
      summarySessionRegistrar: () => ({ sessionId: `gc_h_${'a'.repeat(32)}`, authorizationGuard: () => true, release: () => undefined }),
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


describe('group chat post-compression budget fitting', () => {
  it('trims the oldest compressed tail before saving the fitted snapshot boundary', async () => {
    const messages = Array.from({ length: 6 }, (_value, index) => makeMessage({
      id: `m${index + 1}`,
      roomSeq: index + 1,
      timestamp: index + 1,
      content: `message-${index + 1}-${'x'.repeat(72)}`,
    }))
    const fetcher = makeFetcher(messages)
    const summarize = vi.fn().mockResolvedValue({ summary: 'Compact summary', sessionId: 'summary-session' })
    const engine = new ContextEngine({
      config: { triggerTokens: 100, maxHistoryTokens: 80, tailMessageCount: 3, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller: { summarize },
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
      contextTokenEstimator: vi.fn(async history => history.length > 3 ? 101 : 90),
    })

    expect(result.meta.contextTokenEstimate).toBeLessThanOrEqual(100)
    expect(result.conversationHistory.some(message => message.content.includes('message-4'))).toBe(false)
    expect(result.conversationHistory.some(message => message.content.includes('message-5'))).toBe(false)
    expect(result.conversationHistory.some(message => message.content.includes('message-6'))).toBe(true)
    expect(fetcher.saveContextSnapshot).toHaveBeenCalledWith('room-1', 'Compact summary', 'm6', 6, 6)
  })

  it('anchors a compressed snapshot at the highest Room sequence despite reversed clocks', async () => {
    const messages = [
      makeMessage({ id: 'seq-1', roomSeq: 1, timestamp: 100, content: 'later clock '.repeat(10) }),
      makeMessage({ id: 'seq-2', roomSeq: 2, timestamp: 1, content: 'earlier clock '.repeat(10) }),
    ]
    const fetcher = makeFetcher(messages)
    const engine = new ContextEngine({
      config: { triggerTokens: 10, maxHistoryTokens: 100, tailMessageCount: 1, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller: {
        summarize: vi.fn().mockResolvedValue({ summary: 'Summary through sequence 2', sessionId: 'summary-session' }),
      },
    })

    await engine.buildContext({
      roomId: 'room-1', agentId: 'agent-1', agentName: 'Worker', agentDescription: '',
      agentSocketId: 'agent-socket', roomName: 'general', memberNames: [], members: [],
      upstream: '', apiKey: null, currentMessage: messages[1],
      contextTokenEstimator: vi.fn().mockResolvedValueOnce(100).mockResolvedValue(8),
    })

    expect(fetcher.saveContextSnapshot).toHaveBeenCalledWith(
      'room-1', 'Summary through sequence 2', 'seq-2', 1, 2,
    )
  })

  it('refuses an oversized compressed result without advancing the snapshot', async () => {
    const messages = Array.from({ length: 4 }, (_value, index) => makeMessage({
      id: `m${index + 1}`,
      roomSeq: index + 1,
      timestamp: index + 1,
      content: `message-${index + 1}-${'x'.repeat(40)}`,
    }))
    const fetcher = makeFetcher(messages)
    const engine = new ContextEngine({
      config: { triggerTokens: 60, maxHistoryTokens: 30, tailMessageCount: 2, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
      messageFetcher: fetcher,
      gatewayCaller: {
        summarize: vi.fn().mockResolvedValue({ summary: 'Oversized summary '.repeat(20), sessionId: 'summary-session' }),
      },
    })

    await expect(engine.buildContext({
      roomId: 'room-1', agentId: 'agent-1', agentName: 'Worker', agentDescription: '',
      agentSocketId: 'agent-socket', roomName: 'general', memberNames: [], members: [],
      upstream: '', apiKey: null, currentMessage: messages[messages.length - 1],
      contextTokenEstimator: vi.fn().mockResolvedValueOnce(100).mockResolvedValue(500),
    })).rejects.toThrow('Compressed context is still too large')

    expect(fetcher.saveContextSnapshot).not.toHaveBeenCalled()
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
      authorizationGuard: () => true,
      summarySessionRegistrar: () => ({ sessionId: `gc_h_${'a'.repeat(32)}`, authorizationGuard: () => true, release: () => undefined }),
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
      authorizationGuard: () => true,
      summarySessionRegistrar: () => ({ sessionId: `gc_h_${'a'.repeat(32)}`, authorizationGuard: () => true, release: () => undefined }),
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
      authorizationGuard: () => true,
      summarySessionRegistrar: () => ({ sessionId: `gc_h_${'a'.repeat(32)}`, authorizationGuard: () => true, release: () => undefined }),
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
      authorizationGuard: () => true,
      summarySessionRegistrar: () => ({ sessionId: `gc_h_${'a'.repeat(32)}`, authorizationGuard: () => true, release: () => undefined }),
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
