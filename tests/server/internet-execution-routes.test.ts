import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => ({
  overview: vi.fn(), searchBilibili: vi.fn(), inspectBilibili: vi.fn(), receipts: vi.fn(),
  receipt: vi.fn(), workflow: vi.fn(),
}))
const requireSuperAdmin = vi.hoisted(() => vi.fn(async (_ctx: any, next: () => Promise<void>) => next()))
vi.mock('../../packages/server/src/controllers/hermes/internet-execution', () => handlers)
vi.mock('../../packages/server/src/middleware/user-auth', () => ({ requireSuperAdmin }))

describe('internet execution routes', () => {
  beforeEach(() => vi.resetModules())

  it('registers the bounded semantic API in a stable order', async () => {
    const { internetExecutionRoutes } = await import('../../packages/server/src/routes/hermes/internet-execution')
    expect(internetExecutionRoutes.stack.map((layer: any) => `${layer.methods.join(',')}:${layer.path}`)).toEqual([
      'HEAD,GET:/api/hermes/internet-execution/overview',
      'POST:/api/hermes/internet-execution/bilibili/search',
      'POST:/api/hermes/internet-execution/bilibili/inspect',
      'HEAD,GET:/api/hermes/internet-execution/receipts',
      'HEAD,GET:/api/hermes/internet-execution/receipts/:workflowId',
      'HEAD,GET:/api/hermes/internet-execution/workflows/:workflowId',
    ])
  })

  it('gates intent creation with super-admin authorization', async () => {
    const { internetExecutionRoutes } = await import('../../packages/server/src/routes/hermes/internet-execution')
    for (const layer of internetExecutionRoutes.stack as any[]) {
      const mutation = layer.methods.includes('POST')
      expect(layer.stack.includes(requireSuperAdmin), `${layer.methods}:${layer.path}`).toBe(mutation)
    }
  })

  it('mounts the API after global authentication', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    expect(source.indexOf('app.use(internetExecutionRoutes.routes())')).toBeGreaterThan(
      source.indexOf('authMiddleware.forEach'),
    )
  })
})
