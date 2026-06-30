import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIo, mockSocket, sockets, socketHandlers, mockWebSockets, MockWebSocket, resetMockSockets } = vi.hoisted(() => {
  function createMockSocket(id: string) {
    const handlers = new Map<string, (...args: any[]) => void>()
    const socket: any = {
      id,
      __handlers: handlers,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
    }
    return socket
  }

  const sockets: any[] = []
  const mockSocket: any = createMockSocket('socket-1')
  const socketHandlers = mockSocket.__handlers as Map<string, (...args: any[]) => void>
  const mockIo = vi.fn(() => {
    const socket = sockets.length === 0 ? mockSocket : createMockSocket(`socket-${sockets.length + 1}`)
    sockets.push(socket)
    return socket
  })
  const resetMockSockets = () => {
    sockets.length = 0
    mockSocket.__handlers.clear()
    mockWebSockets.length = 0
  }

  const mockWebSockets: any[] = []
  class MockWebSocket {
    static OPEN = 1
    readyState = MockWebSocket.OPEN
    __handlers = new Map<string, (...args: any[]) => void>()
    send = vi.fn()
    close = vi.fn()

    constructor(public url: string) {
      mockWebSockets.push(this)
    }

    on(event: string, handler: (...args: any[]) => void) {
      this.__handlers.set(event, handler)
      return this
    }
  }

  return {
    socketHandlers,
    sockets,
    mockSocket,
    mockIo,
    mockWebSockets,
    MockWebSocket,
    resetMockSockets,
  }
})

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('ws', () => ({
  default: MockWebSocket,
}))

