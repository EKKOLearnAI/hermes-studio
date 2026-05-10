import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  listBoards: vi.fn(async (ctx: any) => { ctx.body = { boards: [] } }),
  createBoard: vi.fn(async (ctx: any) => { ctx.body = { board: {} } }),
  archiveBoard: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  capabilities: vi.fn(async (ctx: any) => { ctx.body = { capabilities: {} } }),
  stats: vi.fn(async (ctx: any) => { ctx.body = { stats: {} } }),
  assignees: vi.fn(async (ctx: any) => { ctx.body = { assignees: [] } }),
  readArtifact: vi.fn(async (ctx: any) => { ctx.body = { content: 'x' } }),
  searchSessions: vi.fn(async (ctx: any) => { ctx.body = { results: [] } }),
  list: vi.fn(async (ctx: any) => { ctx.body = { tasks: [] } }),
  get: vi.fn(async (ctx: any) => { ctx.body = { task: {} } }),
  create: vi.fn(async (ctx: any) => { ctx.body = { task: {} } }),
  complete: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  unblock: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  block: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  assign: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
}

vi.mock('../../packages/server/src/controllers/hermes/kanban', () => handlers)

describe('kanban routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(fn => fn.mockClear())
  })

  it('registers all kanban routes', async () => {
    const { kanbanRoutes } = await import('../../packages/server/src/routes/hermes/kanban')
    const paths = kanbanRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/kanban/boards',
      '/api/hermes/kanban/boards/:slug',
      '/api/hermes/kanban/capabilities',
      '/api/hermes/kanban/stats',
      '/api/hermes/kanban/assignees',
      '/api/hermes/kanban/artifact',
      '/api/hermes/kanban/search-sessions',
      '/api/hermes/kanban',
      '/api/hermes/kanban/:id',
      '/api/hermes/kanban/complete',
      '/api/hermes/kanban/unblock',
      '/api/hermes/kanban/:id/block',
      '/api/hermes/kanban/:id/assign',
    ]))
  })

  it('delegates search-sessions to the controller', async () => {
    const { kanbanRoutes } = await import('../../packages/server/src/routes/hermes/kanban')
    const layer = kanbanRoutes.stack.find((entry: any) => entry.path === '/api/hermes/kanban/search-sessions')
    const ctx: any = { query: { task_id: 'task-1', profile: 'alice' }, body: null, params: {} }

    await layer.stack[0](ctx)

    expect(handlers.searchSessions).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [] })
  })
})
