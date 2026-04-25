import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const getSessionMock = vi.fn()
const getGroupChatServerMock = vi.fn()
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
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  deleteUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBatch: vi.fn(),
}))

vi.mock('../../packages/server/src/routes/hermes/group-chat', () => ({
  getGroupChatServer: getGroupChatServerMock,
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(),
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    getSessionMock.mockReset()
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
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

  it('serves DB-backed session detail before falling back to CLI export', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'compressed-root',
      source: 'cli',
      user_id: null,
      model: 'gpt-5.5',
      title: 'Compressed root',
      started_at: 100,
      ended_at: 120,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'hello',
      last_active: 121,
      messages: [
        { id: 1, session_id: 'compressed-root', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null },
        { id: 2, session_id: 'compressed-root-cont', role: 'assistant', content: 'world', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 121, token_count: null, finish_reason: null, reasoning: null },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'compressed-root' }, query: {}, body: null }
    await mod.get(ctx)

    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('compressed-root')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session.messages.map((message: any) => message.content)).toEqual(['hello', 'world'])
  })

  it('falls back to CLI session detail when the DB detail path is unavailable', async () => {
    getSessionDetailFromDbMock.mockRejectedValue(new Error('db unavailable'))
    getSessionMock.mockResolvedValue({ id: 'legacy', messages: [{ id: 1, content: 'from cli' }] })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'legacy' }, query: {}, body: null }
    await mod.get(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(getSessionMock).toHaveBeenCalledWith('legacy')
    expect(ctx.body).toEqual({ session: { id: 'legacy', messages: [{ id: 1, content: 'from cli' }] } })
  })

  it('hides DB-backed session detail when a continuation child is pending deletion', async () => {
    getGroupChatServerMock.mockReturnValue({
      getStorage: () => ({
        getPendingDeletedSessionIds: () => new Set(['compressed-root-cont']),
      }),
    })
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'compressed-root',
      messages: [
        { id: 1, session_id: 'compressed-root', role: 'user', content: 'hello', timestamp: 101 },
        { id: 2, session_id: 'compressed-root-cont', role: 'assistant', content: 'hidden', timestamp: 121 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'compressed-root' }, query: {}, body: null }
    await mod.get(ctx)

    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('compressed-root')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })
})