describe('outbound relay client', () => {
  beforeEach(async () => {
    const { stopOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')
    stopOutboundRelayClient()
    resetMockSockets()
    vi.clearAllMocks()
  })

  it('stays disabled when no relay url is passed explicitly', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')

    const client = startOutboundRelayClient({ relayUrl: '' })

    expect(client).toBeNull()
    expect(mockIo).not.toHaveBeenCalled()
  })

  it('connects to the configured remote relay as a socket client', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')

    const client = startOutboundRelayClient({
      relayUrl: 'https://user:pass@relay.example.com/hermes',
      relayToken: 'relay-token',
      instanceId: 'studio-1',
      localBaseUrl: 'http://127.0.0.1:9999',
      fetchImpl: vi.fn() as any,
    })

    expect(client).not.toBeNull()
    expect(mockIo).toHaveBeenCalledWith('https://user:pass@relay.example.com/hermes', expect.objectContaining({
      auth: {
        token: 'relay-token',
        instanceId: 'studio-1',
        role: 'hermes-studio',
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
    }))

    socketHandlers.get('connect')?.()
    expect(mockSocket.emit).toHaveBeenCalledWith('relay.ready', {
      capabilities: ['http.request', 'socket.chat-run'],
      instanceId: 'studio-1',
    })
  })

  it('queues missing-STT prompt audio from websocket MCU voice turns', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      audio: {
        text: 'STT is not configured',
        url: 'https://cdn.example.com/missing-stt.pcm',
        mimeType: 'audio/x-pcm',
        sampleRate: 16000,
        channels: 2,
        durationMs: 1800,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { startOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'ws://device.local:8787/',
      relayProtocol: 'websocket',
      userToken: 'user-jwt',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const ws = mockWebSockets[0]
    expect(ws).toBeInstanceOf(MockWebSocket)
    ws.__handlers.get('open')?.()
    ws.__handlers.get('message')?.(JSON.stringify({
      type: 'voice.recorded',
      interactionId: 'voice-1',
      mimeType: 'audio/wav',
      profile: 'default',
    }), false)
    ws.__handlers.get('message')?.(Buffer.from('wav-audio'), true)

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"audio.enqueue"'))
    })
    const enqueuePayload = JSON.parse(
      ws.send.mock.calls
        .map(([payload]: [string]) => payload)
        .find((payload: string) => payload.includes('"audio.enqueue"')),
    )
    expect(enqueuePayload).toMatchObject({
      type: 'audio.enqueue',
      interactionId: 'voice-1',
      segmentId: 'voice-1-prompt',
      text: 'STT is not configured',
      url: 'https://cdn.example.com/missing-stt.pcm',
      mimeType: 'audio/x-pcm',
      channels: 2,
      sampleRate: 16000,
    })
    expect(enqueuePayload).not.toHaveProperty('completionManagedByServer')

    ws.__handlers.get('message')?.(JSON.stringify({
      type: 'audio.done',
      segmentId: 'voice-1-prompt',
    }), false)
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"status":"completed"'))
    })
  })

  it('queues the hosted TTS-failed prompt when websocket MCU speech synthesis fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/hermes/mcu/voice-turn')) {
        return new Response(JSON.stringify({ ok: true, transcript: '你好' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'tts down' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    })
    const { startOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'ws://device.local:8787/',
      relayProtocol: 'websocket',
      userToken: 'user-jwt',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const ws = mockWebSockets[0]
    ws.__handlers.get('open')?.()
    ws.__handlers.get('message')?.(JSON.stringify({
      type: 'voice.recorded',
      interactionId: 'voice-tts-fail',
      mimeType: 'audio/wav',
      profile: 'research',
    }), false)
    ws.__handlers.get('message')?.(Buffer.from('wav-audio'), true)

    await vi.waitFor(() => {
      expect(mockIo).toHaveBeenCalledWith('http://127.0.0.1:8648/chat-run', expect.any(Object))
    })
    const localSocket = sockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    localSocket.__handlers.get('message.delta')?.({ delta: '你好' })
    localSocket.__handlers.get('run.completed')?.({})

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('tts-failed-24k.s16le.pcm'))
    })
    const ttsCalls = fetchImpl.mock.calls.filter(([url]: [string]) => url.includes('/api/hermes/tts/synthesize'))
    expect(ttsCalls).toHaveLength(2)
    expect(ttsCalls[0][1].headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
    expect(ttsCalls[1][1].headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
    const enqueuePayload = JSON.parse(
      ws.send.mock.calls
        .map(([payload]: [string]) => payload)
        .find((payload: string) => payload.includes('tts-failed-24k.s16le.pcm')),
    )
    expect(enqueuePayload).toMatchObject({
      type: 'audio.enqueue',
      interactionId: 'voice-tts-fail',
      segmentId: 'voice-tts-fail-tts-1-failed-prompt',
      text: '当前文字转语音失败了，请配置下文字转语音再使用哦',
      url: '/api/hermes/mcu/audio/tts-failed-24k.s16le.pcm',
      mimeType: 'audio/x-pcm',
      format: 's16le',
      channels: 1,
      sampleRate: 24000,
    })
    expect(enqueuePayload).not.toHaveProperty('completionManagedByServer')
  })

  it('forwards an allowed HTTP request to the local Web UI server', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: {
        'content-type': 'application/json',
        'x-result': 'accepted',
        'transfer-encoding': 'chunked',
      },
    }))
    const { OutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')
    const client = new OutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      relayToken: '',
      instanceId: '',
      localBaseUrl: 'http://127.0.0.1:8648/',
      fetchImpl: fetchImpl as any,
    })

    const response = await client.handleHttpRequest({
      id: 'req-1',
      method: 'POST',
      path: '/api/hermes/sessions?profile=default',
      headers: {
        authorization: 'Bearer user-jwt',
        'content-type': 'application/json',
        connection: 'keep-alive',
        host: 'relay.example.com',
        'x-hermes-profile': 'default',
      },
      body: { message: 'hello' },
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8648/api/hermes/sessions?profile=default', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    }))
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(Array.from((init.headers as Headers).entries())).toEqual([
      ['authorization', 'Bearer user-jwt'],
      ['content-type', 'application/json'],
      ['x-hermes-profile', 'default'],
    ])
    expect(response).toEqual({
      id: 'req-1',
      status: 202,
      headers: {
        'content-type': 'application/json',
        'x-result': 'accepted',
      },
      body: '{"ok":true}',
      truncated: false,
    })
  })

  it('forwards non-v1 local paths through the relay', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ users: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { OutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')
    const client = new OutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      relayToken: '',
      instanceId: '',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const response = await client.handleHttpRequest({
      id: 'req-2',
      method: 'GET',
      path: '/api/auth/users',
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8648/api/auth/users', expect.objectContaining({
      method: 'GET',
    }))
    expect(response).toEqual({
      id: 'req-2',
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"users":[]}',
      truncated: false,
    })
  })

  it('rejects /v1 paths without calling local fetch', async () => {
    const fetchImpl = vi.fn()
    const { OutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')
    const client = new OutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      relayToken: '',
      instanceId: '',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const response = await client.handleHttpRequest({
      id: 'req-3',
      method: 'GET',
      path: '/v1/runs',
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(response).toEqual({
      id: 'req-3',
      status: 403,
      error: {
        code: 'path_not_allowed',
        message: 'Relay request path is not allowed',
      },
    })
  })

  it('opens a local /chat-run socket and relays chat events both ways', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')
    const client = startOutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    expect(client).not.toBeNull()

    const openAck = vi.fn()
    socketHandlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
      auth: { token: 'user-jwt' },
      query: { profile: 'default' },
    }, openAck)

    const localSocket = sockets[1]
    expect(mockIo).toHaveBeenCalledWith('http://127.0.0.1:8648/chat-run', expect.objectContaining({
      auth: { token: 'user-jwt' },
      query: { profile: 'default' },
      transports: ['websocket', 'polling'],
    }))
    expect(openAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', stream: true })

    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'hello' })
    expect(mockSocket.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 's1', delta: 'hello' },
    })

    const eventAck = vi.fn()
    socketHandlers.get('socket.event')?.({
      id: 'chat-1',
      event: 'run',
      payload: { session_id: 's1', input: 'hi' },
    }, eventAck)
    expect(localSocket.emit).toHaveBeenCalledWith('run', { session_id: 's1', input: 'hi' })
    expect(eventAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', event: 'run', stream: true })
  })

  it('supports non-streaming chat-run mode by suppressing deltas and returning final output', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')
    startOutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    const openAck = vi.fn()
    socketHandlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
      stream: false,
    }, openAck)
    expect(openAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', stream: false })

    const localSocket = sockets[1]
    const eventAck = vi.fn()
    socketHandlers.get('socket.event')?.({
      id: 'chat-1',
      event: 'run',
      stream: false,
      payload: { session_id: 's1', input: 'hi' },
    }, eventAck)
    expect(eventAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', event: 'run', stream: false })

    mockSocket.emit.mockClear()
    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'Hello ' })
    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'world' })
    localSocket.__handlers.get('reasoning.delta')?.({ session_id: 's1', delta: 'thinking' })
    expect(mockSocket.emit).not.toHaveBeenCalled()

    localSocket.__handlers.get('run.completed')?.({ session_id: 's1', run_id: 'run-1' })
    expect(mockSocket.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'run.completed',
      payload: {
        session_id: 's1',
        run_id: 'run-1',
        output: 'Hello world',
        reasoning: 'thinking',
      },
    })
  })

  it('rejects socket namespaces and events outside the chat-run allowlist', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')
    startOutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    const openAck = vi.fn()
    socketHandlers.get('socket.open')?.({ id: 'room-1', namespace: '/group-chat' }, openAck)
    expect(openAck).toHaveBeenCalledWith({
      id: 'room-1',
      ok: false,
      error: {
        code: 'namespace_not_allowed',
        message: 'Relay socket namespace is not allowed',
      },
    })

    const eventAck = vi.fn()
    socketHandlers.get('socket.event')?.({ id: 'chat-1', event: 'not.allowed', payload: {} }, eventAck)
    expect(eventAck).toHaveBeenCalledWith({
      id: 'chat-1',
      ok: false,
      error: {
        code: 'event_not_allowed',
        message: 'Relay socket event is not allowed',
      },
    })
  })

  it('manages multiple active relay clients by connection id', async () => {
    const {
      getOutboundRelayClient,
      getOutboundRelayClients,
      startOutboundRelayClient,
      stopOutboundRelayClient,
    } = await import('../../packages/server/src/services/global-agent/outbound-relay-client')

    const first = startOutboundRelayClient({
      connectionId: 'primary',
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const second = startOutboundRelayClient({
      connectionId: 'backup',
      relayUrl: 'https://other-relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const duplicate = startOutboundRelayClient({
      connectionId: 'primary',
      relayUrl: 'https://duplicate.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    expect(first).not.toBeNull()
    expect(second).not.toBe(first)
    expect(duplicate).toBe(first)
    expect(getOutboundRelayClient()).toBe(first)
    expect(getOutboundRelayClient('primary')).toBe(first)
    expect(getOutboundRelayClient('backup')).toBe(second)
    expect(getOutboundRelayClients().size).toBe(2)
    expect(mockIo).toHaveBeenCalledTimes(2)

    stopOutboundRelayClient('primary')

    expect(mockSocket.disconnect).toHaveBeenCalledTimes(1)
    expect(getOutboundRelayClient('primary')).toBeNull()
    expect(getOutboundRelayClient('backup')).toBe(second)

    stopOutboundRelayClient()

    expect(sockets[1].disconnect).toHaveBeenCalledTimes(1)
    expect(getOutboundRelayClients().size).toBe(0)
  })
})
