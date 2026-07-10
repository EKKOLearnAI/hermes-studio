import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  overview: vi.fn(async (ctx: any) => { ctx.body = { overview: {} } }),
  entities: vi.fn(async (ctx: any) => { ctx.body = { entities: [] } }),
  observations: vi.fn(async (ctx: any) => { ctx.body = { observations: [] } }),
  events: vi.fn(async (ctx: any) => { ctx.body = { events: [] } }),
  context: vi.fn(async (ctx: any) => { ctx.body = { context: {} } }),
  importLegacy: vi.fn(async (ctx: any) => { ctx.body = { result: {} } }),
}

vi.mock('../../packages/server/src/controllers/hermes/personal-twin', () => handlers)

describe('personal twin routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(fn => fn.mockClear())
  })

  it('registers exactly the Phase 1 paths', async () => {
    const { personalTwinRoutes } = await import('../../packages/server/src/routes/hermes/personal-twin')
    expect(personalTwinRoutes.stack.map((entry: any) => `${entry.methods.join(',')}:${entry.path}`)).toEqual([
      'HEAD,GET:/api/hermes/personal-twin/overview',
      'HEAD,GET:/api/hermes/personal-twin/entities',
      'HEAD,GET:/api/hermes/personal-twin/observations',
      'HEAD,GET:/api/hermes/personal-twin/events',
      'HEAD,GET:/api/hermes/personal-twin/context',
      'POST:/api/hermes/personal-twin/imports/legacy',
    ])
  })
})
