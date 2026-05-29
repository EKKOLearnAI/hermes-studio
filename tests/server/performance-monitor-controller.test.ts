import { afterEach, describe, expect, it, vi } from 'vitest'

const getOpsRuntimeSnapshot = vi.fn()

vi.mock('../../packages/server/src/services/hermes/ops-monitor', () => ({
  createEmptyOpsRuntimeSnapshot: (error?: string) => ({ timestamp: 0, error }),
  getOpsRuntimeSnapshot,
}))

describe('performance monitor controller', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns the runtime snapshot from the performance service', async () => {
    const snapshot = {
      timestamp: 1,
      bridge: { workers: [] },
      sessions: { active: 0 },
    }
    getOpsRuntimeSnapshot.mockResolvedValue(snapshot)
    const ctx: any = {}

    const { runtime } = await import('../../packages/server/src/controllers/hermes/performance-monitor')
    await runtime(ctx)

    expect(ctx.body).toBe(snapshot)
  })

  it('returns a zero snapshot when metrics collection fails', async () => {
    getOpsRuntimeSnapshot.mockRejectedValue(new Error('boom'))
    const ctx: any = {}

    const { runtime } = await import('../../packages/server/src/controllers/hermes/performance-monitor')
    await runtime(ctx)

    expect(ctx.status).toBeUndefined()
    expect(ctx.body).toEqual({ timestamp: 0, error: 'boom' })
  })

  it('requires super admin on the runtime route', async () => {
    const { performanceMonitorRoutes } = await import('../../packages/server/src/routes/hermes/performance-monitor')
    const layer = performanceMonitorRoutes.stack.find((entry: any) => entry.path === '/api/hermes/performance/runtime')
    expect(layer).toBeTruthy()

    const deniedCtx: any = { state: { user: { role: 'admin' } }, status: 200, body: null }
    const deniedNext = vi.fn(async () => {})
    await layer.stack[0](deniedCtx, deniedNext)

    expect(deniedCtx.status).toBe(403)
    expect(deniedNext).not.toHaveBeenCalled()

    const allowedCtx: any = { state: { user: { role: 'super_admin' } }, status: 200, body: null }
    const allowedNext = vi.fn(async () => {})
    await layer.stack[0](allowedCtx, allowedNext)
    expect(allowedNext).toHaveBeenCalledOnce()
  })
})
