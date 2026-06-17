import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleApiRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const sessionCommandMocks = vi.hoisted(() => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))
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

vi.mock('../../packages/server/src/services/hermes/run-chat/session-command', () => sessionCommandMocks)

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
  })),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default', source: 'cli' })),
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
  const sockets = new Map<string, any>()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    sockets,
    to: vi.fn(() => ({ emit: vi.fn() })),
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
  sockets.set(socket.id, socket)
  return { handlers, io, namespace, socket }
}

describe('ChatRunSocket queued bridge runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    loadSessionStateFromDbMock.mockResolvedValue({
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    })
  })

  it('dispatches unknown slash bridge input through the normal bridge run path', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    sessionCommandMocks.parseSessionCommand.mockReturnValueOnce(null)
    sessionCommandMocks.isSessionCommand.mockReturnValueOnce(false)

    await handlers.get('run')?.({
      session_id: 'session-1',
      input: '/terminal pwd',
      source: 'cli',
      queue_id: 'queue-terminal',
      profile: 'default',
    })

    expect(sessionCommandMocks.parseSessionCommand).toHaveBeenCalledWith('/terminal pwd')
    expect(sessionCommandMocks.handleSessionCommand).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: '/terminal pwd',
      source: 'cli',
      queue_id: 'queue-terminal',
    }))
    expect(call[6]).toBe(false)
  })

  it('persists normal queued bridge messages when they are dequeued', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-normal',
      input: 'queued follow-up',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: 'queued follow-up',
      display_input: undefined,
      storage_message: undefined,
      queue_id: 'queue-normal',
    }))
    expect(call[6]).toBe(false)
  })

  it('persists the visible plan command when dequeuing expanded plan command runs', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-plan',
      input: '[IMPORTANT: expanded plan skill prompt]',
      displayInput: '/plan build the feature',
      displayRole: 'command',
      storageMessage: '/plan build the feature',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: '[IMPORTANT: expanded plan skill prompt]',
      display_input: '/plan build the feature',
      display_role: 'command',
      storage_message: '/plan build the feature',
      queue_id: 'queue-plan',
    }))
    expect(call[6]).toBe(false)
  })

  it('queues coding-agent messages while a coding-agent turn is active', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, namespace, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      source: 'coding_agent',
    })

    await handlers.get('run')?.({
      session_id: 'session-1',
      input: 'queued codex follow-up',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      queue_id: 'queue-codex',
      model: 'gpt-5-codex',
      provider: 'openai-codex',
      profile: 'default',
    })

    expect(handleCodingAgentRunMock).not.toHaveBeenCalled()
    expect((server as any).sessionMap.get('session-1').queue).toEqual([
      expect.objectContaining({
        queue_id: 'queue-codex',
        input: 'queued codex follow-up',
        source: 'coding_agent',
        codingAgentId: 'codex',
      }),
    ])
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
  })

  it('dequeues coding-agent messages when an external coding-agent run completes', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [{
        queue_id: 'queue-codex',
        input: 'queued codex follow-up',
        source: 'coding_agent',
        codingAgentId: 'codex',
        model: 'gpt-5-codex',
        provider: 'openai-codex',
        profile: 'default',
        originSocketId: socket.id,
      }],
      source: 'coding_agent',
    })

    ;(server as any).markExternalRunCompleted('session-1', 'run.completed')

    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalled())
    const call = handleCodingAgentRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: 'queued codex follow-up',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      queue_id: 'queue-codex',
    }))
    expect((server as any).sessionMap.get('session-1').queue).toEqual([])
  })

  it('checks bridge resume status without cold-starting the profile worker', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(bridgeMock.status).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
    }))
  })

  it('reattaches a loaded running bridge run during resume', async () => {
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: true,
      running: true,
      current_run_id: 'run-1',
      loaded: true,
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(resumeBridgeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        profile: 'default',
      }),
      expect.any(Map),
      bridgeMock,
      expect.any(Function),
    )
  })
})
