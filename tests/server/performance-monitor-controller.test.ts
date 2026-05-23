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
})
