import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveEkkoProviderRuntimeConfigMock = vi.hoisted(() => vi.fn())
const resolveModelProviderConfigsMock = vi.hoisted(() => vi.fn())
const createModelClientMock = vi.hoisted(() => vi.fn(() => ({ provider: 'test' })))
const runIsolatedMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/ekko-agent/provider-runtime', () => ({
  resolveEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
}))

vi.mock('../../packages/server/src/services/ekko-agent/manager', () => ({
  getGlobalEkkoAgent: vi.fn(() => ({ runIsolated: runIsolatedMock })),
}))

vi.mock('../../packages/ekko-agent/src', () => ({
  createModelClient: createModelClientMock,
  resolveModelProviderConfigs: resolveModelProviderConfigsMock,
}))

import {
  DEFAULT_GROUP_CHAT_COMPRESSION_TIMEOUT_MS,
  groupChatCompressionTimeoutMs,
  GroupRoomSummaryService,
  type GroupRoomSummary,
} from '../../packages/server/src/services/hermes/group-chat/room-summary'

const originalTimeout = process.env.HERMES_GROUP_CHAT_COMPRESSION_TIMEOUT_MS

function restoreTimeoutEnv(): void {
  if (originalTimeout === undefined) delete process.env.HERMES_GROUP_CHAT_COMPRESSION_TIMEOUT_MS
  else process.env.HERMES_GROUP_CHAT_COMPRESSION_TIMEOUT_MS = originalTimeout
}

describe('group chat summary timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreTimeoutEnv()
    resolveEkkoProviderRuntimeConfigMock.mockResolvedValue({
      provider: 'test-provider',
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      apiMode: 'chat_completions',
    })
    resolveModelProviderConfigsMock.mockReturnValue({ providerConfig: { provider: 'test-provider' } })
    runIsolatedMock.mockResolvedValue({
      output: { content: 'updated summary', toolCalls: [], finishReason: 'stop' },
    })
  })

  afterEach(restoreTimeoutEnv)

  it('defaults to the existing five-minute compression budget', () => {
    delete process.env.HERMES_GROUP_CHAT_COMPRESSION_TIMEOUT_MS
    expect(groupChatCompressionTimeoutMs()).toBe(DEFAULT_GROUP_CHAT_COMPRESSION_TIMEOUT_MS)
  })

  it('accepts bounded millisecond overrides and floors fractional values', () => {
    expect(groupChatCompressionTimeoutMs('600000.9')).toBe(600_000)
  })

  it('falls back to five minutes for invalid or unsafe values', () => {
    for (const value of ['abc', '', '4999', String(30 * 60_000 + 1), Number.POSITIVE_INFINITY]) {
      expect(groupChatCompressionTimeoutMs(value)).toBe(DEFAULT_GROUP_CHAT_COMPRESSION_TIMEOUT_MS)
    }
  })

  it('passes the configured timeout to the production Ekko summary model request', async () => {
    process.env.HERMES_GROUP_CHAT_COMPRESSION_TIMEOUT_MS = '600000'
    const summaries = new Map<string, GroupRoomSummary>()
    const messages = [
      { id: 'user-1', timestamp: 1, role: 'user', senderName: 'Alice', content: 'first turn' },
      { id: 'user-2', timestamp: 2, role: 'user', senderName: 'Alice', content: 'current turn' },
    ]
    const service = new GroupRoomSummaryService({
      getRoom: () => ({
        id: 'room-1',
        summaryProfile: 'default',
        summaryProvider: 'test-provider',
        summaryModel: 'test-model',
        summaryApiMode: 'chat_completions',
        summaryEveryTurns: 1,
      }),
      getMessagesForContext: () => messages,
      getRoomSummary: roomId => summaries.get(roomId) || null,
      saveRoomSummary: summary => summaries.set(summary.roomId, { ...summary }),
    })

    await service.prepareForMessage('room-1', 'user-2')

    expect(resolveModelProviderConfigsMock).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 600_000,
    }))
    expect(summaries.get('room-1')).toMatchObject({
      summary: 'updated summary',
      status: 'success',
    })
  })
})
