import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  authenticateUserToken: vi.fn(),
  userCanAccessProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: authMocks.authenticateUserToken,
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: authMocks.userCanAccessProfile,
}))

function createMockNamespace() {
  const middleware: Array<(socket: any, next: (err?: Error) => void) => void> = []
  const handlers = new Map<string, (...args: any[]) => void>()
  const nsp: any = {
    use: vi.fn((fn: (socket: any, next: (err?: Error) => void) => void) => {
      middleware.push(fn)
      return nsp
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return nsp
    }),
    emit: vi.fn(),
    __middleware: middleware,
    __handlers: handlers,
  }
  return nsp
}

function createMockSocket(id: string, auth: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...args: any[]) => void>()
  const socket: any = {
    id,
    data: {},
    handshake: { auth },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: vi.fn((_event: string, payload: unknown, ack?: (response: unknown) => void) => {
      ack?.({ id: (payload as any)?.id, status: 200, body: '{"ok":true}' })
      return socket
    }),
    __handlers: handlers,
  }
  return socket
}

describe('GlobalAgentServer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    authMocks.authenticateUserToken.mockResolvedValue(null)
    authMocks.userCanAccessProfile.mockReturnValue(false)
  })

  it('registers a local control namespace with token auth', async () => {
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()

    expect(io.of).toHaveBeenCalledWith('/global-agent')
    expect(nsp.use).toHaveBeenCalledTimes(1)
    expect(nsp.on).toHaveBeenCalledWith('connection', expect.any(Function))

    const denied = createMockSocket('socket-denied', { token: 'wrong' })
    const deniedNext = vi.fn()
    await nsp.__middleware[0](denied, deniedNext)
    expect(deniedNext.mock.calls[0][0]).toBeInstanceOf(Error)

    const allowed = createMockSocket('socket-allowed', { token: server.getAuthToken() })
    const allowedNext = vi.fn()
    await nsp.__middleware[0](allowed, allowedNext)
    expect(allowedNext).toHaveBeenCalledWith()
  })

  it('tracks connected clients and forwards requests with ack', async () => {
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()
    const socket = createMockSocket('socket-1', { token: server.getAuthToken(), instanceId: 'local-global-agent' })
    nsp.__handlers.get('connection')?.(socket)

    expect(server.getClientIds()).toEqual(['local-global-agent'])

    const response = await server.httpRequest({
      id: 'req-1',
      method: 'GET',
      path: '/api/auth/users',
    }, { clientId: 'local-global-agent' })

    expect(socket.emit).toHaveBeenCalledWith(
      'http.request',
      { id: 'req-1', method: 'GET', path: '/api/auth/users' },
      expect.any(Function),
    )
    expect(response).toEqual({ id: 'req-1', status: 200, body: '{"ok":true}' })
  })

  it('accepts frontend JWT clients and injects their token and profile into forwarded requests', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', { token: server.getAuthToken(), instanceId: 'local-global-agent' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const frontendSocket = createMockSocket('frontend-socket', { token: 'frontend-jwt', profile: 'research' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](frontendSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(frontendSocket)

    const httpAck = vi.fn()
    frontendSocket.__handlers.get('http.request')?.({
      id: 'req-frontend',
      method: 'GET',
      path: '/api/auth/users',
      clientId: 'local-global-agent',
    }, httpAck)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agentSocket.emit).toHaveBeenCalledWith(
      'http.request',
      {
        id: 'req-frontend',
        method: 'GET',
        path: '/api/auth/users',
        clientId: 'local-global-agent',
        headers: {
          authorization: 'Bearer frontend-jwt',
          'x-hermes-profile': 'research',
        },
      },
      expect.any(Function),
    )
    expect(httpAck).toHaveBeenCalledWith({ id: 'req-frontend', status: 200, body: '{"ok":true}' })

    const openAck = vi.fn()
    frontendSocket.__handlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
      clientId: 'local-global-agent',
    }, openAck)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agentSocket.emit).toHaveBeenCalledWith(
      'socket.open',
      {
        id: 'chat-1',
        namespace: '/chat-run',
        clientId: 'local-global-agent',
        auth: { token: 'frontend-jwt' },
        query: { profile: 'research' },
      },
      expect.any(Function),
    )
  })

  it('does not forward reserved Socket.IO lifecycle events to frontend clients', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', { token: server.getAuthToken(), instanceId: 'local-global-agent' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const frontendSocket = createMockSocket('frontend-socket', { token: 'frontend-jwt', profile: 'research' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](frontendSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(frontendSocket)

    const bridgeId = 'frontend:frontend-socket:chat-run'
    const openAck = vi.fn()
    frontendSocket.__handlers.get('socket.open')?.({
      id: bridgeId,
      namespace: '/chat-run',
      clientId: 'local-global-agent',
    }, openAck)
    await new Promise(resolve => setTimeout(resolve, 0))
    frontendSocket.emit.mockClear()

    agentSocket.__handlers.get('socket.event')?.({
      id: bridgeId,
      namespace: '/chat-run',
      event: 'connect',
      payload: { socketId: 'local-chat-run' },
    })
    expect(frontendSocket.emit).not.toHaveBeenCalledWith('connect', expect.anything())

    agentSocket.__handlers.get('socket.event')?.({
      id: bridgeId,
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 's1', delta: 'hi' },
    })
    expect(frontendSocket.emit).toHaveBeenCalledWith('message.delta', { session_id: 's1', delta: 'hi' })
  })
})
