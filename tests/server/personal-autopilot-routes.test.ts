import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  overview: vi.fn(async (ctx: any) => { ctx.body = { overview: {} } }),
  quickLog: vi.fn(async (ctx: any) => { ctx.body = { log: {} } }),
}

vi.mock('../../packages/server/src/controllers/hermes/personal-autopilot', () => handlers)

describe('personal autopilot routes', () => {
  beforeEach(() => {
    vi.resetModules()
    handlers.overview.mockClear()
    handlers.quickLog.mockClear()
  })

  it('registers Personal Autopilot routes', async () => {
    const { personalAutopilotRoutes } = await import('../../packages/server/src/routes/hermes/personal-autopilot')
    const paths = personalAutopilotRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/personal-autopilot/overview',
      '/api/hermes/personal-autopilot/quick-log',
    ]))
  })

  it('delegates overview to the controller', async () => {
    const { personalAutopilotRoutes } = await import('../../packages/server/src/routes/hermes/personal-autopilot')
    const layer = personalAutopilotRoutes.stack.find((entry: any) => entry.path === '/api/hermes/personal-autopilot/overview')
    const ctx: any = { params: {}, request: { body: {} }, query: {}, body: null }

    await layer.stack[0](ctx)

    expect(handlers.overview).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ overview: {} })
  })

  it('delegates quick log creation to the controller', async () => {
    const { personalAutopilotRoutes } = await import('../../packages/server/src/routes/hermes/personal-autopilot')
    const layer = personalAutopilotRoutes.stack.find((entry: any) => entry.path === '/api/hermes/personal-autopilot/quick-log')
    const ctx: any = { params: {}, request: { body: { text: '脸出油' } }, query: {}, body: null }

    await layer.stack[0](ctx)

    expect(handlers.quickLog).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ log: {} })
  })
})
