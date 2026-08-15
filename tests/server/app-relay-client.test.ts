import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIo, sockets } = vi.hoisted(() => {
  const sockets: any[] = []

  function createSocket(url: string, options?: Record<string, unknown>) {
    const handlers = new Map<string, (...args: any[]) => void>()
    const socket: any = {
      id: `socket-${sockets.length + 1}`,
      __url: url,
      __options: options,
      __handlers: handlers,
      connected: false,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      onAny: vi.fn((handler: (...args: any[]) => void) => {
        socket.__onAny = handler
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      off: vi.fn(),
      emit: vi.fn(),
      timeout: vi.fn(() => socket),
      disconnect: vi.fn(() => { socket.connected = false }),
    }
    return socket
  }

  return {
    sockets,
    mockIo: vi.fn((url: string, options?: Record<string, unknown>) => {
      const socket = createSocket(url, options)
      sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('socket.io-client', () => ({ io: mockIo }))
vi.mock('../../packages/server/src/services/system-info', () => ({
  createDeviceSignature: vi.fn(async () => 'machine-signature'),
}))

describe('AppRelayClient', () => {
  beforeEach(async () => {
    const { stopAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    stopAppRelayClient()
    sockets.length = 0
    vi.clearAllMocks()
  })

  it('connects with a signed machine identity independent of the MCU relay', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    const publicKey = '-----BEGIN PUBLIC KEY-----\nmachine-public-key\n-----END PUBLIC KEY-----\n'
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey,
      machineInfo: { computer_name: 'Studio Mac' },
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    expect(client).not.toBeNull()
    expect(mockIo).toHaveBeenCalledWith('https://relay.example.com/app-relay', expect.objectContaining({
      transports: ['websocket', 'polling'],
      reconnection: true,
    }))
    const options = mockIo.mock.calls[0][1]
    const auth = await new Promise<Record<string, unknown>>(resolve => options.auth(resolve))
    expect(auth).toMatchObject({
      role: 'host',
      machineId: 'hwui_machine_1234567890',
      publicKey,
      signature: 'machine-signature',
      machine: { computer_name: 'Studio Mac' },
    })
    expect(auth.nonce).toEqual(expect.any(String))
    expect(auth.timestamp).toEqual(expect.any(Number))
  })

  it('forwards local API requests with safe headers and binary support', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/api/hermes/tts/synthesize')
      ? new Response(Uint8Array.from([7, 8, 9]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })
    const remote = sockets[0]
    const ack = vi.fn()
    remote.__handlers.get('app.http.request')({
      id: 'http-1',
      method: 'POST',
      path: '/api/hermes/sessions?profile=default',
      headers: {
        authorization: 'Bearer local-user-token',
        'content-type': 'application/json',
        host: 'untrusted.example.com',
      },
      body: { title: 'App session' },
    }, ack)

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      id: 'http-1',
      status: 200,
      body: '{"ok":true}',
    })))
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8648/api/hermes/sessions?profile=default',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'App session' }) }),
    )
    const headers = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer local-user-token')
    expect(headers.has('host')).toBe(false)

    const binaryAck = vi.fn()
    remote.__handlers.get('app.http.request')({
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

  it('marks App authorization-code login as a cloud connection', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'app-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })
    const remote = sockets[0]
    const ack = vi.fn()
    remote.__handlers.get('app.http.request')({
      id: 'app-login-1',
      method: 'POST',
      path: '/api/auth/app-login',
      headers: {
        authorization: 'Bearer untrusted-token',
        'content-type': 'application/json',
      },
      body: {
        authorization_code: 'one-time-code',
        device_code: 'phone-001',
        device_name: 'Alice iPhone',
      },
    }, ack)

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ status: 200 })))
    const headers = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-hermes-app-connection')).toBe('cloud')
  })

  it('requests a bounded cloud preconnection without embedding the relay URL', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })!
    const remote = sockets[0]
    remote.connected = true
    remote.timeout.mockImplementation(() => ({
      emit: (_event: string, request: Record<string, unknown>, ack: (...args: any[]) => void) => {
        expect(request).toEqual({ refresh: false })
        ack(null, {
          ok: true,
          type: 'hermes-studio.app-connection',
          version: 1,
          connectionType: 'cloud',
          machineId: 'hwui_machine_1234567890',
          preconnectId: '70a0af7c-5977-4dd6-bca5-b8e641170658',
          matchingCode: 'matching-code-with-enough-entropy',
          expiresAt: 2000,
          hardExpiresAt: 2600,
          refreshRemaining: 3,
        })
      },
    }))

    const preconnection = await client.requestPreconnection('local-authorization-code', false, 8000, 7)

    expect(preconnection).toMatchObject({
      connectionType: 'cloud',
      machineId: 'hwui_machine_1234567890',
      refreshRemaining: 3,
    })
    expect(preconnection).not.toHaveProperty('relayUrl')
    expect(client.getCachedPreconnection(7, 1000)).toEqual(preconnection)
    expect(client.getCachedPreconnection(8, 1000)).toBeNull()
    expect(client.getCachedPreconnection(7, 2600)).toBeNull()
  })

  it('forwards the authenticated cloud account into Studio authorization', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      token: 'studio-token',
      userId: 1,
      profiles: ['default'],
      appConnection: { token_expires_at: 4_000 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })!
    const remote = sockets[0]
    remote.connected = true
    remote.timeout.mockImplementation(() => ({
      emit: (_event: string, _request: Record<string, unknown>, ack: (...args: any[]) => void) => {
        ack(null, {
          ok: true,
          type: 'hermes-studio.app-connection',
          version: 1,
          connectionType: 'cloud',
          machineId: 'hwui_machine_1234567890',
          preconnectId: '70a0af7c-5977-4dd6-bca5-b8e641170658',
          matchingCode: 'matching-code-with-enough-entropy',
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          hardExpiresAt: Math.floor(Date.now() / 1000) + 900,
          refreshRemaining: 3,
        })
      },
    }))
    const preconnection = await client.requestPreconnection('local-authorization-code', false, 8000, 1)
    const authorizeAck = vi.fn()

    remote.__handlers.get('connection.authorize')({
      preconnectId: preconnection.preconnectId,
      matchingCode: preconnection.matchingCode,
      appUserId: 101,
      deviceCode: 'shared-phone-code',
      deviceName: 'Alice Phone',
    }, authorizeAck)

    await vi.waitFor(() => expect(authorizeAck).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      studioUserId: 1,
    })))
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      device_code: 'shared-phone-code',
      cloud_user_id: 101,
    })
  })

  it('includes the cloud account when revoking a shared device code', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })!
    const remote = sockets[0]
    remote.connected = true
    const emit = vi.fn((_event: string, _request: Record<string, unknown>, ack: (...args: any[]) => void) => {
      ack(null, { ok: true })
    })
    remote.timeout.mockImplementation(() => ({ emit }))

    await expect(client.revokeCloudConnection('shared-phone-code', 101)).resolves.toBe(true)
    expect(emit).toHaveBeenCalledWith(
      'connection.revoke',
      { deviceCode: 'shared-phone-code', appUserId: 101 },
      expect.any(Function),
    )
  })

  it('bridges the full-duplex /chat-run socket without using MCU events', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const remote = sockets[0]
    const openAck = vi.fn()
    remote.__handlers.get('app.socket.open')({
      id: 'relay-chat-1',
      namespace: '/chat-run',
      auth: { token: 'local-user-token' },
      query: { profile: 'default' },
    }, openAck)

    const local = sockets[1]
    expect(local.__url).toBe('http://127.0.0.1:8648/chat-run')
    expect(local.__options).toMatchObject({
      auth: { token: 'local-user-token' },
      query: { profile: 'default' },
    })
    expect(openAck).toHaveBeenCalledWith({
      id: 'relay-chat-1',
      ok: true,
      namespace: '/chat-run',
      stream: true,
    })

    const runAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-chat-1',
      event: 'run',
      payload: { session_id: 'session-1', input: 'hello' },
    }, runAck)
    expect(local.emit).toHaveBeenCalledWith('run', { session_id: 'session-1', input: 'hello' })
    await vi.waitFor(() => expect(runAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-chat-1',
      ok: true,
      event: 'run',
    })))

    const insertAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-chat-1',
      event: 'insert_queued_run',
      payload: { session_id: 'session-1', queue_id: 'queue-1' },
    }, insertAck)
    expect(local.emit).toHaveBeenCalledWith('insert_queued_run', {
      session_id: 'session-1',
      queue_id: 'queue-1',
    })
    await vi.waitFor(() => expect(insertAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-chat-1',
      ok: true,
      event: 'insert_queued_run',
    })))

    local.__onAny('message.delta', { session_id: 'session-1', delta: 'hi' })
    expect(remote.emit).toHaveBeenCalledWith('app.socket.event', {
      id: 'relay-chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 'session-1', delta: 'hi' },
    })

    local.__onAny('subagent.start', { session_id: 'session-1', task_id: 'task-1' })
    expect(remote.emit).toHaveBeenCalledWith('app.socket.event', {
      id: 'relay-chat-1',
      namespace: '/chat-run',
      event: 'subagent.start',
      payload: { session_id: 'session-1', task_id: 'task-1' },
    })

    remote.__handlers.get('disconnect')('transport close')
    expect(local.disconnect).toHaveBeenCalled()
  })

  it('bridges the /workflow status namespace and whitelisted subscription events', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const remote = sockets[0]
    const openAck = vi.fn()
    remote.__handlers.get('app.socket.open')({
      id: 'relay-workflow-1',
      namespace: '/workflow',
      auth: { token: 'local-user-token' },
    }, openAck)

    const local = sockets[1]
    expect(local.__url).toBe('http://127.0.0.1:8648/workflow')
    expect(local.__options).toMatchObject({ auth: { token: 'local-user-token' } })
    expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-workflow-1',
      ok: true,
      namespace: '/workflow',
    }))

    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'workflow.status.subscribe') {
        ack?.({ ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } })
      }
    })
    const eventAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-workflow-1',
      event: 'workflow.status.subscribe',
      payload: { workflowId: 'workflow-a' },
      ack: true,
    }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      namespace: '/workflow',
      event: 'workflow.status.subscribe',
    })))
  })
})
