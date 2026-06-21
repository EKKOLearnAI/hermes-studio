import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  overview: vi.fn(async (ctx: any) => { ctx.body = { overview: {} } }),
  getProfile: vi.fn(async (ctx: any) => { ctx.body = { profile: {} } }),
  updateProfile: vi.fn(async (ctx: any) => { ctx.body = { profile: {} } }),
  getBodyMap: vi.fn(async (ctx: any) => { ctx.body = { bodyMap: [] } }),
  updateBodyMap: vi.fn(async (ctx: any) => { ctx.body = { bodyMap: [] } }),
  listRecords: vi.fn(async (ctx: any) => { ctx.body = { records: [] } }),
  createRecord: vi.fn(async (ctx: any) => { ctx.body = { record: {} } }),
  listWorkouts: vi.fn(async (ctx: any) => { ctx.body = { workouts: [] } }),
  createWorkout: vi.fn(async (ctx: any) => { ctx.body = { workout: {} } }),
  listFoodItems: vi.fn(async (ctx: any) => { ctx.body = { items: [] } }),
  listFoodLogs: vi.fn(async (ctx: any) => { ctx.body = { logs: [] } }),
  createFoodLog: vi.fn(async (ctx: any) => { ctx.body = { log: {} } }),
  getTodayPlan: vi.fn(async (ctx: any) => { ctx.body = { plan: null } }),
  createCheckIn: vi.fn(async (ctx: any) => { ctx.body = { checkIn: {} } }),
}

vi.mock('../../packages/server/src/controllers/hermes/health-state', () => handlers)

describe('health state routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(fn => fn.mockClear())
  })

  it('registers Health State routes', async () => {
    const { healthStateRoutes } = await import('../../packages/server/src/routes/hermes/health-state')
    const paths = healthStateRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/health/overview',
      '/api/hermes/health/profile',
      '/api/hermes/health/body-map',
      '/api/hermes/health/records',
      '/api/hermes/health/workouts',
      '/api/hermes/health/food/items',
      '/api/hermes/health/food/logs',
      '/api/hermes/health/today-plan',
      '/api/hermes/health/check-ins',
    ]))
  })

  it('delegates record creation to the controller', async () => {
    const { healthStateRoutes } = await import('../../packages/server/src/routes/hermes/health-state')
    const layer = healthStateRoutes.stack.find((entry: any) => entry.path === '/api/hermes/health/records' && entry.methods.includes('POST'))
    const ctx: any = { params: {}, request: { body: { kind: 'weight' } }, query: {}, body: null }

    await layer.stack[0](ctx)

    expect(handlers.createRecord).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ record: {} })
  })
})
