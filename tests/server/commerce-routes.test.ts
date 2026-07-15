import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => Object.fromEntries([
  'overview', 'accounts', 'createAccount', 'updateAccountHealth', 'activationReviews', 'activateAccount',
  'revokeAccount', 'offers', 'searchOffers', 'comparisons', 'createComparison', 'carts', 'createCart',
  'quotes', 'createQuote', 'placeOrder', 'confirmPayment', 'trackDelivery', 'cancelOrder', 'requestRefund',
  'workflows', 'workflow', 'transactions', 'transaction', 'takeovers',
].map(name => [name, vi.fn()])))
const requireSuperAdmin = vi.hoisted(() => vi.fn(async (_ctx: any, next: () => Promise<void>) => next()))

vi.mock('../../packages/server/src/controllers/hermes/commerce', () => handlers)
vi.mock('../../packages/server/src/middleware/user-auth', () => ({ requireSuperAdmin }))

describe('commerce routes', () => {
  beforeEach(() => { vi.resetModules(); requireSuperAdmin.mockClear() })

  it('registers the complete bounded Commerce API surface', async () => {
    const { commerceRoutes } = await import('../../packages/server/src/routes/hermes/commerce')
    expect(commerceRoutes.stack.map((entry: any) => `${entry.methods.join(',')}:${entry.path}`)).toEqual([
      'HEAD,GET:/api/hermes/commerce/overview',
      'HEAD,GET:/api/hermes/commerce/accounts',
      'POST:/api/hermes/commerce/accounts',
      'PUT:/api/hermes/commerce/accounts/:id/health',
      'HEAD,GET:/api/hermes/commerce/accounts/:id/activation-reviews',
      'POST:/api/hermes/commerce/accounts/:id/activate',
      'POST:/api/hermes/commerce/accounts/:id/revoke',
      'HEAD,GET:/api/hermes/commerce/offers',
      'POST:/api/hermes/commerce/offers/search',
      'HEAD,GET:/api/hermes/commerce/comparisons',
      'POST:/api/hermes/commerce/comparisons',
      'HEAD,GET:/api/hermes/commerce/carts',
      'POST:/api/hermes/commerce/carts',
      'HEAD,GET:/api/hermes/commerce/quotes',
      'POST:/api/hermes/commerce/quotes',
      'POST:/api/hermes/commerce/orders',
      'POST:/api/hermes/commerce/payments',
      'POST:/api/hermes/commerce/delivery',
      'POST:/api/hermes/commerce/cancellations',
      'POST:/api/hermes/commerce/refunds',
      'HEAD,GET:/api/hermes/commerce/workflows',
      'HEAD,GET:/api/hermes/commerce/workflows/:id',
      'HEAD,GET:/api/hermes/commerce/transactions',
      'HEAD,GET:/api/hermes/commerce/transactions/:id',
      'HEAD,GET:/api/hermes/commerce/takeovers',
    ])
  })

  it('requires super-admin only at account authority boundaries', async () => {
    const { commerceRoutes } = await import('../../packages/server/src/routes/hermes/commerce')
    const privileged = new Set([
      'POST:/api/hermes/commerce/accounts',
      'PUT:/api/hermes/commerce/accounts/:id/health',
      'POST:/api/hermes/commerce/accounts/:id/activate',
      'POST:/api/hermes/commerce/accounts/:id/revoke',
    ])
    for (const layer of commerceRoutes.stack as any[]) {
      const key = `${layer.methods.find((method: string) => method !== 'HEAD')}:${layer.path}`
      expect(layer.stack.includes(requireSuperAdmin), key).toBe(privileged.has(key))
    }
  })

  it('mounts Commerce only after global authentication', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    expect(source.indexOf('app.use(commerceRoutes.routes())')).toBeGreaterThan(source.indexOf('authMiddleware.forEach'))
  })
})
