import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SummaryCache } from '../../packages/server/src/services/hermes/context-engine/summary-cache'
import {
    buildAgentInstructions,
    buildSummarizationSystemPrompt,
    buildFullSummaryPrompt,
    buildIncrementalUpdatePrompt,
} from '../../packages/server/src/services/hermes/context-engine/prompt'
import { ContextEngine } from '../../packages/server/src/services/hermes/context-engine/compressor'
import type { StoredMessage, MessageFetcher, GatewayCaller } from '../../packages/server/src/services/hermes/context-engine/types'

// ─── Helpers ─────────────────────────────────────────────────

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
    return {
        id: 'msg-1',
        roomId: 'room-1',
        senderId: 'user-1',
        senderName: 'Alice',
        content: 'Hello world',
        timestamp: 1000,
        ...overrides,
    }
}

function makeMessages(count: number, roomId = 'room-1', startTimestamp = 1000): StoredMessage[] {
    return Array.from({ length: count }, (_, i) => makeMessage({
        id: `msg-${i}`,
        roomId,
        senderId: i % 3 === 0 ? 'agent-socket' : `user-${i}`,
        senderName: i % 3 === 0 ? 'Claude' : `User${i}`,
        content: `Message ${i} with some content`,
        timestamp: startTimestamp + i * 1000,
    }))
}

// ─── SummaryCache ─────────────────────────────────────────────

describe('SummaryCache', () => {
    it('stores and retrieves entries', () => {
        const cache = new SummaryCache(60_000)
        cache.set('room-1', {
            summary: 'Summary text',
            lastMessageId: 'msg-10',
            lastMessageTimestamp: 5000,
            createdAt: Date.now(),
        })
        const entry = cache.get('room-1')
        expect(entry).toBeDefined()
        expect(entry!.summary).toBe('Summary text')
    })

    it('returns undefined for expired entries', () => {
        const cache = new SummaryCache(100) // 100ms TTL
        cache.set('room-1', {
            summary: 'Old summary',
            lastMessageId: 'msg-5',
            lastMessageTimestamp: 5000,
            createdAt: Date.now() - 200, // created 200ms ago
        })
        expect(cache.get('room-1')).toBeUndefined()
    })

    it('invalidates entries for a room', () => {
        const cache = new SummaryCache(60_000)
        cache.set('room-1', { summary: 'A', lastMessageId: 'msg-1', lastMessageTimestamp: 1000, createdAt: Date.now() })
        cache.set('room-2', { summary: 'C', lastMessageId: 'msg-3', lastMessageTimestamp: 3000, createdAt: Date.now() })

        cache.invalidate('room-1')
        expect(cache.get('room-1')).toBeUndefined()
        expect(cache.get('room-2')).toBeDefined()
    })

    it('enforces max entry limit', () => {
        const cache = new SummaryCache(60_000)
        // Fill cache beyond limit (internal MAX_ENTRIES = 200)
        for (let i = 0; i < 210; i++) {
            cache.set(`room-${i}`, {
                summary: `Summary ${i}`,
                lastMessageId: `msg-${i}`,
                lastMessageTimestamp: i * 1000,
                createdAt: Date.now() - (210 - i), // earlier entries have older createdAt
            })
        }
        // Cache should not exceed 200 entries
        expect(cache.size).toBeLessThanOrEqual(200)
    })
})

// ─── Prompts ──────────────────────────────────────────────────

describe('prompts', () => {
    it('builds agent instructions with all fields', () => {
        const result = buildAgentInstructions({
            agentName: 'Claude',
            roomName: 'general',
            agentDescription: 'AI coding assistant',
            memberNames: ['Alice', 'Bob', 'Claude'],
            members: [
                { userId: 'u1', name: 'Alice', description: 'dev' },
                { userId: 'u2', name: 'Bob', description: 'designer' },
                { userId: 'u3', name: 'Claude', description: '' },
            ],
        })
        expect(result).toContain('"Claude"')
        expect(result).toContain('general')
        expect(result).toContain('AI coding assistant')
        expect(result).toContain('Alice')
        expect(result).toContain('Bob')
        expect(result).toContain('@Claude')
    })

    it('builds agent instructions with empty member list', () => {
        const result = buildAgentInstructions({
            agentName: 'GPT',
            roomName: 'dev',
            agentDescription: 'Helper',
            memberNames: [],
            members: [],
        })
        expect(result).toContain('"GPT"')
        expect(result).toContain('未知')
    })

    it('builds agent instructions using memberNames when members is empty', () => {
        const result = buildAgentInstructions({
            agentName: 'GPT',
            roomName: 'dev',
            agentDescription: 'Helper',
            memberNames: ['Alice', 'Bob'],
            members: [],
        })
        expect(result).toContain('Alice')
        expect(result).toContain('Bob')
    })

    it('builds summarization system prompt', () => {
        const result = buildSummarizationSystemPrompt()
        expect(result).toContain('摘要')
    })

    it('builds full summary prompt', () => {
        const result = buildFullSummaryPrompt()
        expect(result).toContain('摘要')
    })

    it('builds incremental update prompt', () => {
        const result = buildIncrementalUpdatePrompt()
        expect(result).toContain('更新')
    })
})

