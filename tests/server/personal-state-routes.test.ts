import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  overview: vi.fn(async (ctx: any) => { ctx.body = { overview: {} } }),
  approve: vi.fn(async (ctx: any) => { ctx.body = { proposal: {} } }),
  reject: vi.fn(async (ctx: any) => { ctx.body = { proposal: {} } }),
  checkInTask: vi.fn(async (ctx: any) => { ctx.body = { task: {} } }),
}

vi.mock('../../packages/server/src/controllers/hermes/personal-state', () => handlers)

describe('personal state routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(fn => fn.mockClear())
  })

  it('registers Personal State routes', async () => {
    const { personalStateRoutes } = await import('../../packages/server/src/routes/hermes/personal-state')
    const paths = personalStateRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/personal-state/overview',
      '/api/hermes/personal-state/proposals/:id/approve',
      '/api/hermes/personal-state/proposals/:id/reject',
      '/api/hermes/personal-state/tasks/:id/check-in',
    ]))
  })

  it('delegates approve to the controller', async () => {
    const { personalStateRoutes } = await import('../../packages/server/src/routes/hermes/personal-state')
    const layer = personalStateRoutes.stack.find((entry: any) => entry.path === '/api/hermes/personal-state/proposals/:id/approve')
    const ctx: any = { params: { id: 'proposal-1' }, request: { body: {} }, query: {}, body: null }

    await layer.stack[0](ctx)

    expect(handlers.approve).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ proposal: {} })
  })
})
