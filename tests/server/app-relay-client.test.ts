import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIo, sockets } = vi.hoisted(() => {
  const sockets: any[] = []

  function createSocket(url: string) {
    const handlers = new Map<string, (...args: any[]) => void>()
    const socket: any = {
      id: `socket-${sockets.length + 1}`,
      __url: url,
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
    mockIo: vi.fn((url: string) => {
      const socket = createSocket(url)
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
    expect(runAck).toHaveBeenCalledWith(expect.objectContaining({ id: 'relay-chat-1', ok: true, event: 'run' }))

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
    expect(insertAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-chat-1',
      ok: true,
      event: 'insert_queued_run',
    }))

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
})
