import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const requireSuperAdmin = vi.hoisted(() => vi.fn(async (_ctx: any, next: () => Promise<void>) => next()))

vi.mock('../../packages/server/src/controllers/hermes/life-orchestration', () => ({
  overview: vi.fn(), sources: vi.fn(), createSource: vi.fn(), updateSourceHealth: vi.fn(),
  activationReviews: vi.fn(), activateSource: vi.fn(), revokeSource: vi.fn(), syncSource: vi.fn(),
  commitments: vi.fn(), contacts: vi.fn(), options: vi.fn(), subscriptions: vi.fn(),
  cancelSubscription: vi.fn(), constraints: vi.fn(), createConstraint: vi.fn(), plans: vi.fn(),
  createPlan: vi.fn(), verifyPlan: vi.fn(), handoffs: vi.fn(), holds: vi.fn(),
  createCalendarHold: vi.fn(), cancelCalendarHold: vi.fn(), cancellations: vi.fn(),
  workflows: vi.fn(), workflow: vi.fn(), takeovers: vi.fn(),
}))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({ requireSuperAdmin }))

describe('life orchestration routes', () => {
  beforeEach(() => { vi.resetModules(); requireSuperAdmin.mockClear() })

  it('exposes the complete bounded surface', async () => {
    const { lifeOrchestrationRoutes } = await import('../../packages/server/src/routes/hermes/life-orchestration')
    expect(lifeOrchestrationRoutes.stack.map((entry: any) => `${entry.methods.join(',')}:${entry.path}`)).toEqual([
      'HEAD,GET:/api/hermes/life/overview', 'HEAD,GET:/api/hermes/life/sources',
      'POST:/api/hermes/life/sources', 'PUT:/api/hermes/life/sources/:id/health',
      'HEAD,GET:/api/hermes/life/sources/:id/activation-reviews',
      'POST:/api/hermes/life/sources/:id/activate', 'POST:/api/hermes/life/sources/:id/revoke',
      'POST:/api/hermes/life/sources/sync', 'HEAD,GET:/api/hermes/life/commitments',
      'HEAD,GET:/api/hermes/life/contacts', 'HEAD,GET:/api/hermes/life/options',
      'HEAD,GET:/api/hermes/life/subscriptions', 'POST:/api/hermes/life/subscriptions/cancel',
      'HEAD,GET:/api/hermes/life/constraints', 'POST:/api/hermes/life/constraints',
      'HEAD,GET:/api/hermes/life/plans', 'POST:/api/hermes/life/plans',
      'POST:/api/hermes/life/plans/verify', 'HEAD,GET:/api/hermes/life/handoffs',
      'HEAD,GET:/api/hermes/life/holds', 'POST:/api/hermes/life/holds',
      'POST:/api/hermes/life/holds/cancel', 'HEAD,GET:/api/hermes/life/cancellations',
      'HEAD,GET:/api/hermes/life/workflows', 'HEAD,GET:/api/hermes/life/workflows/:id',
      'HEAD,GET:/api/hermes/life/takeovers',
    ])
  })

  it('restricts only authority-changing source mutations to super admin', async () => {
    const { lifeOrchestrationRoutes } = await import('../../packages/server/src/routes/hermes/life-orchestration')
    const privileged = new Set(['POST:/api/hermes/life/sources', 'PUT:/api/hermes/life/sources/:id/health',
      'POST:/api/hermes/life/sources/:id/activate', 'POST:/api/hermes/life/sources/:id/revoke'])
    for (const layer of lifeOrchestrationRoutes.stack as any[]) {
      const key = `${layer.methods[0]}:${layer.path}`
      expect(layer.stack.includes(requireSuperAdmin), key).toBe(privileged.has(key))
      if (privileged.has(key)) expect(layer.stack.indexOf(requireSuperAdmin)).toBeLessThan(layer.stack.length - 1)
    }
  })

  it('mounts every life route after global authentication', () => {
    const source = fs.readFileSync(path.resolve('packages/server/src/routes/index.ts'), 'utf8')
    expect(source.indexOf('app.use(lifeOrchestrationRoutes.routes())')).toBeGreaterThan(
      source.indexOf('authMiddleware.forEach'))
  })
})
