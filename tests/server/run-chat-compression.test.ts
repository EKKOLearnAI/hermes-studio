import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionDetailMock = vi.fn()
const getSessionMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const getModelContextLengthMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const compressorCompressMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const compressorConstructorMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSessionDetail: getSessionDetailMock,
  getSession: getSessionMock,
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class {
    constructor(opts?: any) {
      compressorConstructorMock(opts)
    }
    compress = compressorCompressMock
  },
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  bridgeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/message-format', () => ({
  isAssistantMessageSendable: vi.fn(() => true),
}))

describe('run chat compression trigger', () => {
  beforeEach(() => {
    getSessionDetailMock.mockReset()
    getSessionMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    getModelContextLengthMock.mockReset()
    calcAndUpdateUsageMock.mockReset()
    compressorCompressMock.mockReset()
    compressorConstructorMock.mockReset()
    readConfigYamlForProfileMock.mockReset()

    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default' })
    getModelContextLengthMock.mockReturnValue(200_000)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 0 })
    getCompressionSnapshotMock.mockReturnValue(null)
    readConfigYamlForProfileMock.mockResolvedValue({})
  })

  it('does not compress long low-token history just because it has more than 150 messages', async () => {
    const messages = Array.from({ length: 152 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 151 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `m${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })

    const { buildCompressedHistory } = await import('../../packages/server/src/services/hermes/run-chat/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toHaveLength(151)
    expect(history[0]).toEqual({ role: 'user', content: 'm0' })
    expect(history.at(-1)).toEqual({ role: 'user', content: 'm150' })
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })

  it('uses configured threshold before triggering compression', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { threshold: 0.25, target_ratio: 0.1, protect_last_n: 7, protect_first_n: 2 },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 60_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/services/hermes/run-chat/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toEqual([{ role: 'user', content: 'compressed' }])
    expect(compressorCompressMock).toHaveBeenCalledWith(
      expect.any(Array),
      'http://upstream',
      undefined,
      'session-1',
      expect.objectContaining({ profile: 'default' }),
    )
  })

  it('merges partial compression config with defaults', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { protect_last_n: 5 },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 120_000, outputTokens: 0 })
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: {
        compressed: true,
        llmCompressed: true,
        totalMessages: 9,
        summaryTokenEstimate: 1,
        verbatimCount: 0,
        compressedStartIndex: 0,
      },
    })

    const { buildCompressedHistory } = await import('../../packages/server/src/services/hermes/run-chat/compression')
    await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(compressorConstructorMock).toHaveBeenCalledWith({
      config: {
        triggerTokens: 100_000,
        summaryBudget: 40_000,
        headMessageCount: 3,
        tailMessageCount: 5,
      },
    })
    expect(compressorCompressMock).toHaveBeenCalledTimes(1)
  })

  it('does not compress when compression is disabled', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 9 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })
    readConfigYamlForProfileMock.mockResolvedValue({
      compression: { enabled: false, threshold: 0.01 },
    })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 180_000, outputTokens: 0 })

    const { buildCompressedHistory } = await import('../../packages/server/src/services/hermes/run-chat/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toHaveLength(9)
    expect(compressorCompressMock).not.toHaveBeenCalled()
    expect(calcAndUpdateUsageMock).not.toHaveBeenCalled()
  })
})
