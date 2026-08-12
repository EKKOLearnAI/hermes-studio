import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  authenticateUserToken: vi.fn(),
  getDeviceId: vi.fn(),
}))

const clientSocketMocks = vi.hoisted(() => {
  const sockets: any[] = []
  const io = vi.fn((url: string, options: Record<string, unknown>) => {
    const handlers = new Map<string, (...args: any[]) => void>()
    const socket: any = {
      id: `local-${sockets.length + 1}`,
      connected: true,
      __url: url,
      __options: options,
      __handlers: handlers,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      onAny: vi.fn((handler: (...args: any[]) => void) => {
        socket.__onAny = handler
        return socket
      }),
      emit: vi.fn(),
      disconnect: vi.fn(() => { socket.connected = false }),
    }
    sockets.push(socket)
    return socket
  })
  return { io, sockets }
})

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: authMocks.authenticateUserToken,
}))

vi.mock('../../packages/server/src/services/system-info', () => ({
  getDeviceId: authMocks.getDeviceId,
}))

vi.mock('socket.io-client', () => ({
  io: clientSocketMocks.io,
}))

function createMockNamespace() {
  const middleware: Array<(socket: any, next: (err?: Error) => void) => void> = []
  const handlers = new Map<string, (...args: any[]) => void>()
  const namespace: any = {
    use: vi.fn((handler: (socket: any, next: (err?: Error) => void) => void) => {
      middleware.push(handler)
      return namespace
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return namespace
    }),
    __middleware: middleware,
    __handlers: handlers,
  }
  return namespace
}

function createMockAppSocket(id: string, auth: Record<string, unknown>) {
  const handlers = new Map<string, (...args: any[]) => void>()
  const socket: any = {
    id,
    connected: true,
    data: {},
    handshake: { auth },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    once: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: vi.fn(),
    disconnect: vi.fn(() => { socket.connected = false }),
    __handlers: handlers,
  }
  return socket
}

async function connectApp(namespace: ReturnType<typeof createMockNamespace>, socket: any): Promise<void> {
  const next = vi.fn()
  await namespace.__middleware[0](socket, next)
  expect(next).toHaveBeenCalledWith()
  namespace.__handlers.get('connection')?.(socket)
}

