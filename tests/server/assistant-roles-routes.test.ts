import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => ({
  list: vi.fn(), detail: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  clone: vi.fn(), updateProfileMapping: vi.fn(), previewContext: vi.fn(),
  listRecipes: vi.fn(), createRecipe: vi.fn(), updateRecipe: vi.fn(), removeRecipe: vi.fn(),
}))
const requireSuperAdmin = vi.hoisted(() => vi.fn(async function requireSuperAdmin(_ctx: any, next: () => Promise<void>) { await next() }))

vi.mock('../../packages/server/src/controllers/hermes/assistant-roles', () => handlers)
vi.mock('../../packages/server/src/middleware/user-auth', () => ({ requireSuperAdmin }))

describe('assistant role routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(handler => handler.mockClear())
    requireSuperAdmin.mockClear()
  })

  it('registers exactly the Phase 2 role endpoints', async () => {
    const { assistantRoleRoutes } = await import('../../packages/server/src/routes/hermes/assistant-roles')
    expect(assistantRoleRoutes.stack.map((entry: any) => `${entry.methods.join(',')}:${entry.path}`)).toEqual([
      'HEAD,GET:/api/hermes/assistant-roles',
      'POST:/api/hermes/assistant-roles',
      'HEAD,GET:/api/hermes/assistant-roles/:id',
      'PUT:/api/hermes/assistant-roles/:id',
      'DELETE:/api/hermes/assistant-roles/:id',
      'POST:/api/hermes/assistant-roles/:id/clone',
      'PUT:/api/hermes/assistant-roles/:id/profile-mapping',
      'POST:/api/hermes/assistant-roles/:id/context/preview',
      'HEAD,GET:/api/hermes/assistant-roles/:id/context-recipes',
      'POST:/api/hermes/assistant-roles/:id/context-recipes',
      'PUT:/api/hermes/assistant-roles/:id/context-recipes/:recipeId',
      'DELETE:/api/hermes/assistant-roles/:id/context-recipes/:recipeId',
    ])
  })

  it('requires super-admin authorization for mutations but not reads or context preview', async () => {
    const { assistantRoleRoutes } = await import('../../packages/server/src/routes/hermes/assistant-roles')
    const layers = assistantRoleRoutes.stack as any[]
    for (const layer of layers) {
      const isMutation = layer.methods.includes('PUT') || layer.methods.includes('DELETE')
        || (layer.methods.includes('POST') && !layer.path.endsWith('/context/preview'))
      expect(layer.stack.includes(requireSuperAdmin)).toBe(isMutation)
    }
  })

  it('mounts role routes only after the global authentication middleware', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    const authIndex = source.indexOf('authMiddleware.forEach')
    const mountIndex = source.indexOf('app.use(assistantRoleRoutes.routes())')
    expect(authIndex).toBeGreaterThan(-1)
    expect(mountIndex).toBeGreaterThan(authIndex)
  })
})
