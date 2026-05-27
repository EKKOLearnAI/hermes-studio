import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const getSessionDetailPaginatedMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  createSession: vi.fn(),
  addMessage: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionDetailPaginated: getSessionDetailPaginatedMock,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn(() => 0),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  buildCompressedHistory: vi.fn(),
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  getOrCreateSession: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: vi.fn(),
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/message-format', () => ({
  convertHistoryFormat: vi.fn((messages: any[]) => messages),
  handleMessage: vi.fn((messages: any[]) => messages),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/content-blocks', () => ({
  contentBlocksToString: vi.fn((value: any) => String(value || '')),
  extractTextForPreview: vi.fn((value: any) => String(value || '')),
  isContentBlockArray: vi.fn(() => false),
  convertContentBlocks: vi.fn(),
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/sse-utils', () => ({
  readSseFrames: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/response-utils', () => ({
  extractResponseText: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/response-stream', () => ({
  applyResponseStreamEvent: vi.fn(),
  flushResponseRunToDb: vi.fn(),
}))

describe('loadSessionStateFromDb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'gpt-test',
      provider: 'openai',
    })
    getSessionDetailPaginatedMock.mockReturnValue({
      messages: [
        { role: 'user', content: 'old large context' },
        { role: 'assistant', content: 'old large answer' },
        { role: 'user', content: 'new tail' },
      ],
    })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'small summary',
      lastMessageIndex: 0,
      messageCountAtTime: 1,
    })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'old large context' },
      { role: 'assistant', content: 'old large answer' },
      { role: 'user', content: 'new tail' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: '[Previous context summary]\n\nsmall summary' },
      { role: 'user', content: 'new tail' },
    ])
    estimateUsageTokensFromMessagesMock.mockImplementation((messages: any[]) => {
      if (messages?.[0]?.content?.includes('small summary')) {
        return { inputTokens: 9_000, outputTokens: 0 }
      }
      return { inputTokens: 28_000, outputTokens: 0 }
    })
  })

  it('hydrates contextTokens from the same snapshot-aware history used for bridge runs', async () => {
    const { loadSessionStateFromDb } = await import('../../packages/server/src/services/hermes/run-chat/handle-api-run')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(buildSnapshotAwareHistoryMock).toHaveBeenCalledWith(
      'session-1',
      'default',
      expect.any(Array),
      { model: 'gpt-test', provider: 'openai' },
    )
    expect(state.inputTokens).toBe(28_000)
    expect(state.outputTokens).toBe(0)
    expect(state.contextTokens).toBe(9_000)
  })
})