describe('LocalAppRelayServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientSocketMocks.sockets.length = 0
    authMocks.getDeviceId.mockResolvedValue('hwui_local_machine_1234567890')
    authMocks.authenticateUserToken.mockResolvedValue({
      id: 7,
      username: 'app-user',
      role: 'user',
    })
  })

  it('accepts the selected machine with a valid token or in login-only mode', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any)
    server.init()

    expect(io.of).toHaveBeenCalledWith('/app-relay')
    const denied = createMockAppSocket('denied', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_other_machine_1234567890',
    })
    const deniedNext = vi.fn()
    await namespace.__middleware[0](denied, deniedNext)
    expect(deniedNext.mock.calls[0][0]).toBeInstanceOf(Error)

    const allowed = createMockAppSocket('allowed', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, allowed)
    expect(allowed.emit).toHaveBeenCalledWith('relay.ready', expect.objectContaining({
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      hostConnected: true,
    }))

    const loginOnly = createMockAppSocket('login-only', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, loginOnly)
    expect(loginOnly.data.localUserToken).toBe('')
  })

  it('forwards login over the socket, remembers its token, then unlocks protected requests', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const issuedToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
    authMocks.authenticateUserToken.mockImplementation(async (token: string) => token === issuedToken
      ? { id: 7, username: 'app-user', role: 'user' }
      : null)
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/api/auth/login')
      ? new Response(JSON.stringify({ token: issuedToken, userId: 7 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
    const { LocalAppRelayServer } = await import('../../packages/server/src/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const app = createMockAppSocket('app-login', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)

    const deniedAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'protected-before-login',
      method: 'GET',
      path: '/api/hermes/sessions',
    }, deniedAck)
    await vi.waitFor(() => expect(deniedAck).toHaveBeenCalledWith(expect.objectContaining({
      status: 401,
      error: expect.objectContaining({ code: 'app_relay_unauthorized' }),
    })))
    expect(fetchImpl).not.toHaveBeenCalled()

    const loginAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'login-1',
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        authorization: 'Bearer untrusted-token',
        'content-type': 'application/json',
      },
      body: { username: 'studio-user', password: 'secret' },
    }, loginAck)
    await vi.waitFor(() => expect(loginAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'login-1',
      status: 200,
      body: expect.stringContaining(issuedToken),
    })))
    expect(app.data.localUserToken).toBe(issuedToken)
    const loginHeaders = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(loginHeaders.get('authorization')).toBeNull()

    const protectedAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'protected-after-login',
      method: 'GET',
      path: '/api/hermes/sessions',
    }, protectedAck)
    await vi.waitFor(() => expect(protectedAck).toHaveBeenCalledWith(expect.objectContaining({ status: 200 })))
    const protectedHeaders = fetchImpl.mock.calls[1][1]?.headers as Headers
    expect(protectedHeaders.get('authorization')).toBe(`Bearer ${issuedToken}`)
  })

  it('handles the cloud-compatible HTTP relay request directly on loopback', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { LocalAppRelayServer } = await import('../../packages/server/src/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const app = createMockAppSocket('app-http', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    const ack = vi.fn()
    app.__handlers.get('http.request')({
      id: 'http-1',
      method: 'GET',
      path: '/api/hermes/sessions?profile=default',
    }, ack)

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      id: 'http-1',
      status: 200,
      body: '{"sessions":[]}',
    })))
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/api/hermes/sessions?profile=default',
      expect.objectContaining({ method: 'GET' }),
    )
    const headers = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer local-user-token')
    expect(clientSocketMocks.io).not.toHaveBeenCalled()

    fetchImpl.mockResolvedValueOnce(new Response(Uint8Array.from([7, 8, 9]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    const binaryAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'binary-1',
      method: 'POST',
      path: '/api/hermes/tts/synthesize',
      headers: { 'content-type': 'application/octet-stream' },
      bodyBytes: Uint8Array.from([1, 2, 3]),
    }, binaryAck)
    await vi.waitFor(() => expect(binaryAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'binary-1',
      status: 200,
      bodyBytes: expect.any(Uint8Array),
    })))
    const binaryRequest = fetchImpl.mock.calls[1][1]
    expect(Buffer.from(binaryRequest?.body as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    const binaryResponse = binaryAck.mock.calls[0][0].bodyBytes as Uint8Array
    expect(Buffer.from(binaryResponse)).toEqual(Buffer.from([7, 8, 9]))
  })

  it('bridges /chat-run directly with the same App socket events as the cloud relay', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
    })
    server.init()

    const app = createMockAppSocket('app-chat', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    const openAck = vi.fn()
    app.__handlers.get('socket.open')({
      id: 'chat-1',
      namespace: '/chat-run',
      auth: { token: 'untrusted-token' },
      query: { profile: 'default' },
    }, openAck)

    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith({
      id: 'chat-1',
      ok: true,
      namespace: '/chat-run',
      stream: true,
    }))
    expect(clientSocketMocks.io).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/chat-run',
      expect.objectContaining({
        auth: { token: 'local-user-token' },
        query: { profile: 'default' },
      }),
    )

    const local = clientSocketMocks.sockets[0]
    const eventAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'chat-1',
      event: 'run',
      payload: { session_id: 'session-1', input: 'hello' },
    }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chat-1',
      ok: true,
      event: 'run',
    })))
    expect(local.emit).toHaveBeenCalledWith('run', { session_id: 'session-1', input: 'hello' })

    const insertAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'chat-1',
      event: 'insert_queued_run',
      payload: { session_id: 'session-1', queue_id: 'queue-1' },
    }, insertAck)
    await vi.waitFor(() => expect(insertAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chat-1',
      ok: true,
      event: 'insert_queued_run',
    })))
    expect(local.emit).toHaveBeenCalledWith('insert_queued_run', {
      session_id: 'session-1',
      queue_id: 'queue-1',
    })

    local.__onAny('message.delta', { session_id: 'session-1', delta: 'hi' })
    expect(app.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 'session-1', delta: 'hi' },
    })
  })
})
