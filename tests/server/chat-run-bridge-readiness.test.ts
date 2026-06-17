import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleApiRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const getRuntimeStateMock = vi.hoisted(() => vi.fn())
const getSessionMock = vi.hoisted(() => vi.fn((sessionId?: string) => sessionId
  ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
  : undefined))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-api-run', () => ({
  handleApiRun: handleApiRunMock,
  loadSessionStateFromDb: loadSessionStateFromDbMock,
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run', () => ({
  handleCodingAgentRun: handleCodingAgentRunMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/session-command', () => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

function makeServerHarness() {
  const handlers = new Map<string, Function>()
  const emitted: Array<{ room: string; event: string; payload: any }> = []
  const namespace = {
    adapter: { rooms: new Map() },
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })),
    })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = { of: vi.fn(() => namespace) }
  const socket = {
    id: 'socket-1',
    connected: true,
    handshake: { auth: {}, query: { profile: 'default' } },
    data: {},
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
  }
  return { emitted, handlers, io, namespace, socket }
}

describe('ensureBridgeReadyForChatRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureReadyMock.mockReset()
    getRuntimeStateMock.mockReset()
    bridgeMock.status.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    handleBridgeRunMock.mockReset()
    resumeBridgeRunMock.mockReset()
    handleApiRunMock.mockReset()
    handleCodingAgentRunMock.mockReset()
    loadSessionStateFromDbMock.mockReset()
    getSessionMock.mockReset()
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
      : undefined)
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
  })

  it('allows reachable bridge readiness', async () => {
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/services/hermes/run-chat')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({ ok: true })
    expect(ensureReadyMock).toHaveBeenCalledWith({ timeoutMs: 1000, connectRetryMs: 0, recover: false })
  })

  it('returns a visible error when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      error: 'connect ECONNREFUSED ipc:///tmp/hermes-agent-bridge.sock',
    })
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/services/hermes/run-chat')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({
      ok: false,
      error: 'connect ECONNREFUSED configured endpoint',
    })
  })

  it('redacts configured tcp host:port when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'tcp://example.internal:43123',
      error: 'connect ECONNREFUSED example.internal:43123',
    })
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/services/hermes/run-chat')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({
      ok: false,
      error: 'connect ECONNREFUSED configured endpoint',
    })
  })

  it('handles thrown ensureReady failures', async () => {
    ensureReadyMock.mockRejectedValueOnce(new Error('bridge startup timed out'))
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/services/hermes/run-chat')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({
      ok: false,
      error: 'bridge startup timed out',
    })
  })
})

