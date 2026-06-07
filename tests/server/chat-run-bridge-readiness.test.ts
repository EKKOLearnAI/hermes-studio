import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleApiRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const getRuntimeStateMock = vi.hoisted(() => vi.fn())
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
  getSession: vi.fn((sessionId?: string) => sessionId
    ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
    : undefined),
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
    expect(ensureReadyMock).toHaveBeenCalledWith({ timeoutMs: 1000, connectRetryMs: 0 })
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

  it('redacts configured loopback tcp host:port when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'tcp://127.0.0.1:43123',
      error: 'connect ECONNREFUSED 127.0.0.1:43123',
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

  it('emits run.failed before resumeBridgeRun when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      error: 'bridge offline',
    })
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

    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      events: [],
    }))
    expect(emitted).toContainEqual({
      room: 'session:session-1',
      event: 'run.failed',
      payload: {
        event: 'run.failed',
        session_id: 'session-1',
        error: 'Agent Bridge is not reachable: bridge offline',
      },
    })
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: undefined,
      source: undefined,
      events: [],
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)

    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(resumeBridgeRunMock).toHaveBeenCalledTimes(1)
  })

  it('emits run.failed and clears stale state when bridge status lookup throws during resume', async () => {
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
      event: 'run.failed',
      payload: {
        event: 'run.failed',
        session_id: 'session-1',
        error: 'Agent Bridge is not reachable: connect ECONNREFUSED configured endpoint',
      },
    })
    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      error: 'Agent Bridge is not reachable: connect ECONNREFUSED configured endpoint',
    })
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      isAborting: false,
      events: [],
    }))
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: undefined,
      source: undefined,
      events: [],
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)
  })
})
