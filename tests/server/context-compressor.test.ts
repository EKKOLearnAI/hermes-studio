import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCompressionSnapshotMock = vi.fn()
const saveCompressionSnapshotMock = vi.fn()
const deleteCompressionSnapshotMock = vi.fn()
const bridgeRequestMock = vi.fn()
const bridgeDestroyMock = vi.fn()

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
  saveCompressionSnapshot: saveCompressionSnapshotMock,
  deleteCompressionSnapshot: deleteCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: class {
    request = bridgeRequestMock
    destroy = bridgeDestroyMock
  },
}))

describe('ChatContextCompressor', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    getCompressionSnapshotMock.mockReset()
    saveCompressionSnapshotMock.mockReset()
    deleteCompressionSnapshotMock.mockReset()
    bridgeRequestMock.mockReset()
    bridgeDestroyMock.mockReset()
    bridgeRequestMock.mockRejectedValue(new Error('summarizer failed'))
    bridgeDestroyMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('keeps full history when full summarization fails', async () => {
    const { ChatContextCompressor } = await import('../../packages/server/src/lib/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 3 } })
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue(null)

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages).toHaveLength(messages.length)
    expect(result.messages.map(m => m.content)).toEqual(messages.map(m => m.content))
    expect(result.meta.compressed).toBe(false)
    expect(result.meta.llmCompressed).toBe(false)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('keeps all new messages when incremental summarization fails', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/lib/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 3 } })
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 1,
      messageCountAtTime: 2,
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages).toHaveLength(7)
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: `${SUMMARY_PREFIX}\n\nprevious summary`,
    })
    expect(result.messages.slice(1).map(m => m.content)).toEqual(messages.slice(2).map(m => m.content))
    expect(result.meta.compressed).toBe(true)
    expect(result.meta.llmCompressed).toBe(false)
    expect(result.meta.compressedStartIndex).toBe(1)
    expect(result.meta.verbatimCount).toBe(6)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('does not call the summarizer when snapshot has only tail messages after it', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/lib/context-compressor')
    const compressor = new ChatContextCompressor({ config: { tailMessageCount: 10 } })
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))
    const fetchMock = vi.fn()

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 3,
      messageCountAtTime: 4,
    })
    global.fetch = fetchMock as any

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0].content).toBe(`${SUMMARY_PREFIX}\n\nprevious summary`)
    expect(result.messages.slice(1).map(m => m.content)).toEqual(['message 4', 'message 5'])
    expect(result.meta.llmCompressed).toBe(false)
    expect(result.meta.compressedStartIndex).toBe(3)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })

  it('keeps configured first and last messages during full compression', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/lib/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 2, tailMessageCount: 3, summaryBudget: 1000 },
    })
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue(null)
    bridgeRequestMock.mockResolvedValue({
      status: 'completed',
      result: { final_response: 'compressed summary' },
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(result.messages.map(m => m.content)).toEqual([
      'message 0',
      'message 1',
      `${SUMMARY_PREFIX}\n\ncompressed summary`,
      'message 7',
      'message 8',
      'message 9',
    ])
    expect(result.meta.compressed).toBe(true)
    expect(result.meta.llmCompressed).toBe(true)
    expect(result.meta.verbatimCount).toBe(5)
    expect(saveCompressionSnapshotMock).toHaveBeenCalledWith('s1', 'compressed summary', 6, 10)
  })

  it('keeps configured first messages when incremental compression reuses an existing snapshot', async () => {
    const { ChatContextCompressor, SUMMARY_PREFIX } = await import('../../packages/server/src/lib/context-compressor')
    const compressor = new ChatContextCompressor({
      config: { headMessageCount: 2, tailMessageCount: 10 },
    })
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }))

    getCompressionSnapshotMock.mockReturnValue({
      summary: 'previous summary',
      lastMessageIndex: 3,
      messageCountAtTime: 4,
    })

    const result = await compressor.compress(messages, 'http://upstream', undefined, 's1')

    expect(bridgeRequestMock).not.toHaveBeenCalled()
    expect(result.messages.map(m => m.content)).toEqual([
      'message 0',
      'message 1',
      `${SUMMARY_PREFIX}\n\nprevious summary`,
      'message 4',
      'message 5',
    ])
    expect(result.meta.verbatimCount).toBe(4)
    expect(saveCompressionSnapshotMock).not.toHaveBeenCalled()
  })
})
