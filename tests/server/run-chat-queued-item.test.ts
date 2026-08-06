import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
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
  interrupt: vi.fn(),
  approvalRespond: vi.fn(),
  close: vi.fn(),
}))
const sessionStoreMocks = vi.hoisted(() => ({
  clearSessionMessages: vi.fn(),
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default', source: 'cli' })),
}))
const userCanAccessProfileMock = vi.hoisted(() => vi.fn(() => true))
const invocationStoreMocks = vi.hoisted(() => {
  const records = new Map<string, any>()
  return {
    records,
    create: vi.fn((input: any) => {
      const record = {
        id: input.id,
        session_id: input.sessionId,
        run_id: '',
        status: 'running',
        output: null,
        reasoning: null,
        error: null,
        action: null,
        started_at: input.startedAt || 1,
        finished_at: null,
      }
      records.set(input.id, record)
      return record
    }),
    get: vi.fn((id: string) => records.get(id) || null),
    markAction: vi.fn((id: string, action: any) => {
      const record = records.get(id)
      if (!record || record.status !== 'running') return false
      Object.assign(record, { status: 'requires_action', action })
      return true
    }),
    settle: vi.fn((id: string, terminal: any) => {
      const record = records.get(id)
      if (!record || !['running', 'requires_action'].includes(record.status)) return false
      Object.assign(record, {
        run_id: terminal.runId || '',
        status: terminal.status,
        output: terminal.output ?? null,
        reasoning: terminal.reasoning ?? null,
        error: terminal.error ?? null,
        action: null,
        finished_at: terminal.finishedAt || 2,
      })
      return true
    }),
  }
})

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/load-state', () => ({
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
  clearSessionMessages: sessionStoreMocks.clearSessionMessages,
  deleteSession: vi.fn(),
  getSession: sessionStoreMocks.getSession,
  getSessionMetadata: vi.fn(() => ({ id: 'session-1', profile: 'default', source: 'cli' })),
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/db/hermes/chat-run-invocation-store', () => ({
  createChatRunInvocation: invocationStoreMocks.create,
  getChatRunInvocation: invocationStoreMocks.get,
  markChatRunInvocationRequiresAction: invocationStoreMocks.markAction,
  settleChatRunInvocation: invocationStoreMocks.settle,
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
  userCanAccessProfile: userCanAccessProfileMock,
}))

