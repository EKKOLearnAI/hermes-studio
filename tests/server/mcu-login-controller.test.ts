import { beforeEach, describe, expect, it, vi } from 'vitest'

const { startOutboundRelayClientMock, stopOutboundRelayClientMock } = vi.hoisted(() => ({
  startOutboundRelayClientMock: vi.fn(),
  stopOutboundRelayClientMock: vi.fn(),
}))

vi.mock('../../packages/server/src/services/global-agent/outbound-relay-client', () => ({
  startOutboundRelayClient: startOutboundRelayClientMock,
  stopOutboundRelayClient: stopOutboundRelayClientMock,
}))

describe('MCU login controller', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')

    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
  })

  async function loadModules() {
    return {
      ctrl: await import('../../packages/server/src/controllers/auth'),
      users: await import('../../packages/server/src/db/hermes/users-store'),
      auth: await import('../../packages/server/src/middleware/user-auth'),
    }
  }

  function makeCtx(body: Record<string, unknown>) {
    return {
      request: { body },
      headers: {},
      query: {},
      ip: '127.0.0.1',
      status: 200,
      body: null,
      get: vi.fn(() => ''),
      req: { socket: { remoteAddress: '127.0.0.1' } },
    } as any
  }

  it('requires MCU login identity and credential fields', async () => {
    const { ctrl } = await loadModules()
    const ctx = makeCtx({
      token: 'relay-token',
      id: 'mcu-1',
      account: 'admin',
    })

    await ctrl.microcontrollerLogin(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'token, id, account and password are required' })
    expect(startOutboundRelayClientMock).not.toHaveBeenCalled()
  })

  it('rejects invalid existing account credentials', async () => {
    const { ctrl, users } = await loadModules()
    users.bootstrapDefaultSuperAdmin('admin', '123456')
    const ctx = makeCtx({
      token: 'relay-token',
      url: 'https://relay.example.com/global-agent',
      id: 'mcu-1',
      account: 'admin',
      password: 'wrong',
    })

    await ctrl.microcontrollerLogin(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Invalid username or password' })
    expect(startOutboundRelayClientMock).not.toHaveBeenCalled()
  })

  it('returns a user token without starting outbound relay when url is omitted', async () => {
    const { ctrl, users, auth } = await loadModules()
    users.createUser({
      username: 'ops',
      password: 'secret123',
      role: 'admin',
      profiles: ['default', 'research'],
      defaultProfile: 'research',
    })
    const ctx = makeCtx({
      token: 'relay-token',
      id: 'mcu-1',
      account: 'ops',
      password: 'secret123',
    })

    await ctrl.microcontrollerLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.relay).toEqual({
      connected: false,
      id: 'mcu-1',
    })
    expect(ctx.body.profiles).toEqual(['research', 'default'])
    expect(await auth.authenticateUserToken(ctx.body.token)).toEqual(expect.objectContaining({
      username: 'ops',
      role: 'admin',
      profiles: ['research', 'default'],
    }))
    expect(stopOutboundRelayClientMock).toHaveBeenCalledWith('mcu-1')
    expect(startOutboundRelayClientMock).not.toHaveBeenCalled()
  })

  it('returns a user token and starts the outbound relay client when url is provided', async () => {
    startOutboundRelayClientMock.mockReturnValue({ start: vi.fn() })
    const { ctrl, users, auth } = await loadModules()
    users.createUser({
      username: 'ops',
      password: 'secret123',
      role: 'admin',
      profiles: ['default', 'research'],
      defaultProfile: 'research',
    })
    const ctx = makeCtx({
      token: 'relay-token',
      url: 'https://user:pass@relay.example.com/global-agent',
      id: 'mcu-1',
      account: 'ops',
      password: 'secret123',
    })

    await ctrl.microcontrollerLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.relay).toEqual({
      connected: true,
      id: 'mcu-1',
      url: 'https://relay.example.com/global-agent',
    })
    expect(ctx.body.profiles).toEqual(['research', 'default'])
    expect(await auth.authenticateUserToken(ctx.body.token)).toEqual(expect.objectContaining({
      username: 'ops',
      role: 'admin',
      profiles: ['research', 'default'],
    }))
    expect(stopOutboundRelayClientMock).toHaveBeenCalledWith('mcu-1')
    expect(startOutboundRelayClientMock).toHaveBeenCalledWith({
      connectionId: 'mcu-1',
      relayUrl: 'https://relay.example.com/global-agent',
      relayToken: 'relay-token',
      userToken: ctx.body.token,
      instanceId: 'mcu-1',
      relayProtocol: 'socket.io',
    })
  })
})
