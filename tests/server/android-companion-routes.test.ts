import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => ({
  overview: vi.fn(), issuePairingOffer: vi.fn(), revokePairingOffer: vi.fn(), completePairing: vi.fn(),
  devices: vi.fn(), revokeDevice: vi.fn(), capabilities: vi.fn(), commands: vi.fn(), receipts: vi.fn(),
  notifications: vi.fn(), artifacts: vi.fn(), takeovers: vi.fn(),
}))
const requireSuperAdmin = vi.hoisted(() => vi.fn(async (_ctx: any, next: () => Promise<void>) => next()))
vi.mock('../../packages/server/src/controllers/hermes/android-companion', () => handlers)
vi.mock('../../packages/server/src/middleware/user-auth', () => ({ requireSuperAdmin }))

describe('Android companion routes', () => {
  beforeEach(() => vi.resetModules())

  it('registers the bounded command-center API in a stable order', async () => {
    const { androidCompanionRoutes } = await import('../../packages/server/src/routes/hermes/android-companion')
    expect(androidCompanionRoutes.stack.map((layer: any) => `${layer.methods.join(',')}:${layer.path}`)).toEqual([
      'HEAD,GET:/api/hermes/android-companion/overview',
      'POST:/api/hermes/android-companion/pairing/offers',
      'DELETE:/api/hermes/android-companion/pairing/offers/:challengeId',
      'POST:/api/hermes/android-companion/pairing/complete',
      'HEAD,GET:/api/hermes/android-companion/devices',
      'POST:/api/hermes/android-companion/devices/:deviceId/revoke',
      'HEAD,GET:/api/hermes/android-companion/capabilities',
      'HEAD,GET:/api/hermes/android-companion/commands',
      'HEAD,GET:/api/hermes/android-companion/receipts',
      'HEAD,GET:/api/hermes/android-companion/notifications',
      'HEAD,GET:/api/hermes/android-companion/artifacts',
      'HEAD,GET:/api/hermes/android-companion/takeovers',
    ])
  })

  it('gates every trust mutation with super-admin authorization', async () => {
    const { androidCompanionRoutes } = await import('../../packages/server/src/routes/hermes/android-companion')
    for (const layer of androidCompanionRoutes.stack as any[]) {
      const mutation = layer.methods.some((method: string) => ['POST', 'DELETE'].includes(method))
      expect(layer.stack.includes(requireSuperAdmin), `${layer.methods}:${layer.path}`).toBe(mutation)
    }
  })

  it('mounts the API only after global authentication', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    expect(source.indexOf('app.use(androidCompanionRoutes.routes())')).toBeGreaterThan(
      source.indexOf('authMiddleware.forEach'),
    )
  })
})
