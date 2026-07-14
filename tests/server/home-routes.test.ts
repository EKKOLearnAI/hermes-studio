import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => ({ overview: vi.fn(), spaces: vi.fn(), upsertSpace: vi.fn(), inventory: vi.fn(),
  upsertInventoryItem: vi.fn(), adjustInventory: vi.fn(), devices: vi.fn(), bindings: vi.fn(),
  providerHealth: vi.fn(), refreshDevice: vi.fn(), commandDevice: vi.fn(), activateScene: vi.fn(),
  workflow: vi.fn(), reviewWorkflow: vi.fn() }))
const requireSuperAdmin = vi.hoisted(() => vi.fn(async (_ctx: any, next: () => Promise<void>) => next()))
vi.mock('../../packages/server/src/controllers/hermes/home', () => handlers)
vi.mock('../../packages/server/src/middleware/user-auth', () => ({ requireSuperAdmin }))

describe('home routes', () => {
  beforeEach(() => vi.resetModules())

  it('registers the complete Home API in a stable order', async () => {
    const { homeRoutes } = await import('../../packages/server/src/routes/hermes/home')
    expect(homeRoutes.stack.map((layer: any) => `${layer.methods.join(',')}:${layer.path}`)).toEqual([
      'HEAD,GET:/api/hermes/home/overview',
      'HEAD,GET:/api/hermes/home/spaces',
      'POST:/api/hermes/home/spaces',
      'HEAD,GET:/api/hermes/home/inventory',
      'PUT:/api/hermes/home/inventory/:id',
      'POST:/api/hermes/home/inventory/:id/adjust',
      'HEAD,GET:/api/hermes/home/devices',
      'HEAD,GET:/api/hermes/home/bindings',
      'HEAD,GET:/api/hermes/home/provider',
      'POST:/api/hermes/home/devices/:id/refresh',
      'POST:/api/hermes/home/devices/:id/commands',
      'POST:/api/hermes/home/scenes/:id/activate',
      'HEAD,GET:/api/hermes/home/workflows/:id',
      'POST:/api/hermes/home/workflows/:id/review',
    ])
  })

  it('gates every Home mutation with super-admin authorization', async () => {
    const { homeRoutes } = await import('../../packages/server/src/routes/hermes/home')
    for (const layer of homeRoutes.stack as any[]) {
      const mutation = layer.methods.some((method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      expect(layer.stack.includes(requireSuperAdmin), `${layer.methods}:${layer.path}`).toBe(mutation)
    }
  })

  it('mounts Home after global authentication', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    expect(source.indexOf('app.use(homeRoutes.routes())')).toBeGreaterThan(source.indexOf('authMiddleware.forEach'))
  })
})
