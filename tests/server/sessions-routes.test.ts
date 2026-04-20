import { beforeEach, describe, expect, it, vi } from 'vitest'

const listSessionSummariesMock = vi.fn()
const listSessionsMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/sessions-db', () => ({
  listSessionSummaries: listSessionSummariesMock,
}))

vi.mock('../../packages/server/src/services/hermes/conversations', () => ({
  listConversationSummaries: listConversationSummariesMock,
  getConversationDetail: getConversationDetailMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listSessions: listSessionsMock,
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}))

describe('session routes', () => {
  beforeEach(() => {
    vi.resetModules()
    listSessionSummariesMock.mockReset()
    listSessionsMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
  })

  it('serves summaries from sqlite-backed helper when available', async () => {
    listSessionSummariesMock.mockResolvedValue([{ id: 's1' }])
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions')
    const handler = layer.stack[0]
    const ctx: any = { query: { source: 'cli', limit: '5' }, body: null }

    await handler(ctx)

    expect(listSessionSummariesMock).toHaveBeenCalledWith('cli', 5)
    expect(listSessionsMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ sessions: [{ id: 's1' }] })
  })

  it('falls back to CLI wrapper when sqlite summary query fails', async () => {
    listSessionSummariesMock.mockRejectedValue(new Error('sqlite unavailable'))
    listSessionsMock.mockResolvedValue([{ id: 'fallback' }])
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions')
    const handler = layer.stack[0]
    const ctx: any = { query: { limit: '7' }, body: null }

    await handler(ctx)

    expect(listSessionSummariesMock).toHaveBeenCalledWith(undefined, 7)
    expect(listSessionsMock).toHaveBeenCalledWith(undefined, 7)
    expect(ctx.body).toEqual({ sessions: [{ id: 'fallback' }] })
  })

  it('serves live conversations with humanOnly defaulting to true', async () => {
    listConversationSummariesMock.mockResolvedValue([{ id: 'conversation-1' }])
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations')
    const handler = layer.stack[0]
    const ctx: any = { query: {}, body: null }

    await handler(ctx)

    expect(listConversationSummariesMock).toHaveBeenCalledWith({ humanOnly: true, source: undefined, limit: undefined })
    expect(ctx.body).toEqual({ sessions: [{ id: 'conversation-1' }] })
  })

  it('supports disabling humanOnly and forwarding limit/source for live conversations', async () => {
    listConversationSummariesMock.mockResolvedValue([{ id: 'child-session' }])
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations')

    const listCtx: any = { query: { humanOnly: 'false', source: 'cli', limit: '25' }, body: null }
    await listLayer.stack[0](listCtx)

    expect(listConversationSummariesMock).toHaveBeenCalledWith({ humanOnly: false, source: 'cli', limit: 25 })
    expect(listCtx.body).toEqual({ sessions: [{ id: 'child-session' }] })
  })

  it('returns conversation detail and forwards humanOnly/source', async () => {
    getConversationDetailMock.mockResolvedValue({ session_id: 'child-session', messages: [] })
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const detailLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations/:id/messages')

    const detailCtx: any = { params: { id: 'child-session' }, query: { humanOnly: 'false', source: 'discord' }, body: null, status: 200 }
    await detailLayer.stack[0](detailCtx)

    expect(getConversationDetailMock).toHaveBeenCalledWith('child-session', { humanOnly: false, source: 'discord' })
    expect(detailCtx.body).toEqual({ session_id: 'child-session', messages: [] })
  })

  it('returns 404 when a conversation detail is not found', async () => {
    getConversationDetailMock.mockResolvedValue(null)
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const detailLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations/:id/messages')

    const detailCtx: any = { params: { id: 'missing' }, query: {}, body: null, status: 200 }
    await detailLayer.stack[0](detailCtx)

    expect(getConversationDetailMock).toHaveBeenCalledWith('missing', { humanOnly: true, source: undefined })
    expect(detailCtx.status).toBe(404)
    expect(detailCtx.body).toEqual({ error: 'Conversation not found' })
  })
})
