import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('App connection authorization', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_JWT_SECRET', 'app-auth-test-secret')
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.doUnmock('../../packages/server/src/services/lan-discovery')
    vi.doUnmock('../../packages/server/src/services/system-info')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  function jwtPayload(token: string): Record<string, any> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'))
  }

  it('records the authorizing user and exchanges once for that user\'s 30-day device token', async () => {
    const users = await import('../../packages/server/src/db/hermes/users-store')
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    vi.doMock('../../packages/server/src/services/lan-discovery', async importOriginal => ({
      ...await importOriginal<typeof import('../../packages/server/src/services/lan-discovery')>(),
      getLanBackendUrl: () => 'http://192.168.1.20:8648',
    }))
    vi.doMock('../../packages/server/src/services/system-info', async importOriginal => ({
      ...await importOriginal<typeof import('../../packages/server/src/services/system-info')>(),
      getDeviceId: async () => 'hwui_local_machine_1234567890',
    }))
    const appConnectionsController = await import('../../packages/server/src/controllers/app-connections')
    const authController = await import('../../packages/server/src/controllers/auth')
    const authMiddleware = await import('../../packages/server/src/middleware/user-auth')
    const store = await import('../../packages/server/src/db/hermes/app-connections-store')

    const authorizationCtx = {
      state: { user: { id: admin.id, username: admin.username, role: admin.role } },
      req: { socket: { remoteAddress: '127.0.0.1' } },
      status: 200,
      body: null,
    } as any
    await appConnectionsController.createAppAuthorizationCodeController(authorizationCtx)

    expect(authorizationCtx.status).toBe(201)
    expect(authorizationCtx.body).toMatchObject({
      type: 'hermes-studio.app-connection',
      version: 1,
      connection_type: 'lan',
      backend_url: 'http://192.168.1.20:8648',
      machine_id: 'hwui_local_machine_1234567890',
      authorization_code: expect.any(String),
      expires_at: expect.any(Number),
      qr_payload: expect.any(String),
    })
    expect(JSON.parse(authorizationCtx.body.qr_payload)).toEqual({
      type: authorizationCtx.body.type,
      version: authorizationCtx.body.version,
      connection_type: authorizationCtx.body.connection_type,
      backend_url: authorizationCtx.body.backend_url,
      machine_id: authorizationCtx.body.machine_id,
      authorization_code: authorizationCtx.body.authorization_code,
      expires_at: authorizationCtx.body.expires_at,
    })
    const storedAuthorization = db.prepare('SELECT * FROM app_authorization_codes').get() as any
    expect(storedAuthorization.created_by_user_id).toBe(admin.id)
    expect(storedAuthorization.code_hash).not.toBe(authorizationCtx.body.authorization_code)

    const loginCtx = {
      request: {
        body: {
          authorization_code: authorizationCtx.body.authorization_code,
          device_code: 'phone-001',
          device_name: 'Alice iPhone',
          device_brand: 'Apple',
          device_model: 'iPhone 17,1',
        },
      },
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-app-connection' ? 'cloud' : ''),
      ip: '127.0.0.1',
      req: { socket: { remoteAddress: '127.0.0.1' } },
      status: 200,
      body: null,
    } as any
    await authController.appLogin(loginCtx)

    expect(loginCtx.status).toBe(200)
    const payload = jwtPayload(loginCtx.body.token)
    expect(payload).toMatchObject({
      sub: String(admin.id),
      username: admin.username,
      role: 'super_admin',
      type: 'app_access',
      app_device_code: 'phone-001',
      app_connection_type: 'cloud',
    })
    expect(payload.exp - payload.iat).toBe(30 * 24 * 60 * 60)
    expect(store.listAppConnections()).toEqual([
      expect.objectContaining({
        device_code: 'phone-001',
        device_name: 'Alice iPhone',
        device_brand: 'Apple',
        device_model: 'iPhone 17,1',
        connection_type: 'cloud',
        user_id: admin.id,
      }),
    ])

    const protectedCtx = {
      path: '/api/hermes/sessions',
      headers: { authorization: `Bearer ${loginCtx.body.token}` },
      query: {},
      state: {},
      request: { body: {} },
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})
    await authMiddleware.requireUserJwt(protectedCtx, next)
    expect(next).toHaveBeenCalledOnce()
    expect(protectedCtx.state.user).toMatchObject({ id: admin.id, role: 'super_admin' })

    expect(store.revokeAppConnection(loginCtx.body.appConnection.id)).toBeTruthy()
    expect(await authMiddleware.inspectAppUserToken(loginCtx.body.token)).toMatchObject({
      status: 'revoked',
      user: { id: admin.id, role: 'super_admin' },
      deviceCode: 'phone-001',
      connectionType: 'cloud',
    })
    expect(await authMiddleware.authenticateUserToken(loginCtx.body.token)).toBeNull()

    const reusedCtx = {
      ...loginCtx,
      status: 200,
      body: null,
    } as any
    await authController.appLogin(reusedCtx)
    expect(reusedCtx.status).toBe(409)
  })

  it('keeps one row per phone and connection type while refreshing repeated logins', async () => {
    const users = await import('../../packages/server/src/db/hermes/users-store')
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const authController = await import('../../packages/server/src/controllers/auth')
    const store = await import('../../packages/server/src/db/hermes/app-connections-store')

    async function login(connectionType: 'lan' | 'cloud', deviceName: string) {
      const issued = store.createAppAuthorizationCode(admin.id)
      const ctx = {
        request: {
          body: {
            authorization_code: issued.authorizationCode,
            device_code: 'phone-001',
            device_name: deviceName,
            device_brand: 'Apple',
            device_model: 'iPhone 17,1',
          },
        },
        get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-app-connection' ? connectionType : ''),
        ip: '127.0.0.1',
        req: { socket: { remoteAddress: '127.0.0.1' } },
        status: 200,
        body: null,
      } as any
      await authController.appLogin(ctx)
      expect(ctx.status).toBe(200)
      return ctx.body.token as string
    }

    const firstLanToken = await login('lan', 'Alice iPhone')
    const latestLanToken = await login('lan', 'Alice iPhone 16')
    const cloudToken = await login('cloud', 'Alice iPhone 16')
    const connections = store.listAppConnections()

    expect(connections).toHaveLength(2)
    expect(connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ device_code: 'phone-001', device_name: 'Alice iPhone 16', connection_type: 'lan' }),
      expect.objectContaining({ device_code: 'phone-001', device_name: 'Alice iPhone 16', connection_type: 'cloud' }),
    ]))
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', firstLanToken, admin.id)).toBe(false)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', latestLanToken, admin.id)).toBe(true)
    expect(store.isAppConnectionTokenActive('phone-001', 'cloud', cloudToken, admin.id)).toBe(true)
  })

  it('lets an active non-super-admin user manually issue their own App token', async () => {
    const users = await import('../../packages/server/src/db/hermes/users-store')
    const member = users.createUser({
      username: 'member',
      password: ' secret-with-spaces ',
      role: 'admin',
      profiles: ['default'],
      defaultProfile: 'default',
    })
    const authController = await import('../../packages/server/src/controllers/auth')
    const authMiddleware = await import('../../packages/server/src/middleware/user-auth')
    const store = await import('../../packages/server/src/db/hermes/app-connections-store')
    const ctx = {
      request: {
        body: {
          username: 'member',
          password: ' secret-with-spaces ',
          device_code: 'member-phone',
          device_name: 'Member Phone',
          device_brand: 'Google',
          device_model: 'Pixel 10 Pro',
        },
        ip: '192.168.1.20',
      },
      get: vi.fn(() => ''),
      ip: '192.168.1.20',
      req: { socket: { remoteAddress: '192.168.1.20' } },
      status: 200,
      body: null,
    } as any

    await authController.appLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(jwtPayload(ctx.body.token)).toMatchObject({
      sub: String(member.id),
      role: 'admin',
      type: 'app_access',
      app_device_code: 'member-phone',
      app_connection_type: 'lan',
    })
    expect(await authMiddleware.authenticateUserToken(ctx.body.token)).toMatchObject({
      id: member.id,
      role: 'admin',
      profiles: ['default'],
    })
    expect(store.listAppConnections()).toEqual([
      expect.objectContaining({
        device_code: 'member-phone',
        device_name: 'Member Phone',
        device_brand: 'Google',
        device_model: 'Pixel 10 Pro',
        connection_type: 'lan',
        user_id: member.id,
      }),
    ])
  })
})