function makeServerHarness() {
  const handlers = new Map<string, Function>()
  const sockets = new Map<string, any>()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    sockets,
    emit: vi.fn(),
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
    invocationStoreMocks.records.clear()
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    bridgeMock.interrupt.mockResolvedValue({ ok: true })
    bridgeMock.approvalRespond.mockResolvedValue({ resolved: true })
    sessionStoreMocks.getSession.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli' })
    userCanAccessProfileMock.mockReturnValue(true)
    sessionStoreMocks.clearSessionMessages.mockReturnValue(2)
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

  it('persists requires_action while detaching the HTTP-style attachment', async () => {
    handleBridgeRunMock.mockImplementationOnce((async (...args: any[]) => {
      const data = args[2]
      data.onEvent?.('approval.requested', {
        run_id: 'run-action', approval_id: 'approval-1', choices: ['once', 'deny'],
      })
    }) as any)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1', input: 'needs approval', source: 'workflow',
    }, { profile: 'default', detachOnAction: true })

    expect(result).toMatchObject({
      ok: false, event: 'action.required', action: { event: 'approval.requested', approval_id: 'approval-1' },
    })
    expect([...invocationStoreMocks.records.values()]).toEqual([
      expect.objectContaining({ status: 'requires_action', action: expect.objectContaining({ approval_id: 'approval-1' }) }),
    ])
    expect((server as any).activeRunInvocations.has('session-1')).toBe(true)
  })

  it('rejects a requested profile that differs from the persisted session profile', async () => {
    sessionStoreMocks.getSession.mockReturnValue({ id: 'session-1', profile: 'private', source: 'cli' })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    await expect(server.runAndWait({
      session_id: 'session-1', input: 'cross-profile attempt', source: 'workflow',
    }, { profile: 'default' })).rejects.toThrow('does not match persisted session profile')
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
  })

  it('enforces user access to the persisted session profile', async () => {
    sessionStoreMocks.getSession.mockReturnValue({ id: 'session-1', profile: 'private', source: 'cli' })
    userCanAccessProfileMock.mockReturnValueOnce(false)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    await expect(server.runAndWait({
      session_id: 'session-1', input: 'unauthorized attempt', source: 'workflow',
    }, { user: { id: 'user-1', role: 'user' } as any })).rejects.toThrow('is not available for this user')
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
  })

  it('supports bridge peer broadcasts during runAndWait workflow runs', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, socket, data) => {
      socket.to(`session:${data.session_id}`).emit('run.peer_user_message', {
        event: 'run.peer_user_message',
        session_id: data.session_id,
      })
      data.onEvent?.('run.completed', {
        run_id: 'run-workflow-1',
        output: 'done',
      })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, namespace } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'workflow node',
      source: 'workflow',
      session_source: 'workflow',
    }, { profile: 'default' })

    expect(result).toMatchObject({
      ok: true,
      run_id: 'run-workflow-1',
      output: 'done',
    })
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
  })

  it('notifies an optional runAndWait observer without changing accumulated output', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent?.('reasoning.delta', { delta: 'thought' })
      data.onEvent?.('message.delta', { delta: 'answer' })
      data.onEvent?.('run.completed', { run_id: 'run-observed', output: 'answer' })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const onEvent = vi.fn()

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'observed workflow node',
      source: 'workflow',
      session_source: 'workflow',
    }, { profile: 'default', onEvent })

    expect(onEvent.mock.calls.map(call => call[0])).toEqual([
      'reasoning.delta',
      'message.delta',
      'run.completed',
    ])
    expect(result).toMatchObject({
      ok: true,
      run_id: 'run-observed',
      output: 'answer',
      reasoning: 'thought',
    })
  })

  it('auto-responds once to approvals only when runAndWait enables it', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent?.('approval.requested', {
        run_id: 'run-workflow-approval',
        approval_id: 'approval-1',
        choices: ['once', 'session', 'deny'],
      })
      data.onEvent?.('run.completed', {
        run_id: 'run-workflow-approval',
        output: 'approved',
      })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, namespace } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'workflow node',
      source: 'workflow',
      session_source: 'workflow',
    }, { profile: 'default', approvalChoice: 'once' })

    expect(result).toMatchObject({
      ok: true,
      run_id: 'run-workflow-approval',
      output: 'approved',
    })
    expect(bridgeMock.approvalRespond).toHaveBeenCalledWith('approval-1', 'once')
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
  })

  it.each([
    ['missing approval id', { choices: ['once'] }, 'approval required'],
    ['unavailable approval choice', { approval_id: 'approval-1', choices: ['deny'] }, 'is not available'],
  ])('durably fails and releases the invocation for %s', async (_name, approval, errorText) => {
    handleBridgeRunMock.mockImplementationOnce((async (_nsp: any, _socket: any, data: any) => {
      data.onEvent?.('approval.requested', { run_id: 'run-approval-error', ...approval })
    }) as any)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1', input: 'workflow node', source: 'workflow', session_source: 'workflow',
    }, { profile: 'default', approvalChoice: 'once' })

    expect(result).toMatchObject({ ok: false, event: 'run.failed' })
    expect(result.error).toContain(errorText)
    expect([...invocationStoreMocks.records.values()]).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.stringContaining(errorText) }),
    ])
    expect((server as any).activeRunInvocations.has('session-1')).toBe(false)
    await vi.waitFor(() => expect(bridgeMock.interrupt).toHaveBeenCalled())
  })

  it('durably fails and releases the invocation when the approval bridge rejects', async () => {
    bridgeMock.approvalRespond.mockRejectedValueOnce(new Error('approval bridge unavailable'))
    handleBridgeRunMock.mockImplementationOnce((async (_nsp: any, _socket: any, data: any) => {
      data.onEvent?.('approval.requested', {
        run_id: 'run-approval-reject', approval_id: 'approval-1', choices: ['once'],
      })
    }) as any)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1', input: 'workflow node', source: 'workflow', session_source: 'workflow',
    }, { profile: 'default', approvalChoice: 'once' })

    expect(result).toMatchObject({ ok: false, event: 'run.failed', error: 'approval bridge unavailable' })
    expect([...invocationStoreMocks.records.values()]).toEqual([
      expect.objectContaining({ status: 'failed', error: 'approval bridge unavailable' }),
    ])
    expect((server as any).activeRunInvocations.has('session-1')).toBe(false)
    await vi.waitFor(() => expect(bridgeMock.interrupt).toHaveBeenCalled())
  })

  it('does not auto-respond to approvals for normal runAndWait calls', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent?.('approval.requested', {
        run_id: 'run-normal-approval',
        approval_id: 'approval-normal',
        choices: ['once', 'session', 'deny'],
      })
      data.onEvent?.('run.completed', {
        run_id: 'run-normal-approval',
        output: 'manual approval path',
      })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'normal node',
      source: 'cli',
    }, { profile: 'default' })

    expect(result.ok).toBe(true)
    expect(bridgeMock.approvalRespond).not.toHaveBeenCalled()
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

  it('clears chat-run memory state when an external MCU clear removes history', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, namespace } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const abortController = new AbortController()
    ;(server as any).sessionMap.set('session-1', {
      messages: [
        { id: 1, session_id: 'session-1', role: 'user', content: 'old', timestamp: 1 },
      ],
      messageTotal: 1,
      messageLoadedCount: 1,
      messagePageLimit: 50,
      hasMoreBefore: false,
      isWorking: true,
      isAborting: false,
      events: [{ event: 'message.delta', data: { session_id: 'session-1', delta: 'old' } }],
      queue: [{
        queue_id: 'q1',
        input: 'next',
        profile: 'default',
      }],
      abortController,
      runId: 'run-1',
      activeRunMarker: 'marker-1',
      profile: 'default',
      source: 'global_agent',
      inputTokens: 10,
      outputTokens: 5,
      contextTokens: 15,
      bridgePendingAssistantContent: 'old',
      bridgeOutput: 'old',
    })
    const abortSpy = vi.spyOn(abortController, 'abort')

    const result = server.clearSessionHistory('session-1')

    expect(result).toEqual({ deleted: 2, hadMemoryState: true })
    expect(sessionStoreMocks.clearSessionMessages).toHaveBeenCalledWith('session-1')
    expect(abortSpy).toHaveBeenCalled()
    expect(bridgeMock.interrupt).toHaveBeenCalledWith('session-1', 'Session cleared', 'default')
    expect((server as any).sessionMap.has('session-1')).toBe(false)
    expect(namespace.emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      event: 'session.command',
      session_id: 'session-1',
      action: 'clear',
      clearHistory: true,
      deleted: 2,
    }))
    expect(namespace.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      messages: [],
      messageTotal: 0,
      isWorking: false,
      queueLength: 0,
    }))
  })
  it('detaches without aborting the underlying runner when runAndWait reaches its timeout', async () => {
    vi.useFakeTimers()
    handleBridgeRunMock.mockImplementationOnce(async () => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const abortSpy = vi.spyOn(server, 'abortSession').mockResolvedValue(undefined)
    try {
      const resultPromise = server.runAndWait({
        session_id: 'session-1', input: 'slow workflow node', source: 'workflow', session_source: 'workflow',
      }, { profile: 'default', attachmentTimeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      await expect(resultPromise).resolves.toMatchObject({ ok: false, error: 'chat-run attachment timed out after 25ms' })
      expect(abortSpy).not.toHaveBeenCalled()
      expect([...invocationStoreMocks.records.values()]).toEqual([
        expect.objectContaining({ status: 'running', finished_at: null }),
      ])
    } finally { vi.useRealTimers() }
  })

  it('keeps the execution deadline active after the attachment detaches', async () => {
    vi.useFakeTimers()
    handleBridgeRunMock.mockImplementationOnce(async () => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const abortSpy = vi.spyOn(server, 'abortSession').mockResolvedValue(undefined)
    try {
      const resultPromise = server.runAndWait({
        session_id: 'session-1', input: 'bounded detached run', source: 'workflow',
      }, { profile: 'default', attachmentTimeoutMs: 25, timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(25)
      await expect(resultPromise).resolves.toMatchObject({ event: 'wait.timed_out' })
      expect(abortSpy).not.toHaveBeenCalled()
      expect((server as any).runExecutionTimers.size).toBe(1)

      await vi.advanceTimersByTimeAsync(25)
      expect(abortSpy).toHaveBeenCalledWith('session-1', 'chat-run timed out after 50ms')
      expect((server as any).runExecutionTimers.size).toBe(0)
      expect([...invocationStoreMocks.records.values()]).toEqual([
        expect.objectContaining({ status: 'failed', error: 'chat-run timed out after 50ms' }),
      ])
    } finally { vi.useRealTimers() }
  })

  it('aborts the underlying runner when the execution deadline expires', async () => {
    vi.useFakeTimers()
    handleBridgeRunMock.mockImplementationOnce(async () => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const abortSpy = vi.spyOn(server, 'abortSession').mockResolvedValue(undefined)
    try {
      const resultPromise = server.runAndWait({
        session_id: 'session-1', input: 'bounded workflow node', source: 'workflow', session_source: 'workflow',
      }, { profile: 'default', timeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      await expect(resultPromise).resolves.toMatchObject({ ok: false, event: 'run.failed', error: 'chat-run timed out after 25ms' })
      expect(abortSpy).toHaveBeenCalledWith('session-1', 'chat-run timed out after 25ms')
      expect([...invocationStoreMocks.records.values()]).toEqual([
        expect.objectContaining({ status: 'failed', error: 'chat-run timed out after 25ms' }),
      ])
    } finally { vi.useRealTimers() }
  })

  it('reconciles a missed terminal notification from the durable invocation record', async () => {
    vi.useFakeTimers()
    handleBridgeRunMock.mockImplementationOnce(async () => {})
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    try {
      const resultPromise = server.runAndWait({
        session_id: 'session-1', input: 'durable workflow node', source: 'workflow', session_source: 'workflow',
      }, { profile: 'default', timeoutMs: 5000 })
      const invocation = [...invocationStoreMocks.records.values()][0]
      Object.assign(invocation, {
        status: 'completed', run_id: 'run-durable', output: 'durable result', reasoning: 'checked', finished_at: 2,
      })
      await vi.advanceTimersByTimeAsync(1000)
      await expect(resultPromise).resolves.toMatchObject({
        ok: true, run_id: 'run-durable', output: 'durable result', reasoning: 'checked',
      })
    } finally { vi.useRealTimers() }
  })

  it('persists a late external terminal event after the caller detached', async () => {
    vi.useFakeTimers()
    handleCodingAgentRunMock.mockImplementationOnce(async () => {})
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    try {
      const resultPromise = server.runAndWait({
        session_id: 'session-1', input: 'slow coding turn', source: 'coding_agent', coding_agent_id: 'codex',
      }, { profile: 'default', attachmentTimeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      await expect(resultPromise).resolves.toMatchObject({ event: 'wait.timed_out' })

      const invocation = [...invocationStoreMocks.records.values()][0]
      server.emitExternalEvent('session-1', 'run.completed', {
        invocation_id: invocation.id,
        run_id: 'run-late', output: 'late durable result', reasoning: 'finished',
      })

      expect([...invocationStoreMocks.records.values()]).toEqual([
        expect.objectContaining({
          status: 'completed', run_id: 'run-late', output: 'late durable result', reasoning: 'finished',
        }),
      ])
    } finally { vi.useRealTimers() }
  })

  it('ignores a stale coding-agent terminal event from another invocation', async () => {
    vi.useFakeTimers()
    handleCodingAgentRunMock.mockImplementationOnce(async () => {})
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    try {
      const resultPromise = server.runAndWait({
        session_id: 'session-1', input: 'current coding turn', source: 'coding_agent', coding_agent_id: 'codex',
      }, { profile: 'default', attachmentTimeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      await expect(resultPromise).resolves.toMatchObject({ event: 'wait.timed_out' })

      server.emitExternalEvent('session-1', 'run.completed', {
        invocation_id: 'stale-invocation', run_id: 'stale-run', output: 'wrong result',
      })

      expect([...invocationStoreMocks.records.values()]).toEqual([
        expect.objectContaining({ status: 'running', output: null }),
      ])
      expect((server as any).activeRunInvocations.get('session-1')).toBe([...invocationStoreMocks.records.keys()][0])
    } finally { vi.useRealTimers() }
  })

  it('ignores an untagged stale coding-agent terminal event', async () => {
    handleCodingAgentRunMock.mockImplementationOnce(async () => {})
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    let settled = false
    const resultPromise = server.runAndWait({
      session_id: 'session-1', input: 'current attached turn', source: 'coding_agent', coding_agent_id: 'codex',
    }, { profile: 'default' }).then(result => {
      settled = true
      return result
    })
    const invocationId = [...invocationStoreMocks.records.keys()][0]

    server.emitExternalEvent('session-1', 'run.failed', { error: 'stale untagged failure' })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(invocationStoreMocks.records.get(invocationId)).toMatchObject({ status: 'running' })

    server.emitExternalEvent('session-1', 'run.completed', {
      invocation_id: invocationId, run_id: 'current-run', output: 'correct',
    })
    await expect(resultPromise).resolves.toMatchObject({ ok: true, run_id: 'current-run', output: 'correct' })
  })

  it('does not let a stale terminal event settle the currently attached invocation', async () => {
    handleCodingAgentRunMock.mockImplementationOnce(async () => {})
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    let settled = false
    const resultPromise = server.runAndWait({
      session_id: 'session-1', input: 'current attached turn', source: 'coding_agent', coding_agent_id: 'codex',
    }, { profile: 'default' }).then(result => {
      settled = true
      return result
    })
    const invocationId = [...invocationStoreMocks.records.keys()][0]

    server.emitExternalEvent('session-1', 'run.completed', {
      invocation_id: 'stale-invocation', run_id: 'stale-run', output: 'wrong',
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(invocationStoreMocks.records.get(invocationId)).toMatchObject({ status: 'running' })

    server.emitExternalEvent('session-1', 'run.completed', {
      invocation_id: invocationId, run_id: 'current-run', output: 'correct',
    })
    await expect(resultPromise).resolves.toMatchObject({ ok: true, run_id: 'current-run', output: 'correct' })
  })

  it('rejects a second invocation while the first turn in the session remains active', async () => {
    handleBridgeRunMock.mockImplementationOnce(async () => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    void server.runAndWait({ session_id: 'session-1', input: 'first', source: 'workflow' }, { profile: 'default' })
    await expect(server.runAndWait({
      session_id: 'session-1', input: 'second', source: 'workflow',
    }, { profile: 'default' })).rejects.toThrow('already has an active chat run invocation')
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
  })

  it('settles and disposes an active invocation when its session is disposed', async () => {
    handleBridgeRunMock.mockImplementationOnce(async () => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const resultPromise = server.runAndWait({
      session_id: 'session-1', input: 'pending', source: 'workflow',
    }, { profile: 'default' })

    await server.disposeSession('session-1')

    await expect(resultPromise).resolves.toMatchObject({ ok: false, event: 'run.failed', error: 'Session disposed' })
    expect([...invocationStoreMocks.records.values()]).toEqual([
      expect.objectContaining({ status: 'canceled', error: 'Session disposed' }),
    ])
    expect((server as any).runWaiters.has('session-1')).toBe(false)
    expect((server as any).activeRunInvocations.has('session-1')).toBe(false)
  })

  it('settles attachments and clears waiter state when the server closes', async () => {
    handleBridgeRunMock.mockImplementationOnce(async () => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const resultPromise = server.runAndWait({
      session_id: 'session-1', input: 'pending on close', source: 'workflow',
    }, { profile: 'default' })

    await server.close()

    await expect(resultPromise).resolves.toMatchObject({ ok: false, event: 'run.failed', error: 'Chat run server closed' })
    expect((server as any).runWaiters.size).toBe(0)
    expect((server as any).runAttachmentDisposers.size).toBe(0)
    expect((server as any).activeRunInvocations.size).toBe(0)
  })

})