describe('ChatRunSocket bridge readiness gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureReadyMock.mockReset()
    getRuntimeStateMock.mockReset()
    bridgeMock.status.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    handleBridgeRunMock.mockReset()
    resumeBridgeRunMock.mockReset()
    handleApiRunMock.mockReset()
    handleCodingAgentRunMock.mockReset()
    loadSessionStateFromDbMock.mockReset()
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    loadSessionStateFromDbMock.mockResolvedValue({
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    })
  })

  it('emits run.failed before starting a cli run when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      error: 'bridge offline',
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({ input: 'hello', session_id: 'session-1', source: 'cli' })

    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      error: 'Agent Bridge is not reachable: bridge offline',
    })
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      profile: undefined,
    }))
  })

  it('does not gate runs when resolveRunSource resolves api_server in tests', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({ input: 'hello', session_id: 'session-1', source: 'api_server' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(handleApiRunMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
  })

  it('routes global-agent Hermes runs through the bridge run path while preserving session source', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({
      input: 'hello',
      session_id: 'session-1',
      source: 'cli',
      session_source: 'global_agent',
    })

    expect(ensureReadyMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      source: 'cli',
      session_source: 'global_agent',
    }))
    expect(handleApiRunMock).not.toHaveBeenCalled()
    expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
  })

  it('routes global coding-agent runs through the coding-agent path while preserving session source', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({
      input: 'hello',
      session_id: 'session-1',
      source: 'coding_agent',
      session_source: 'global_agent',
      coding_agent_id: 'codex',
    })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(handleCodingAgentRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        source: 'coding_agent',
        session_source: 'global_agent',
        coding_agent_id: 'codex',
      }),
      'default',
      expect.any(Map),
    )
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(handleApiRunMock).not.toHaveBeenCalled()
  })

  it('continues with remaining queued bridge runs when readiness fails before a dequeued run starts', async () => {
    ensureReadyMock
      .mockResolvedValueOnce({
        reachable: false,
        status: 'unreachable',
        endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
        error: 'bridge offline',
      })
      .mockResolvedValueOnce({
        reachable: true,
        status: 'ready',
        endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [{
        queue_id: 'queue-next',
        input: 'second queued message',
        source: 'cli',
        profile: 'default',
      }],
      profile: 'default',
      source: 'cli',
    })

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-failed',
      input: 'first queued message',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(ensureReadyMock).toHaveBeenCalledTimes(2))
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      input: 'second queued message',
      queue_id: 'queue-next',
    }))
    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      error: 'Agent Bridge is not reachable: bridge offline',
      queue_remaining: 1,
    })
    expect(emitted).toContainEqual({
      room: 'session:session-1',
      event: 'run.queued',
      payload: expect.objectContaining({
        event: 'run.queued',
        session_id: 'session-1',
        queue_length: 0,
        dequeued_queue_id: 'queue-next',
      }),
    })
  })

  it('reattaches a loaded running bridge run without probing manager readiness again', async () => {
    bridgeMock.statusIfLoaded
      .mockResolvedValueOnce({
        ok: true,
        exists: true,
        running: true,
        current_run_id: 'run-1',
        loaded: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        exists: true,
        running: true,
        current_run_id: 'run-1',
        loaded: true,
      })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: true,
    }))
    expect(emitted.some(({ event }) => event === 'run.failed')).toBe(false)
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: true,
      isAborting: false,
      runId: 'run-1',
      activeRunMarker: undefined,
      profile: 'default',
      source: 'cli',
      events: [],
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)
  })

  it('emits a non-terminal reattach warning and preserves stale state when bridge status lookup throws during resume', async () => {
    bridgeMock.statusIfLoaded.mockRejectedValueOnce(new Error('connect ECONNREFUSED ipc:///tmp/hermes-agent-bridge.sock'))
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: true,
      runId: 'stale-run',
      activeRunMarker: 'marker-1',
      profile: 'default',
      source: 'cli',
      events: [{ event: 'run.started', data: { run_id: 'stale-run' } }],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted).toContainEqual({
      room: 'session:session-1',
      event: 'run.reattach_failed',
      payload: {
        event: 'run.reattach_failed',
        session_id: 'session-1',
        error: 'connect ECONNREFUSED configured endpoint',
        message: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
        text: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
      },
    })
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      isAborting: true,
      events: [expect.objectContaining({
        event: 'run.reattach_failed',
        data: expect.objectContaining({
          error: 'connect ECONNREFUSED configured endpoint',
        }),
      })],
    }))
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      isAborting: true,
      runId: 'stale-run',
      activeRunMarker: 'marker-1',
      profile: 'default',
      source: 'cli',
      events: expect.arrayContaining([
        expect.objectContaining({ event: 'run.started' }),
        expect.objectContaining({
          event: 'run.reattach_failed',
          data: expect.objectContaining({
            error: 'connect ECONNREFUSED configured endpoint',
          }),
        }),
      ]),
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)
  })

  it('suppresses transient bridge status timeout warnings while resuming', async () => {
    bridgeMock.statusIfLoaded.mockRejectedValueOnce(new Error('Agent bridge request timed out after 1000ms'))
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'cli',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      events: [],
    }))
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      events: [],
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)
  })

  it('does not query Hermes bridge status when resuming a coding agent session', async () => {
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'coding_agent', model: 'codex', provider: 'codex' }
      : undefined)
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'coding_agent',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(bridgeMock.statusIfLoaded).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      events: [],
    }))
  })

  it('reattaches global-agent bridge runs with the global source preserved', async () => {
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'global_agent', model: 'gpt-test', provider: 'openai' }
      : undefined)
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: true,
      running: true,
      loaded: true,
      current_run_id: 'run-global',
    })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'global_agent',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(resumeBridgeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-global',
        source: 'global_agent',
      }),
      expect.any(Map),
      bridgeMock,
      expect.any(Function),
    )
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: true,
      events: [],
    }))
  })

  it('checks Hermes bridge status when resuming an api server session', async () => {
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'api_server', model: 'gpt-test', provider: 'openai' }
      : undefined)
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: false,
      running: false,
      loaded: false,
    })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'api_server',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      events: [],
    }))
  })
})
