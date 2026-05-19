import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCompressionSnapshotMock = vi.fn()
const saveCompressionSnapshotMock = vi.fn()
const deleteCompressionSnapshotMock = vi.fn()

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

describe('ChatContextCompressor', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    getCompressionSnapshotMock.mockReset()
    saveCompressionSnapshotMock.mockReset()
    deleteCompressionSnapshotMock.mockReset()
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
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as any

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
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as any

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
})
