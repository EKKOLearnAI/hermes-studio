import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('user auth tables and middleware', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.doUnmock('../../packages/server/src/services/hermes/hermes-profile')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function initUsers() {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      users: await import('../../packages/server/src/db/hermes/users-store'),
      auth: await import('../../packages/server/src/middleware/user-auth'),
    }
  }

  function makeCtx(user: any, profile: string) {
    return {
      state: { user },
      query: { profile },
      request: { body: {} },
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? '' : ''),
      status: 200,
      body: null,
    } as any
  }

  it('creates the default super admin without profile bindings', async () => {
    const { schemas, users } = await initUsers()

    const created = users.bootstrapDefaultSuperAdmin('admin', '123456')
    expect(created?.id).toBe(1)

    const row = db.prepare(`SELECT * FROM ${schemas.USERS_TABLE} WHERE id = ?`).get(1) as any
    expect(row.username).toBe('admin')
    expect(row.role).toBe('super_admin')
    expect(row.status).toBe('active')
    expect(row.password_hash).not.toBe('123456')
    expect(users.verifyPassword('123456', row.password_hash)).toBe(true)

    const profileCount = db.prepare(`SELECT COUNT(*) as count FROM ${schemas.USER_PROFILES_TABLE} WHERE user_id = ?`).get(1) as any
    expect(profileCount.count).toBe(0)
  })

  it('allows super admin to access profiles without explicit binding', async () => {
    const { users, auth } = await initUsers()
    const created = users.bootstrapDefaultSuperAdmin('admin', '123456')
    expect(created?.role).toBe('super_admin')

    const ctx = makeCtx({ id: created?.id, username: 'admin', role: 'super_admin' }, 'research')
    const next = vi.fn(async () => {})

    await auth.resolveUserProfile(ctx, next)

    expect(ctx.state.profile).toEqual({ name: 'research' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('requires regular admins to be associated with the requested profile', async () => {
    const { schemas, users, auth } = await initUsers()
    const now = Date.now()
    db.prepare(
      `INSERT INTO ${schemas.USERS_TABLE} (username, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('ops', users.hashPassword('secret'), 'admin', 'active', now, now)
    const admin = users.findUserByUsername('ops')
    expect(admin?.id).toBe(1)

    const deniedCtx = makeCtx({ id: admin!.id, username: 'ops', role: 'admin' }, 'research')
    await auth.resolveUserProfile(deniedCtx, vi.fn(async () => {}))
    expect(deniedCtx.status).toBe(403)

    db.prepare(
      `INSERT INTO ${schemas.USER_PROFILES_TABLE} (user_id, profile_name, is_default, created_at)
       VALUES (?, ?, 1, ?)`
    ).run(admin!.id, 'research', now)

    const allowedCtx = makeCtx({ id: admin!.id, username: 'ops', role: 'admin' }, 'research')
    const next = vi.fn(async () => {})
    await auth.resolveUserProfile(allowedCtx, next)

    expect(allowedCtx.state.profile).toEqual({ name: 'research' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('does not infer a profile when the frontend does not send one', async () => {
    const { auth } = await initUsers()
    const ctx = makeCtx({ id: 1, username: 'admin', role: 'super_admin' }, '')
    const next = vi.fn(async () => {})

    await auth.resolveUserProfile(ctx, next)

    expect(ctx.state.profile).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()

    await auth.requireUserProfile(ctx, vi.fn(async () => {}))
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Profile is required' })
  })

  it.each([
    '/api/devices/peer-connections',
    '/api/devices/peer-connections/conn-1/terminals',
    '/api/devices/peer-connections/conn-1/exec',
  ])('allows server token for local MCP device endpoint %s', async (path) => {
    vi.stubEnv('AUTH_TOKEN', 'server-token')
    const { auth } = await initUsers()
    const ctx = {
      path,
      headers: { authorization: 'Bearer server-token' },
      query: {},
      ip: '127.0.0.1',
      request: { ip: '127.0.0.1', body: {} },
      req: { socket: { remoteAddress: '127.0.0.1' } },
      state: {},
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.state.serverTokenAuth).toBe(true)
  })

  it.each([
    '/api/hermes/media/apikey-image-generate',
    '/api/hermes/media/grok-image-to-video',
    '/api/devices',
    '/api/devices/scan',
    '/api/devices/device-1/connect',
    '/api/devices/peer-connections',
    '/api/devices/peer-connections/conn-1/disconnect',
    '/api/devices/peer-connections/conn-1/terminal',
    '/api/devices/peer-connections/conn-1/terminals',
    '/api/devices/peer-connections/conn-1/terminal/term-1/read',
    '/api/devices/peer-connections/conn-1/terminal/term-1/input',
    '/api/devices/peer-connections/conn-1/terminal/term-1/resize',
    '/api/devices/peer-connections/conn-1/terminal/term-1/close',
    '/api/devices/peer-connections/conn-1/exec',
    '/api/devices/peer-connections/conn-1/download',
    '/api/devices/peer-connections/conn-1/upload',
  ])('rejects server token for local-only endpoint %s from non-loopback clients', async (path) => {
    vi.stubEnv('AUTH_TOKEN', 'server-token')
    const { auth } = await initUsers()
    const ctx = {
      path,
      headers: { authorization: 'Bearer server-token' },
      query: {},
      ip: '192.168.1.50',
      request: { ip: '192.168.1.50', body: {} },
      req: { socket: { remoteAddress: '192.168.1.50' } },
      state: {},
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('ignores stale profile headers for the aggregate available-models endpoint', async () => {
    const { auth } = await initUsers()
    const ctx = {
      path: '/api/hermes/available-models',
      state: { user: { id: 1, username: 'ops', role: 'admin' } },
      query: {},
      request: { body: {} },
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'private' : ''),
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.resolveUserProfile(ctx, next)

    expect(ctx.state.profile).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it('does not create the default super admin until first valid bootstrap login', async () => {
    const { schemas, users } = await initUsers()

    expect(users.countUsers()).toBe(0)
    expect(users.bootstrapDefaultSuperAdmin('admin', 'bad-password')).toBeNull()
    expect(users.countUsers()).toBe(0)

    const created = users.bootstrapDefaultSuperAdmin('admin', '123456')
    expect(created?.role).toBe('super_admin')
    expect(users.countUsers()).toBe(1)

    const userCount = db.prepare(`SELECT COUNT(*) as count FROM ${schemas.USERS_TABLE}`).get() as any
    expect(userCount.count).toBe(1)
  })

  it('signs and verifies user JWTs', async () => {
    const { auth } = await initUsers()
    const token = auth.signUserJwt({ id: 1, username: 'admin', role: 'super_admin' }, 'secret', 1000)

    const payload = auth.verifyUserJwt(token, 'secret', 1000)
    expect(payload?.sub).toBe('1')
    expect(payload?.username).toBe('admin')
    expect(payload?.role).toBe('super_admin')

    expect(auth.verifyUserJwt(token, 'wrong', 1000)).toBeNull()
  })

  it('authenticates JWTs passed as query tokens for download and websocket URLs', async () => {
    const { users, auth } = await initUsers()
    const user = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const token = auth.signUserJwt(user, 'test-secret')
    const ctx = {
      path: '/api/hermes/download',
      headers: {},
      query: { token },
      state: {},
      request: { body: {} },
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(ctx.state.user).toEqual({ id: user.id, username: 'admin', role: 'super_admin' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('lets SPA and static asset paths pass through without a JWT', async () => {
    const { auth } = await initUsers()
    const ctx = {
      path: '/',
      headers: {},
      query: {},
      state: {},
      request: { body: {} },
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
    expect(ctx.body).toBeNull()
  })

  it('still requires a JWT for protected API paths', async () => {
    const { auth } = await initUsers()
    const ctx = {
      path: '/api/hermes/sessions',
      headers: {},
      query: {},
      state: {},
      request: { body: {} },
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('bootstraps the default super admin through password login and returns a user JWT', async () => {
    await initUsers()
    const ctrl = await import('../../packages/server/src/controllers/auth')
    const ctx = {
      request: { body: { username: 'admin', password: '123456' } },
      headers: {},
      ip: '127.0.0.1',
      status: 200,
      body: null,
    } as any

    await ctrl.login(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
  })

  it('marks only admin with password 123456 as requiring a credential change', async () => {
    const { users } = await initUsers()
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const ctrl = await import('../../packages/server/src/controllers/auth')

    const defaultCtx = {
      state: { user: { id: admin.id, username: 'admin', role: 'super_admin' } },
      status: 200,
      body: null,
    } as any
    await ctrl.currentUser(defaultCtx)
    expect(defaultCtx.body.user.requiresCredentialChange).toBe(true)

    users.updateUserPassword(admin.id, 'stronger-password')
    const passwordChangedCtx = {
      state: { user: { id: admin.id, username: 'admin', role: 'super_admin' } },
      status: 200,
      body: null,
    } as any
    await ctrl.currentUser(passwordChangedCtx)
    expect(passwordChangedCtx.body.user.requiresCredentialChange).toBe(false)

    users.updateUserPassword(admin.id, '123456')
    users.updateUsername(admin.id, 'owner')
    const usernameChangedCtx = {
      state: { user: { id: admin.id, username: 'owner', role: 'super_admin' } },
      status: 200,
      body: null,
    } as any
    await ctrl.currentUser(usernameChangedCtx)
    expect(usernameChangedCtx.body.user.requiresCredentialChange).toBe(false)
  })

  it('lets super admins create regular admins with profile bindings', async () => {
    const { users } = await initUsers()
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      listProfileNamesFromDisk: () => ['default', 'research'],
    }))
    const ctrl = await import('../../packages/server/src/controllers/auth')
    const ctx = {
      state: { user: { id: 1, username: 'admin', role: 'super_admin' } },
      request: {
        body: {
          username: 'ops',
          password: 'secret1',
          role: 'admin',
          status: 'active',
          profiles: ['research'],
        },
      },
      status: 200,
      body: null,
    } as any

    await ctrl.createManagedUser(ctx)

    expect(ctx.status).toBe(201)
    const created = users.findUserByUsername('ops')
    expect(created?.role).toBe('admin')
    expect(users.listUserProfiles(created!.id).map(profile => profile.profile_name)).toEqual(['research'])
  })

  it('does not allow disabling the last active super admin', async () => {
    const { users } = await initUsers()
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      listProfileNamesFromDisk: () => ['default'],
    }))
    const ctrl = await import('../../packages/server/src/controllers/auth')
    const ctx = {
      state: { user: { id: admin.id, username: 'admin', role: 'super_admin' } },
      params: { id: String(admin.id) },
      request: { body: { status: 'disabled' } },
      status: 200,
      body: null,
    } as any

    await ctrl.updateManagedUser(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'You cannot disable your own account' })
  })

  it('requires super admin for super-admin-only middleware', async () => {
    const { auth } = await initUsers()
    const adminCtx = makeCtx({ id: 2, username: 'ops', role: 'admin' }, 'default')
    await auth.requireSuperAdmin(adminCtx, vi.fn(async () => {}))
    expect(adminCtx.status).toBe(403)

    const superCtx = makeCtx({ id: 1, username: 'admin', role: 'super_admin' }, 'default')
    const next = vi.fn(async () => {})
    await auth.requireSuperAdmin(superCtx, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