// ─── ContextEngine.buildContext ────────────────────────────────

describe('ContextEngine.buildContext', () => {
    let mockSummarize = vi.fn().mockResolvedValue({ summary: 'Summary of conversation.', sessionId: 'comp-1' })
    const mockGatewayCaller: GatewayCaller = {
        summarize: mockSummarize,
    }

    let mockFetcher: MessageFetcher
    let engine: ContextEngine

    beforeEach(() => {
        vi.clearAllMocks()
        mockFetcher = {
            getMessages: vi.fn().mockReturnValue([]),
            getContextSnapshot: vi.fn().mockReturnValue(null),
            saveContextSnapshot: vi.fn(),
            deleteContextSnapshot: vi.fn(),
        }
        engine = new ContextEngine({
            config: { maxHistoryTokens: 4000, tailMessageCount: 10, triggerTokens: 100_000, charsPerToken: 4, summarizationTimeoutMs: 30_000 },
            messageFetcher: mockFetcher,
            gatewayCaller: { summarize: mockSummarize },
        })
    })

    it('returns all messages as history when under threshold', async () => {
        const messages = makeMessages(10) // 10 messages, under trigger threshold
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        const result = await engine.buildContext({
            roomId: 'room-1',
            agentId: 'agent-1',
            agentName: 'Claude',
            agentDescription: 'Helper',
            agentSocketId: 'agent-socket',
            roomName: 'general',
            memberNames: ['Alice'],
            members: [{ userId: 'u1', name: 'Alice', description: '' }],
            upstream: 'http://localhost:8642',
            apiKey: null,
            currentMessage: messages[messages.length - 1],
        })

        expect(result.meta.totalMessages).toBe(10)
        expect(result.meta.compressed).toBe(false)
        expect(result.conversationHistory).toHaveLength(10)
        expect(result.instructions).toContain('Claude')
        // No LLM call for short conversations
        expect(mockSummarize).not.toHaveBeenCalled()
    })

    it('splits into head/tail and compresses middle when over threshold', async () => {
        const messages = makeMessages(20)
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        const result = await engine.buildContext({
            roomId: 'room-1',
            agentId: 'agent-1',
            agentName: 'Claude',
            agentDescription: 'Helper',
            agentSocketId: 'agent-socket',
            roomName: 'general',
            memberNames: [],
            members: [],
            upstream: 'http://localhost:8642',
            apiKey: null,
            currentMessage: messages[messages.length - 1],
            compression: { triggerTokens: 10 }, // Force compression with tiny threshold
        })

        expect(result.meta.totalMessages).toBe(20)
        expect(result.meta.compressed).toBe(true)
        expect(mockSummarize).toHaveBeenCalledTimes(1)
    })

    it('uses cache hit when available and no new messages', async () => {
        const messages = makeMessages(20)
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        // First call — creates snapshot (with forced compression)
        await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
            compression: { triggerTokens: 10 },
        })

        // Verify snapshot was saved
        expect(mockFetcher.saveContextSnapshot).toHaveBeenCalledTimes(1)

        // Simulate that the snapshot now exists in storage
        const savedSnapshot = mockFetcher.saveContextSnapshot.mock.calls[0]
        mockFetcher.getContextSnapshot = vi.fn().mockReturnValue({
            roomId: 'room-1',
            summary: savedSnapshot[1],
            lastMessageId: savedSnapshot[2],
            lastMessageTimestamp: savedSnapshot[3],
            updatedAt: Date.now(),
        })

        // Second call — cache hit (snapshot exists, same messages)
        const result2 = await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
        })

        expect(result2.meta.hadSnapshot).toBe(true)
        // Only one LLM call (from the first buildContext)
        expect(mockSummarize).toHaveBeenCalledTimes(1)
    })

    it('does incremental update when cache hit with new messages', async () => {
        const messages = makeMessages(20)
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        // First call — full compression (with forced compression)
        await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
            compression: { triggerTokens: 10 },
        })

        // Simulate that the snapshot now exists in storage
        const savedSnapshot = mockFetcher.saveContextSnapshot.mock.calls[0]
        mockFetcher.getContextSnapshot = vi.fn().mockReturnValue({
            roomId: 'room-1',
            summary: savedSnapshot[1],
            lastMessageId: savedSnapshot[2],
            lastMessageTimestamp: savedSnapshot[3],
            updatedAt: Date.now(),
        })

        expect(mockSummarize).toHaveBeenCalledTimes(1)
        // First call: no previousSummary
        // GatewayCaller.summarize signature: upstream, apiKey, systemPrompt, messages, roomId, profile, previousSummary
        const firstCallArgs = mockSummarize.mock.calls[0]
        expect(firstCallArgs[4]).toBe('room-1') // roomId
        expect(firstCallArgs[5]).toBe('default') // profile
        expect(firstCallArgs[6]).toBeUndefined() // previousSummary not passed

        // Insert a new message
        const middleInsert = makeMessage({
            id: 'msg-new', roomId: 'room-1', senderId: 'user-99',
            senderName: 'NewUser', content: 'New middle message', timestamp: 12000,
        })
        const updatedMessages = [...messages.slice(0, 9), middleInsert, ...messages.slice(9)]
        mockFetcher.getMessages = vi.fn().mockReturnValue(updatedMessages)

        // Second call — incremental update
        await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: updatedMessages[updatedMessages.length - 1],
            compression: { triggerTokens: 10 },
        })

        expect(mockSummarize).toHaveBeenCalledTimes(2)
        // Second call: has previousSummary
        const secondCallArgs = mockSummarize.mock.calls[1]
        expect(secondCallArgs[6]).toBe('Summary of conversation.')
    })

    it('falls back to no-summary on LLM failure', async () => {
        mockSummarize.mockRejectedValue(new Error('LLM timeout'))

        const messages = makeMessages(20)
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        const result = await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
            compression: { triggerTokens: 10 },
        })

        // Should not throw, and should still return history
        expect(result.conversationHistory.length).toBeGreaterThan(0)
        // No summary pair in the output
        expect(result.conversationHistory[0]?.content).not.toContain('Previous conversation summary')
    })

    it('trims tail when over token budget', async () => {
        const engine = new ContextEngine({
            config: {
                maxHistoryTokens: 200, // small budget
                tailMessageCount: 10,
                triggerTokens: 10, // force compression
                charsPerToken: 4,
                summarizationTimeoutMs: 30_000,
            },
            messageFetcher: mockFetcher,
            gatewayCaller: { summarize: mockSummarize },
        })

        const messages = makeMessages(20)
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        const result = await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
        })

        // History should be trimmed to fit within 200 tokens
        // Use same estimation logic as compressor: CJK * 1.5 + other / charsPerToken
        const totalChars = result.conversationHistory.reduce((sum, m) => sum + m.content.length, 0)
        const cjk = (result.conversationHistory.map(m => m.content).join('').match(/[⺀-鿿가-힯　-〿＀-￯]/g) || []).length
        const other = totalChars - cjk
        const estimatedTokens = Math.ceil(cjk * 1.5 + other / 4)
        expect(estimatedTokens).toBeLessThanOrEqual(200)
    })

    it('maps agent messages to assistant role', async () => {
        const messages = [
            makeMessage({ senderId: 'user-1', senderName: 'Alice', content: 'Hello', timestamp: 1000 }),
            makeMessage({ senderId: 'agent-socket', senderName: 'Claude', content: 'Hi there', timestamp: 2000 }),
        ]
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        const result = await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
        })

        // First message from user → 'user' role with name prefix
        expect(result.conversationHistory[0].role).toBe('user')
        expect(result.conversationHistory[0].content).toContain('[Alice]')

        // Second message from agent → 'assistant' role, no prefix
        expect(result.conversationHistory[1].role).toBe('assistant')
        expect(result.conversationHistory[1].content).toBe('Hi there')
    })

    it('maps other messages to user role with name prefix', async () => {
        const messages = [
            makeMessage({ senderId: 'user-2', senderName: 'Bob', content: 'Hey', timestamp: 1000 }),
        ]
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        const result = await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
        })

        expect(result.conversationHistory[0].role).toBe('user')
        expect(result.conversationHistory[0].content).toBe('[Bob]: Hey')
    })

    it('generates instructions with agent identity', async () => {
        const messages = makeMessages(1)
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        const result = await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: 'Code helper', agentSocketId: 'agent-socket', roomName: 'dev',
            memberNames: ['Alice', 'Bob'],
            members: [
                { userId: 'u1', name: 'Alice', description: 'dev' },
                { userId: 'u2', name: 'Bob', description: 'designer' },
            ],
            upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[0],
        })

        expect(result.instructions).toContain('"Claude"')
        expect(result.instructions).toContain('Code helper')
        expect(result.instructions).toContain('dev')
        expect(result.instructions).toContain('Alice')
    })

    it('invalidates room cache', async () => {
        // Create a snapshot via the fetcher mock
        mockFetcher.getContextSnapshot = vi.fn().mockReturnValue({
            roomId: 'room-1',
            summary: 'Test',
            lastMessageId: 'msg-10',
            lastMessageTimestamp: 1000,
            updatedAt: Date.now(),
        })

        const messages = makeMessages(5)
        mockFetcher.getMessages = vi.fn().mockReturnValue(messages)

        // Build context to create snapshot
        await engine.buildContext({
            roomId: 'room-1', agentId: 'agent-1', agentName: 'Claude',
            agentDescription: '', agentSocketId: 'agent-socket', roomName: 'general',
            memberNames: [], members: [], upstream: 'http://localhost:8642', apiKey: null,
            currentMessage: messages[messages.length - 1],
        })

        // Invalidate
        engine.invalidateRoom('room-1')
        expect(mockFetcher.deleteContextSnapshot).toHaveBeenCalledWith('room-1')
    })
})
