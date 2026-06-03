import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the controllers so we only verify wiring
vi.mock('../../packages/server/src/controllers/auth', () => ({
  authStatus: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  login: vi.fn(async (ctx: any) => { ctx.body = { token: 'x' } }),
  setupPassword: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  currentUser: vi.fn(async (ctx: any) => { ctx.body = { user: {} } }),
  changePassword: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  changeUsername: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  getMyAvatar: vi.fn(async (ctx: any) => { ctx.body = { avatar: '' } }),
  updateMyAvatar: vi.fn(async (ctx: any) => { ctx.body = { success: true } }),
  removePassword: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  listManagedUsers: vi.fn(async (ctx: any) => { ctx.body = { users: [] } }),
  createManagedUser: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  updateManagedUser: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  deleteManagedUser: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  listLockedIps: vi.fn(async (ctx: any) => { ctx.body = { locks: [] } }),
  unlockIpHandler: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
}))

const requireSuperAdminMock = vi.fn(async (_ctx: any, next: any) => { await next() })
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  requireSuperAdmin: requireSuperAdminMock,
  issueUserJwt: vi.fn(async () => 'jwt'),
}))

describe('auth routes: avatar endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  function findLayer(router: any, method: string, path: string) {
    return router.stack.find(
      (entry: any) => Array.isArray(entry.methods) && entry.methods.includes(method) && entry.path === path,
    )
  }

  it('mounts GET /api/auth/avatar on the protected router', async () => {
    const { authProtectedRoutes } = await import('../../packages/server/src/routes/auth')
    const layer = findLayer(authProtectedRoutes, 'GET', '/api/auth/avatar')
    expect(layer).toBeDefined()
  })

  it('mounts PUT /api/auth/avatar on the protected router', async () => {
    const { authProtectedRoutes } = await import('../../packages/server/src/routes/auth')
    const layer = findLayer(authProtectedRoutes, 'PUT', '/api/auth/avatar')
    expect(layer).toBeDefined()
  })

  it('does not expose the avatar routes on the public router', async () => {
    const { authPublicRoutes, authProtectedRoutes } = await import('../../packages/server/src/routes/auth')

    expect(findLayer(authPublicRoutes, 'GET', '/api/auth/avatar')).toBeUndefined()
    expect(findLayer(authPublicRoutes, 'PUT', '/api/auth/avatar')).toBeUndefined()
    expect(findLayer(authProtectedRoutes, 'GET', '/api/auth/avatar')).toBeDefined()
    expect(findLayer(authProtectedRoutes, 'PUT', '/api/auth/avatar')).toBeDefined()
  })

  it('routes GET /api/auth/avatar to getMyAvatar', async () => {
    const { authProtectedRoutes } = await import('../../packages/server/src/routes/auth')
    const ctrl = await import('../../packages/server/src/controllers/auth')
    const layer = findLayer(authProtectedRoutes, 'GET', '/api/auth/avatar')
    expect(layer).toBeDefined()
    const handler = layer!.stack[0]

    const ctx: any = { request: { body: {} }, status: 200, body: null }
    const next = vi.fn(async () => {})
    await handler(ctx, next)

    expect(ctrl.getMyAvatar).toHaveBeenCalledWith(ctx, next)
  })

  it('routes PUT /api/auth/avatar to updateMyAvatar', async () => {
    const { authProtectedRoutes } = await import('../../packages/server/src/routes/auth')
    const ctrl = await import('../../packages/server/src/controllers/auth')
    const layer = findLayer(authProtectedRoutes, 'PUT', '/api/auth/avatar')
    expect(layer).toBeDefined()
    const handler = layer!.stack[0]

    const ctx: any = { request: { body: { type: 'default' } }, status: 200, body: null }
    const next = vi.fn(async () => {})
    await handler(ctx, next)

    expect(ctrl.updateMyAvatar).toHaveBeenCalledWith(ctx, next)
  })
})
