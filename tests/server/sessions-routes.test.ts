import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationsMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 'conversation-1' }] } })
const getConversationMessagesMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id, messages: [] } })
const listMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 's1' }] } })
const searchMock = vi.fn(async (ctx: any) => { ctx.body = { results: [{ id: 'search-1' }] } })
const getMock = vi.fn(async (ctx: any) => { ctx.body = { session: { id: ctx.params.id } } })
const removeMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const renameMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const usageBatchMock = vi.fn(async (ctx: any) => { ctx.body = {} })
const usageSingleMock = vi.fn(async (ctx: any) => { ctx.body = { input_tokens: 0, output_tokens: 0 } })
const usageStatsMock = vi.fn(async (ctx: any) => { ctx.body = { total_input_tokens: 0, total_output_tokens: 0 } })
const contextLengthMock = vi.fn(async (ctx: any) => { ctx.body = { context_length: 200000 } })

vi.mock('../../packages/server/src/controllers/hermes/sessions', () => ({
  listConversations: listConversationsMock,
  getConversationMessages: getConversationMessagesMock,
  list: listMock,
  search: searchMock,
  get: getMock,
  remove: removeMock,
  rename: renameMock,
  usageBatch: usageBatchMock,
  usageSingle: usageSingleMock,
  usageStats: usageStatsMock,
  contextLength: contextLengthMock,
}))

describe('session routes', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationsMock.mockClear()
    getConversationMessagesMock.mockClear()
    listMock.mockClear()
    searchMock.mockClear()
    getMock.mockClear()
    removeMock.mockClear()
    renameMock.mockClear()
  })

  it('registers conversations, session list, and search routes', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const paths = sessionRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/sessions/conversations',
      '/api/hermes/sessions/conversations/:id/messages',
      '/api/hermes/sessions',
      '/api/hermes/search/sessions',
      '/api/hermes/sessions/search',
      '/api/hermes/sessions/usage',
      '/api/hermes/sessions/context-length',
      '/api/hermes/sessions/:id',
      '/api/hermes/sessions/:id/usage',
      '/api/hermes/sessions/:id/rename',
    ]))
  })

  it('delegates session search to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/search/sessions')
    const handler = layer.stack[0]
    const ctx: any = { query: { q: 'docker', limit: '8' }, body: null, params: {} }

    await handler(ctx)

    expect(searchMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [{ id: 'search-1' }] })
  })

  it('keeps the legacy search path wired to the same controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/search')
    const handler = layer.stack[0]
    const ctx: any = { query: { q: 'docker' }, body: null, params: {} }

    await handler(ctx)

    expect(searchMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [{ id: 'search-1' }] })
  })

  it('delegates conversations list and detail routes', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations')
    const detailLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations/:id/messages')

    const listCtx: any = { query: {}, body: null, params: {} }
    await listLayer.stack[0](listCtx)
    expect(listConversationsMock).toHaveBeenCalledWith(listCtx)
    expect(listCtx.body).toEqual({ sessions: [{ id: 'conversation-1' }] })

    const detailCtx: any = { params: { id: 'child-session' }, query: {}, body: null }
    await detailLayer.stack[0](detailCtx)
    expect(getConversationMessagesMock).toHaveBeenCalledWith(detailCtx)
    expect(detailCtx.body).toEqual({ session_id: 'child-session', messages: [] })
  })
})
