import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const getUsageStatsFromDbMock = vi.fn()
const getSessionMock = vi.fn()
const getGroupChatServerMock = vi.fn()
const getLocalUsageStatsMock = vi.fn()
const getActiveProfileNameMock = vi.fn()
const loggerWarnMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/conversations-db', () => ({
  listConversationSummariesFromDb: listConversationSummariesFromDbMock,
  getConversationDetailFromDb: getConversationDetailFromDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/conversations', () => ({
  listConversationSummaries: listConversationSummariesMock,
  getConversationDetail: getConversationDetailMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listSessions: vi.fn(),
  getSession: getSessionMock,
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: vi.fn(),
  searchSessionSummaries: vi.fn(),
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getUsageStatsFromDb: getUsageStatsFromDbMock,
}))

// Mock useLocalSessionStore to return false so we test the CLI path
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  useLocalSessionStore: () => false,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  deleteUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBatch: vi.fn(),
  getLocalUsageStats: getLocalUsageStatsMock,
}))

vi.mock('../../packages/server/src/routes/hermes/group-chat', () => ({
  getGroupChatServer: getGroupChatServerMock,
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: getActiveProfileNameMock,
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    getUsageStatsFromDbMock.mockReset()
    getSessionMock.mockReset()
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
    getLocalUsageStatsMock.mockReset()
    getActiveProfileNameMock.mockReset()
    getActiveProfileNameMock.mockReturnValue('default')
    loggerWarnMock.mockReset()
  })

  it('prefers the DB-backed conversations summary path', async () => {
    listConversationSummariesFromDbMock.mockResolvedValue([{ id: 'db-conversation' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'true', limit: '5' }, body: null }
    await mod.listConversations(ctx)

    expect(listConversationSummariesFromDbMock).toHaveBeenCalledWith({ source: undefined, humanOnly: true, limit: 5 })
    expect(listConversationSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ sessions: [{ id: 'db-conversation' }] })
  })

  it('falls back to the CLI-export conversations summary path when the DB query fails', async () => {
    listConversationSummariesFromDbMock.mockRejectedValue(new Error('db unavailable'))
    listConversationSummariesMock.mockResolvedValue([{ id: 'fallback-conversation' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'false' }, body: null }
    await mod.listConversations(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(listConversationSummariesMock).toHaveBeenCalledWith({ source: undefined, humanOnly: false, limit: undefined })
    expect(ctx.body).toEqual({ sessions: [{ id: 'fallback-conversation' }] })
  })

  it('prefers the DB-backed conversation detail path', async () => {
    getConversationDetailFromDbMock.mockResolvedValue({ session_id: 'root', messages: [], visible_count: 0, thread_session_count: 1 })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'true' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('root', { source: undefined, humanOnly: true })
    expect(getConversationDetailMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ session_id: 'root', messages: [], visible_count: 0, thread_session_count: 1 })
  })

  it('falls back to the CLI-export conversation detail path when the DB query throws', async () => {
    getConversationDetailFromDbMock.mockRejectedValue(new Error('db unavailable'))
    getConversationDetailMock.mockResolvedValue({ session_id: 'root', messages: [{ id: 1 }], visible_count: 1, thread_session_count: 1 })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(getConversationDetailMock).toHaveBeenCalledWith('root', { source: undefined, humanOnly: false })
    expect(ctx.body).toEqual({ session_id: 'root', messages: [{ id: 1 }], visible_count: 1, thread_session_count: 1 })
  })

  it('merges native state.db usage analytics with local Web UI usage for the requested period', async () => {
    const today = new Date().toISOString().slice(0, 10)
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 3,
      sessions: 1,
      by_model: [
        { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
      ],
      by_day: [
        { date: today, tokens: 15, cache: 2, sessions: 1, cost: 0 },
      ],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      reasoning_tokens: 6,
      sessions: 2,
      cost: 0.02,
      total_api_calls: 7,
      by_model: [
        { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      ],
      by_day: [
        { date: today, tokens: 30, cache: 4, sessions: 2, cost: 0.02 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).toHaveBeenCalledWith('default', 2)
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2)
    expect(ctx.body).toMatchObject({
      total_input_tokens: 30,
      total_output_tokens: 15,
      total_cache_read_tokens: 6,
      total_cache_write_tokens: 3,
      total_reasoning_tokens: 9,
      total_sessions: 3,
      total_cost: 0.02,
      total_api_calls: 7,
      period_days: 2,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
    ])
    expect(ctx.body.daily_usage.find((row: any) => row.date === today)).toMatchObject({ tokens: 45, cache: 6, sessions: 3, cost: 0.02 })
  })
})
