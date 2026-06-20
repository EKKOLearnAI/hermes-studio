import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  authenticateUserToken: vi.fn(),
  userCanAccessProfile: vi.fn(),
}))

const clientSocketMocks = vi.hoisted(() => {
  function createLocalSocket(id: string) {
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

  const localSockets: any[] = []
  const clientIo = vi.fn(() => {
    const socket = createLocalSocket(`local-socket-${localSockets.length + 1}`)
    localSockets.push(socket)
    return socket
  })
  const reset = () => {
    localSockets.length = 0
    clientIo.mockClear()
  }

  return {
    clientIo,
    localSockets,
    reset,
  }
})

const chatRunMocks = vi.hoisted(() => ({
  getChatRunServer: vi.fn(),
  clearSessionHistory: vi.fn(),
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: authMocks.authenticateUserToken,
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: authMocks.userCanAccessProfile,
}))

vi.mock('socket.io-client', () => ({
  io: clientSocketMocks.clientIo,
}))

vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: chatRunMocks.getChatRunServer,
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

function createMockSocket(id: string, auth: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const handlers = new Map<string, (...args: any[]) => void>()
  const socket: any = {
    id,
    data: {},
    handshake: { auth, headers },
    broadcast: { emit: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: vi.fn((_event: string, payload: unknown, ack?: (response: unknown) => void) => {
      ack?.({ id: (payload as any)?.id, status: 200, body: '{"ok":true}' })
      return socket
    }),
    disconnect: vi.fn(),
    __handlers: handlers,
  }
  return socket
}

async function waitForMockCalls(mock: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  const startedAt = Date.now()
  while (mock.mock.calls.length < count && Date.now() - startedAt < 1000) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('GlobalAgentServer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    clientSocketMocks.reset()
    chatRunMocks.getChatRunServer.mockReturnValue({
      clearSessionHistory: chatRunMocks.clearSessionHistory,
    })
    chatRunMocks.clearSessionHistory.mockReturnValue({ deleted: 2, hadMemoryState: true })
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

    const deniedAgent = createMockSocket('socket-denied-agent', { token: 'wrong', role: 'hermes-studio' })
    const deniedAgentNext = vi.fn()
    await nsp.__middleware[0](deniedAgent, deniedAgentNext)
    expect(deniedAgentNext.mock.calls[0][0]).toBeInstanceOf(Error)

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

  it('accepts JWT agent clients and handles inbound HTTP and chat-run socket relay requests locally', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { 'content-type': 'application/json', 'x-result': 'accepted' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, {
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    expect(server.getClientIds()).toEqual(['device-1'])

    const httpAck = vi.fn()
    agentSocket.__handlers.get('http.request')?.({
      id: 'req-1',
      method: 'POST',
      path: '/api/hermes/sessions',
      headers: {
        authorization: 'Bearer attacker',
        'content-type': 'application/json',
      },
      body: { title: 'hello' },
    }, httpAck)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8648/api/hermes/sessions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'hello' }),
    }))
    expect(Array.from((fetchImpl.mock.calls[0][1].headers as Headers).entries())).toEqual([
      ['authorization', 'Bearer user-jwt'],
      ['content-type', 'application/json'],
      ['x-hermes-profile', 'research'],
    ])
    expect(httpAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'req-1',
      status: 202,
      body: '{"ok":true}',
    }))

    const openAck = vi.fn()
    agentSocket.__handlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
    }, openAck)

    expect(clientSocketMocks.clientIo).toHaveBeenCalledWith('http://127.0.0.1:8648/chat-run', expect.objectContaining({
      auth: { token: 'user-jwt' },
      query: { profile: 'research' },
      transports: ['websocket', 'polling'],
    }))
    expect(openAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', stream: true })

    const localSocket = clientSocketMocks.localSockets[0]
    const eventAck = vi.fn()
    agentSocket.__handlers.get('socket.event')?.({
      id: 'chat-1',
      event: 'run',
      payload: { session_id: 's1', input: 'hi' },
    }, eventAck)

    expect(localSocket.emit).toHaveBeenCalledWith('run', {
      session_id: 's1',
      input: 'hi',
      profile: 'research',
    })
    expect(eventAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', event: 'run', stream: true })

    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'hello' })
    expect(agentSocket.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 's1', delta: 'hello' },
    })
  })

  it('replaces the previous agent socket for the same instance id', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, { localBaseUrl: 'http://127.0.0.1:8648' })
    server.init()

    const first = createMockSocket('agent-old', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](first, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(first)

    first.__handlers.get('socket.open')?.({ id: 'chat-1', namespace: '/chat-run' }, vi.fn())
    expect(clientSocketMocks.localSockets).toHaveLength(1)

    const second = createMockSocket('agent-new', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](second, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(second)

    expect(first.disconnect).toHaveBeenCalledWith(true)
    expect(clientSocketMocks.localSockets[0].disconnect).toHaveBeenCalled()
    expect(server.getClientIds()).toEqual(['device-1'])
  })

  it('pushes MCU events to the selected agent socket and forwards MCU status events', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    expect(server.emitMcuEvent({
      type: 'audio.enqueue',
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
      url: 'http://127.0.0.1/audio.pcm',
    }, { clientId: 'device-1' })).toBe(true)
    expect(agentSocket.emit).toHaveBeenCalledWith('audio.enqueue', {
      type: 'audio.enqueue',
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
      url: 'http://127.0.0.1/audio.pcm',
    })

    agentSocket.__handlers.get('audio.queued')?.({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
    })
    expect(agentSocket.broadcast.emit).toHaveBeenCalledWith('relay.socket.event', {
      clientId: 'device-1',
      payload: {
        type: 'audio.queued',
        interactionId: 'voice-1',
        segmentId: 'voice-1-tts-1',
      },
    })
  })

  it('keeps MCU voice stream in listening state until the upload is ended', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    agentSocket.__handlers.get('voice.stream.start')?.({
      interactionId: 'voice-1',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    })

    expect(agentSocket.emit).toHaveBeenCalledWith('interaction.status', {
      type: 'interaction.status',
      interactionId: 'voice-1',
      status: 'listening',
    })
    expect(agentSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({
      interactionId: 'voice-1',
      status: 'transcribing',
    }))
  })

  it('returns relative MCU audio URLs for device-side playback', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const audio = await (server as any).synthesizeMcuSpeech('hello', 'user-jwt')
    expect(audio.url).toMatch(/^\/api\/hermes\/mcu\/audio\/[a-f0-9-]+\.pcm$/)
  })

  it('does not force provider PCM output for MCU speech synthesis', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    await (server as any).synthesizeMcuSpeech('hello', 'user-jwt')

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      text: 'hello',
      options: {},
    })
  })

  it('falls back to Edge TTS when active MCU TTS output cannot be converted to PCM', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      if (body.provider === 'edge') {
        return new Response(Buffer.from('edge-pcm'), {
          status: 200,
          headers: { 'Content-Type': 'audio/x-pcm' },
        })
      }
      return new Response(Buffer.from('not-real-mp3'), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      })
    })
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const audio = await (server as any).synthesizeMcuSpeech('hello', 'user-jwt')

    expect(audio.url).toMatch(/^\/api\/hermes\/mcu\/audio\/[a-f0-9-]+\.pcm$/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      provider: 'edge',
      text: 'hello',
      options: {},
    })
  })

  it('falls back to Edge TTS when the active MCU TTS provider fails', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      if (body.provider === 'edge') {
        return new Response(Buffer.from('edge-pcm'), {
          status: 200,
          headers: { 'Content-Type': 'audio/x-pcm' },
        })
      }
      return new Response(JSON.stringify({ error: 'provider down' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const audio = await (server as any).synthesizeMcuSpeech('hello', 'user-jwt')

    expect(audio.url).toMatch(/^\/api\/hermes\/mcu\/audio\/[a-f0-9-]+\.pcm$/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      provider: 'edge',
      text: 'hello',
      options: {},
    })
  })

  it('synthesizes MCU speech at completed assistant-message boundaries', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-1',
      transcript: 'hi',
      clientId: 'device-1',
    })
    const localSocket = clientSocketMocks.localSockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    localSocket.__handlers.get('message.delta')?.({ delta: '好嘞，这就去查。' })
    expect(fetchImpl).not.toHaveBeenCalled()

    localSocket.__handlers.get('tool.started')?.({ tool: 'weather', preview: '厦门天气' })
    await waitForMockCalls(fetchImpl, 1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      text: '好嘞，这就去查。',
    })
    await waitForMockCalls(agentSocket.emit, 3)
    expect(agentSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
      url: expect.stringMatching(/^\/api\/hermes\/mcu\/audio\/[a-f0-9-]+\.pcm$/),
      completionManagedByServer: true,
    }))
    agentSocket.__handlers.get('audio.done')?.({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
    })

    localSocket.__handlers.get('tool.completed')?.({ tool: 'weather' })
    localSocket.__handlers.get('message.delta')?.({ delta: '结果如下：\n| 名称 | 值 |\n' })
    localSocket.__handlers.get('message.delta')?.({ delta: '| --- | --- |\n| foo | 1 |\n请确认。' })
    localSocket.__handlers.get('run.completed')?.({})

    await waitForMockCalls(fetchImpl, 2)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      text: '结果如下： | 名称 | 值 | | --- | --- | | foo | 1 | 请确认。',
    })
    expect(agentSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-2',
      url: expect.stringMatching(/^\/api\/hermes\/mcu\/audio\/[a-f0-9-]+\.pcm$/),
      completionManagedByServer: true,
    }))
  })

  it('auto-approves MCU chat-run approval requests using the same choice order as the client relay', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any, { localBaseUrl: 'http://127.0.0.1:8647' })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-1',
      transcript: '查天气',
      clientId: 'device-1',
    })
    const localSocket = clientSocketMocks.localSockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    localSocket.__handlers.get('approval.requested')?.({
      approval_id: 'approval-1',
      choices: ['once', 'session', 'deny'],
    })

    expect(agentSocket.emit).toHaveBeenCalledWith('tool.started', {
      type: 'tool.started',
      interactionId: 'voice-1',
      tool: 'approval',
      preview: 'session',
    })
    expect(localSocket.emit).toHaveBeenCalledWith('approval.respond', {
      session_id: 'mcu-device-1-research',
      approval_id: 'approval-1',
      choice: 'session',
    })

    localSocket.__handlers.get('approval.resolved')?.({ resolved: true })
    expect(agentSocket.emit).toHaveBeenCalledWith('tool.completed', {
      type: 'tool.completed',
      interactionId: 'voice-1',
      tool: 'approval',
      error: undefined,
    })
    localSocket.__handlers.get('run.failed')?.({ error: 'done' })
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

  it('broadcasts MCU session clears as chat session commands for frontend clients', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', { token: server.getAuthToken(), instanceId: 'device-1' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const frontendSocket = createMockSocket('frontend-socket', { token: 'frontend-jwt', profile: 'research' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](frontendSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(frontendSocket)

    agentSocket.__handlers.get('mcu.session.clear')?.({
      interactionId: 'clear-1',
      profile: 'research',
    })

    expect(chatRunMocks.clearSessionHistory).toHaveBeenCalledWith('mcu-device-1-research')
    expect(agentSocket.emit).toHaveBeenCalledWith('mcu.session.cleared', expect.objectContaining({
      type: 'mcu.session.cleared',
      interactionId: 'clear-1',
      profile: 'research',
      sessionId: 'mcu-device-1-research',
      deleted: 2,
      memoryCleared: true,
    }))
    expect(frontendSocket.emit).toHaveBeenCalledWith('session.command', {
      event: 'session.command',
      session_id: 'mcu-device-1-research',
      command: 'clear',
      action: 'clear',
      clearHistory: true,
      ok: true,
      deleted: 2,
      memoryCleared: true,
    })
  })

  it('does not silently clear only the database when chat-run memory is unavailable', async () => {
    chatRunMocks.getChatRunServer.mockReturnValue(null)
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/services/global-agent/server')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', { token: server.getAuthToken(), instanceId: 'device-1' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    agentSocket.__handlers.get('mcu.session.clear')?.({
      interactionId: 'clear-1',
      profile: 'research',
    })

    expect(chatRunMocks.clearSessionHistory).not.toHaveBeenCalled()
    expect(agentSocket.emit).toHaveBeenCalledWith('mcu.session.cleared', expect.objectContaining({
      type: 'mcu.session.cleared',
      sessionId: 'mcu-device-1-research',
      ok: false,
      error: 'chat_run_server_unavailable',
    }))
  })
})
