import { beforeEach, describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => [] as string[])
const getModelContextLengthMock = vi.hoisted(() => vi.fn(() => 256_000))

const mockSocket = vi.hoisted(() => ({
  id: 'agent-socket-1',
  connected: true,
  io: { on: vi.fn() },
  on: vi.fn((event: string, handler: (...args: any[]) => void) => {
    if (event === 'connect') queueMicrotask(() => handler())
    return mockSocket
  }),
  emit: vi.fn((event: string, data?: any, ack?: Function) => {
    if (event === 'message' && ack) ack({ id: data?.id || 'msg-id' })
    return mockSocket
  }),
  disconnect: vi.fn(),
}))

const bridgeMock = vi.hoisted(() => ({
  chat: vi.fn(async (...args: any[]) => {
    const sessionId = String(args[0] || '')
    order.push('chat')
    return { ok: true, run_id: 'bridge-run-id', session_id: sessionId, status: 'running' }
  }),
  streamOutput: vi.fn(async function* (runId: string) {
    yield {
      ok: true,
      run_id: runId,
      session_id: 'session-1',
      status: 'complete',
      delta: 'done',
      cursor: 1,
      output: 'done',
      done: true,
      events: [],
      event_cursor: 0,
    }
  }),
  contextEstimate: vi.fn(),
  interrupt: vi.fn(),
  destroy: vi.fn(),
}))

const trackerMock = vi.hoisted(() => ({
  startWorkspaceRunCheckpoint: vi.fn(() => order.push('checkpoint')),
  completeWorkspaceRunCheckpointDraft: vi.fn(() => null),
  discardWorkspaceRunCheckpoint: vi.fn(),
}))

vi.mock('socket.io-client', () => ({ io: vi.fn(() => mockSocket) }))
vi.mock('../../packages/server/src/services/auth', () => ({ getToken: vi.fn(async () => 'test-token') }))
vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ model: { default: 'model-a', provider: 'provider-a' } })),
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ updateUsage: vi.fn() }))
vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: getModelContextLengthMock,
}))
vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => trackerMock)

describe('group chat agent workspace bridge runs', () => {
  beforeEach(() => {
    order.length = 0
    vi.clearAllMocks()
    trackerMock.completeWorkspaceRunCheckpointDraft.mockReset()
    trackerMock.completeWorkspaceRunCheckpointDraft.mockReturnValue(null)
    bridgeMock.chat.mockImplementation(async (...args: any[]) => {
      const sessionId = String(args[0] || '')
      order.push('chat')
      return { ok: true, run_id: 'bridge-run-id', session_id: sessionId, status: 'running' }
    })
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'done',
        cursor: 1,
        output: 'done',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })
    bridgeMock.interrupt.mockResolvedValue(undefined)
    getModelContextLengthMock.mockReturnValue(256_000)
  })

  function workspaceDraft(runId: string, sessionId = 'session-1') {
    return {
      session_id: sessionId,
      run_id: runId,
      workspace: '/tmp/workspace',
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      files: [{
        path: 'file.txt',
        change_type: 'modified',
        additions: 1,
        deletions: 0,
        size_before: 3,
        size_after: 4,
        patch: '+new',
        binary: false,
        truncated: false,
      }],
    }
  }

  const TEST_SESSION_IDENTITY = {
    actorId: 'actor-agent-1',
    roomAuthorizationRevision: 0,
    actorAuthorizationRevision: 0,
    actorContextRevision: 0,
  }

  async function workerSessionId(seed = '11111111111111111111111111111111') {
    const { groupBridgeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    return groupBridgeSessionId('room-1', 'default', 'Worker', seed, TEST_SESSION_IDENTITY)
  }

  it('keeps bridge session ids fixed-length and opaque for long and non-ASCII inputs', async () => {
    const { groupBridgeSessionId, groupBridgeSummarySessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const longAgentName = 'Worker'.repeat(40)

    expect(() => groupBridgeSessionId('room-1', 'default', 'Worker', '0')).toThrow(/cryptographic room seed/i)

    const first = groupBridgeSessionId('room-1', 'default', longAgentName, '11111111111111111111111111111111')
    const second = groupBridgeSessionId('room-1', 'default', longAgentName, '22222222222222222222222222222222')
    const summaryA = groupBridgeSummarySessionId('room-1', 'default', longAgentName, '11111111111111111111111111111111')
    const summaryB = groupBridgeSummarySessionId('room-1', 'default', longAgentName, '11111111111111111111111111111111')
    const roomA = `room-${'a'.repeat(130)}`
    const roomB = `room-${'a'.repeat(129)}b`
    const collidingPrefixA = groupBridgeSessionId(roomA, 'default', longAgentName, '33333333333333333333333333333333')
    const collidingPrefixB = groupBridgeSessionId(roomB, 'default', longAgentName, '33333333333333333333333333333333')

    const nonAsciiA = groupBridgeSessionId('room-1', 'default', '丫鬟', '33333333333333333333333333333333')
    const nonAsciiB = groupBridgeSessionId('room-1', 'default', '书童', '33333333333333333333333333333333')
    const nulBoundaryA = groupBridgeSessionId('room\0profile', 'agent', 'Worker', '33333333333333333333333333333333')
    const nulBoundaryB = groupBridgeSessionId('room', 'profile\0agent', 'Worker', '33333333333333333333333333333333')

    expect(first).toHaveLength(37)
    expect(second).toHaveLength(37)
    expect(summaryA).toHaveLength(37)
    expect(summaryB).toHaveLength(37)
    expect(summaryA).toMatch(/^gc_h_[0-9a-f]{32}$/)
    expect(summaryB).toMatch(/^gc_h_[0-9a-f]{32}$/)
    expect(summaryA).not.toBe(summaryB)
    expect(summaryA).not.toContain('room-1')
    expect(summaryA).not.toContain('default')
    expect(summaryA).not.toContain('Worker')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^gc_h_[0-9a-f]{32}$/)
    expect(second).toMatch(/^gc_h_[0-9a-f]{32}$/)
    expect(first).not.toContain('room-1')
    expect(first).not.toContain('default')
    expect(first).not.toContain('Worker')
    expect(first).not.toContain('11111111111111111111111111111111')
    expect(collidingPrefixA).not.toBe(collidingPrefixB)
    expect(nonAsciiA).not.toBe(nonAsciiB)
    expect(nulBoundaryA).not.toBe(nulBoundaryB)
  })

  it('does not block room-wide interrupts for idle agents with no bridge session', async () => {
    bridgeMock.interrupt.mockRejectedValueOnce(new Error('unknown session'))
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    const storage = {
      getRoom: vi.fn(() => ({ sessionSeed: '11111111111111111111111111111111', workspace: '', authorizationRevision: 0 })),
      findActiveActorByAgentIdentity: vi.fn(() => ({
        id: TEST_SESSION_IDENTITY.actorId,
        authorizationRevision: 0,
        contextRevision: 0,
      })),
      getActorCapabilities: vi.fn(() => ['room.read', 'room.write']),
      registerSessionProfileForActiveAgent: vi.fn(() => true),
    }
    client.setStorage(storage as any)
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))

    const sessionId = await workerSessionId()

    await expect(clients.interruptRoom('room-1')).resolves.toBeUndefined()
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(sessionId, 'Interrupted by group chat user', 'default')
  })

  it('does not block room deletion for an idle coding agent with no managed run', async () => {
    const { codingAgentRunManager } = await import('../../packages/server/src/services/agent-runner/coding-agent-run-manager')
    const stopAndWait = vi.spyOn(codingAgentRunManager, 'stopAndWait').mockResolvedValue(false)
    const runIdForSession = vi.spyOn(codingAgentRunManager, 'runIdForSession').mockReturnValue(undefined)
    const client = await createClient('')
    client.__testStorage.getRoomAgentByAgentId = vi.fn(() => ({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      sessionId: 'gc_room-1_agent-1_0',
    }))

    await expect(client.__testClients.interruptRoom('room-1')).resolves.toBeUndefined()
    expect(stopAndWait).toHaveBeenCalledWith('gc_room-1_agent-1_0', {
      reportClosed: false,
      graceMs: 15_000,
    })

    stopAndWait.mockRestore()
    runIdForSession.mockRestore()
  })

  it('still blocks room deletion when an active coding-agent run fails to stop', async () => {
    const { codingAgentRunManager } = await import('../../packages/server/src/services/agent-runner/coding-agent-run-manager')
    const stopAndWait = vi.spyOn(codingAgentRunManager, 'stopAndWait').mockResolvedValue(false)
    const runIdForSession = vi.spyOn(codingAgentRunManager, 'runIdForSession').mockReturnValue('active-run')
    const client = await createClient('')
    client.__testStorage.getRoomAgentByAgentId = vi.fn(() => ({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      sessionId: 'gc_room-1_agent-1_0',
    }))

    await expect(client.__testClients.interruptRoom('room-1')).rejects.toMatchObject({ status: 409 })
    expect(stopAndWait).toHaveBeenCalled()

    stopAndWait.mockRestore()
    runIdForSession.mockRestore()
  })

  it('does not drain queued mentions while a room interrupt is still pending', async () => {
    let finishStream!: () => void
    let finishInterrupt!: () => void
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      await new Promise<void>(resolve => { finishStream = resolve })
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'done',
        cursor: 1,
        output: 'done',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })
    bridgeMock.interrupt.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishInterrupt = resolve })
      return { ok: true, synced: true }
    })
    const client = await createClient('/tmp/workspace')
    const clients = client.__testClients
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 30; i += 1) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      throw new Error('timed out waiting for condition')
    }

    await clients.processMentions('room-1', {
      content: '@Worker first',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })
    await waitFor(() => bridgeMock.chat.mock.calls.length === 1)
    await clients.processMentions('room-1', {
      content: '@Worker second',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 2,
    })

    const interruptPromise = clients.interruptRoom('room-1')
    await waitFor(() => bridgeMock.interrupt.mock.calls.length === 1)
    finishStream()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(bridgeMock.chat).toHaveBeenCalledTimes(1)
    finishInterrupt()
    await interruptPromise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(bridgeMock.chat).toHaveBeenCalledTimes(1)
  })

  async function createClient(workspace = '') {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any)
    const storage = {
      getRoom: vi.fn(() => ({ sessionSeed: '11111111111111111111111111111111', workspace, authorizationRevision: 0 })),
      findActiveActorByAgentIdentity: vi.fn(() => ({
        id: TEST_SESSION_IDENTITY.actorId,
        authorizationRevision: 0,
        contextRevision: 0,
      })),
      getActorCapabilities: vi.fn(() => ['room.read', 'room.write']),
      getRoomAgentByAgentId: vi.fn(() => ({
        id: 'row-agent-1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Worker',
        runtime: 'hermes', sessionId: 'participant-session-1', sessionGeneration: 0,
      })),
      isHandoffExecutionCurrent: vi.fn(() => true),
      registerSessionProfileForActiveAgent: vi.fn(() => {
        order.push('mapping')
        return true
      }),
      enqueuePendingSessionDelete: vi.fn(),
      saveWorkspaceDiffMessageForRun: vi.fn(),
      updateRoomTotalTokens: vi.fn(),
      updateRoomTotalTokensForHandoff: vi.fn(() => true),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    }
    client.setStorage(storage as any)
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))
    ;(client as any).__testStorage = storage
    ;(client as any).__testClients = clients
    return client as any
  }

  it('atomically persists durable Hermes context tokens with job authority', async () => {
    const client = await createClient('')
    client.__testStorage.getRoomMembers = vi.fn(() => [])
    client.setContextEngine({
      buildContext: vi.fn(async () => ({
        conversationHistory: [],
        instructions: '',
        meta: { contextTokenEstimate: 321 },
      })),
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi', senderName: 'Alice', senderId: 'user-1', timestamp: 1,
      handoffJobId: 'job-token-1', handoffLeaseToken: 'lease-token-1',
      targetSessionId: 'participant-session-1',
    })

    expect(client.__testStorage.updateRoomTotalTokensForHandoff).toHaveBeenCalledWith({
      roomId: 'room-1', totalTokens: 321,
      sourceHandoffJobId: 'job-token-1', sourceHandoffLeaseToken: 'lease-token-1',
      targetAgentId: 'agent-1', targetSessionId: 'participant-session-1',
    })
    expect(client.__testStorage.updateRoomTotalTokens).not.toHaveBeenCalled()
  })

  it('persists durable Hermes workspace evidence before the final message clears its lease', async () => {
    const client = await createClient('/tmp/workspace')
    const events: string[] = []
    trackerMock.completeWorkspaceRunCheckpointDraft.mockReturnValueOnce(workspaceDraft('bridge-run-id', await workerSessionId()))
    client.__testStorage.saveWorkspaceDiffMessageForRun.mockImplementation(() => {
      events.push('workspace')
      return { message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 }
    })
    mockSocket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'message' && data?.handoffFinal) events.push('final')
      if (event === 'message' && ack) ack({ id: data?.id || 'msg-id' })
      return mockSocket
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi', senderName: 'Alice', senderId: 'user-1', timestamp: 1,
      handoffJobId: 'job-workspace-final', handoffLeaseToken: 'lease-workspace-final',
      targetSessionId: 'participant-session-1',
    })

    expect(events).toEqual(['workspace', 'final'])
  })

  it('durably registers the Bridge session before starting the external run', async () => {
    const client = await createClient('')
    const sessionId = await workerSessionId()

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(client.__testStorage.registerSessionProfileForActiveAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        roomId: 'room-1',
        agentId: 'agent-1',
        profileName: 'default',
        agentName: 'Worker',
      }),
    )
    expect(order.slice(0, 2)).toEqual(['mapping', 'chat'])
  })

  it('registers an opaque crash-cleanup lease before summary Bridge use', async () => {
    const client = await createClient('')
    client.__testStorage.getRoomMembers = vi.fn(() => [])
    const { ContextAuthorizationChangedError } = await import('../../packages/server/src/services/hermes/context-engine/compressor')
    let summarySessionId = ''
    client.setContextEngine({
      buildContext: vi.fn(async (input: { summarySessionRegistrar: () => { sessionId: string; authorizationGuard: () => boolean; release: () => void } }) => {
        const lease = input.summarySessionRegistrar()
        summarySessionId = lease.sessionId
        expect(summarySessionId).toMatch(/^gc_h_[0-9a-f]{32}$/)
        expect(summarySessionId).not.toBe(await workerSessionId())
        expect(lease.authorizationGuard()).toBe(true)
        client.__testStorage.getActorCapabilities.mockReturnValue([])
        expect(lease.authorizationGuard()).toBe(false)
        lease.release()
        throw new ContextAuthorizationChangedError()
      }),
    })

    await client.replyToMention('room-1', {
      content: '@Worker private prompt',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(client.__testStorage.registerSessionProfileForActiveAgent).toHaveBeenCalledTimes(2)
    expect(client.__testStorage.registerSessionProfileForActiveAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: summarySessionId,
        roomId: 'room-1',
        agentId: 'agent-1',
        profileName: 'default',
        requireRunCapabilities: true,
        cleanupAfterMs: 600_000,
      }),
    )
    expect(client.__testStorage.enqueuePendingSessionDelete).toHaveBeenCalledWith(summarySessionId, 'default')
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('does not build or send private context when durable registration denies the agent', async () => {
    const client = await createClient('')
    const buildContext = vi.fn()
    const onStatus = vi.fn()
    client.__testStorage.registerSessionProfileForActiveAgent.mockReturnValue(false)
    client.setContextEngine({ buildContext })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    }, onStatus)

    expect(buildContext).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
    expect(mockSocket.emit).not.toHaveBeenCalledWith('typing', expect.anything())
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('does not start private context construction when grants disappear during model resolution', async () => {
    const client = await createClient('')
    const originalProfile = (client as any).profile
    const originalContextEngine = (client as any).contextEngine
    ;(client as any).profile = 'revocation-during-model-resolution'
    const buildContext = vi.fn()
    client.setContextEngine({ buildContext })
    const { readConfigYamlForProfile } = await import('../../packages/server/src/services/config-helpers')
    vi.mocked(readConfigYamlForProfile).mockImplementationOnce(async () => {
      client.__testStorage.getActorCapabilities.mockReturnValue([])
      return { model: { default: 'model-a', provider: 'provider-a' } }
    })

    try {
      await client.replyToMention('room-1', {
        content: '@Worker private prompt',
        senderName: 'Alice',
        senderId: 'user-1',
        timestamp: 1,
      })

      expect(buildContext).not.toHaveBeenCalled()
      expect(bridgeMock.contextEstimate).not.toHaveBeenCalled()
      expect(bridgeMock.chat).not.toHaveBeenCalled()
    } finally {
      client.__testStorage.getActorCapabilities.mockReturnValue(['room.read', 'room.write'])
      ;(client as any).contextEngine = originalContextEngine
      ;(client as any).profile = originalProfile
    }
  })

  it('stops without degrading when the context engine reports an authorization change', async () => {
    const client = await createClient('')
    client.__testStorage.getRoomMembers = vi.fn(() => [])
    const { ContextAuthorizationChangedError } = await import('../../packages/server/src/services/hermes/context-engine/compressor')
    const buildContext = vi.fn(async (input: { authorizationGuard: () => boolean }) => {
      expect(input.authorizationGuard()).toBe(true)
      client.__testStorage.getActorCapabilities.mockReturnValue([])
      expect(input.authorizationGuard()).toBe(false)
      throw new ContextAuthorizationChangedError()
    })
    client.setContextEngine({ buildContext })

    try {
      await client.replyToMention('room-1', {
        content: '@Worker private prompt',
        senderName: 'Alice',
        senderId: 'user-1',
        timestamp: 1,
      })

      expect(buildContext).toHaveBeenCalledOnce()
      expect(bridgeMock.contextEstimate).not.toHaveBeenCalled()
      expect(bridgeMock.chat).not.toHaveBeenCalled()
    } finally {
      client.__testStorage.getActorCapabilities.mockReturnValue(['room.read', 'room.write'])
    }
  })

  it('stops context estimation and Bridge chat when run grants disappear after registration', async () => {
    const client = await createClient('')
    client.__testStorage.getRoomMembers = vi.fn(() => [])
    client.setContextEngine({
      buildContext: vi.fn(async ({ contextTokenEstimator }: { contextTokenEstimator: (history: Array<{ role: 'user' | 'assistant'; content: string }>, instructions: string) => Promise<number | undefined> }) => {
        client.__testStorage.getActorCapabilities.mockReturnValue([])
        await expect(contextTokenEstimator([], '')).resolves.toBeUndefined()
        return { conversationHistory: [], instructions: '', meta: {} }
      }),
    })

    await client.replyToMention('room-1', {
      content: '@Worker private prompt',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(bridgeMock.contextEstimate).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('interrupts an in-flight durable Bridge job when its source authority is revoked', async () => {
    const client = await createClient('')
    let current = true
    client.__testStorage.isHandoffExecutionCurrent.mockImplementation(() => current)
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    bridgeMock.streamOutput.mockImplementationOnce(async function* (runId: string) {
      current = false
      yield {
        ok: true,
        run_id: runId,
        session_id: await workerSessionId(),
        status: 'complete',
        delta: 'must not publish',
        cursor: 1,
        output: 'must not publish',
        done: true,
        events: [{ event: 'tool.started', tool_call_id: 'late-tool', tool_name: 'terminal' }],
        event_cursor: 1,
      }
    })

    await client.replyToMention('room-1', {
      messageId: 'source-message-1', content: '@Worker private prompt', senderName: 'Alice', senderId: 'user-1', timestamp: 1,
      handoffJobId: 'job-1', handoffLeaseToken: 'lease-1', handoffChainId: 'chain-1',
      handoffKind: 'mention', targetSessionId: 'participant-session-1',
    })

    const runtimeSessionId = await workerSessionId()
    expect(client.__testStorage.isHandoffExecutionCurrent).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'agent-1', 'participant-session-1',
    )
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(
      runtimeSessionId,
      'Interrupted because group chat room state changed',
      'default',
    )
    expect(bridgeMock.destroy).toHaveBeenCalledWith(runtimeSessionId, 'default')
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message_stream_delta', expect.objectContaining({ delta: 'must not publish' }))
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ tool_calls: expect.anything() }), expect.any(Function))
  })

  it('interrupts an in-flight Bridge run before relaying output when run grants disappear', async () => {
    const client = await createClient('')
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    bridgeMock.streamOutput.mockImplementationOnce(async function* (runId: string) {
      client.__testStorage.getActorCapabilities.mockReturnValue([])
      yield {
        ok: true,
        run_id: runId,
        session_id: await workerSessionId(),
        status: 'complete',
        delta: 'private result',
        cursor: 1,
        output: 'private result',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })

    await client.replyToMention('room-1', {
      content: '@Worker private prompt',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const sessionId = await workerSessionId()
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(
      sessionId,
      'Interrupted because group chat room state changed',
      'default',
    )
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionId, 'default')
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message_stream_delta', expect.objectContaining({ delta: 'private result' }))
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ content: 'private result' }), expect.any(Function))
  })

  it('omits workspace when the room has no workspace', async () => {
    const client = await createClient('')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({
        background_delegation_enabled: false,
        source: 'group_chat',
      }),
    )
    expect(bridgeMock.chat.mock.calls[0]?.[5]).not.toHaveProperty('workspace')
    expect(bridgeMock.chat.mock.calls[0]?.[5]).not.toHaveProperty('run_id')
  })

  it('cancels a pending reply when interrupt arrives before bridge.chat starts', async () => {
    bridgeMock.interrupt.mockRejectedValueOnce(new Error('unknown session'))
    const client = await createClient('/tmp/workspace')
    client.__testStorage.getRoomMembers = vi.fn(() => [])
    client.setContextEngine({
      buildContext: vi.fn(async () => {
        await client.interrupt('room-1')
        return { conversationHistory: [], instructions: 'ctx', meta: {} }
      }),
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const sessionId = await workerSessionId()
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(sessionId, 'Interrupted by group chat user', 'default')
    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('does not start a bridge workspace run after the room generation changes before launch', async () => {
    const client = await createClient('/tmp/workspace')
    const storage = (client as any).__testStorage
    storage.getRoom
      .mockReturnValueOnce({ sessionSeed: '11111111111111111111111111111111', workspace: '/tmp/workspace' })
      .mockReturnValue({ sessionSeed: '22222222222222222222222222222222', workspace: '/tmp/workspace' })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('does not start a bridge workspace run after the room is deleted before launch', async () => {
    const client = await createClient('/tmp/workspace')
    const storage = (client as any).__testStorage
    storage.getRoom
      .mockReturnValueOnce({ sessionSeed: '0', workspace: '/tmp/workspace' })
      .mockReturnValue(undefined)

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('starts a checkpoint with the bridge-assigned run_id after bridge.chat starts', async () => {
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const options = bridgeMock.chat.mock.calls[0][5]
    expect(options.workspace).toBe('/tmp/workspace')
    expect(options).not.toHaveProperty('run_id')
    expect(trackerMock.startWorkspaceRunCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'bridge-run-id',
      workspace: '/tmp/workspace',
    }))
    expect(order.slice(0, 3)).toEqual(['mapping', 'chat', 'checkpoint'])
  })

  it('uses the bridge-assigned run_id when finalizing the workspace diff', async () => {
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.completeWorkspaceRunCheckpointDraft).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'bridge-run-id',
      workspace: '/tmp/workspace',
    }))
  })

  it('finalizes an aborted workspace diff on interrupt and ignores a later stream finalizer', async () => {
    const client = await createClient('/tmp/workspace')
    const sessionId = await workerSessionId()
    const runId = '0123456789abcdef0123456789abcdef'
    const state = client.beginWorkspaceDiffIfNeeded({
      roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace',
      sourceHandoffJobId: 'job-workspace-1', sourceHandoffLeaseToken: 'lease-workspace-1',
      targetAgentId: 'agent-1', targetSessionId: 'participant-session-1',
    })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any).mockReturnValueOnce(workspaceDraft(runId, sessionId))

    await client.interrupt('room-1')

    expect(bridgeMock.interrupt).toHaveBeenCalledWith(sessionId, 'Interrupted by group chat user', 'default')
    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({
      roomId: 'room-1',
      sessionId,
      runId,
      status: 'aborted',
      parentMessageId: null,
      sourceHandoffJobId: 'job-workspace-1',
      sourceHandoffLeaseToken: 'lease-workspace-1',
    })

    await client.finalizeWorkspaceDiffOnce(state, 'failed', 'late-message-id')

    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).toHaveBeenCalledTimes(1)
  })

  it('does not fail a synced interrupt when best-effort UI status emits cannot use the socket', async () => {
    const client = await createClient('/tmp/workspace')
    mockSocket.connected = false
    const sessionId = await workerSessionId()
    const runId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any).mockReturnValueOnce(workspaceDraft(runId, sessionId))

    try {
      await expect(client.interrupt('room-1')).resolves.toBe(true)
    } finally {
      mockSocket.connected = true
    }

    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({ runId, status: 'aborted' })
  })

  it('does not mark workspace diff runs aborted when bridge interrupt fails', async () => {
    bridgeMock.interrupt.mockRejectedValueOnce(new Error('stale session'))
    const client = await createClient('/tmp/workspace')
    const sessionId = await workerSessionId()
    const runId = 'dddddddddddddddddddddddddddddddd'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun

    await expect(client.interrupt('room-1')).rejects.toThrow('stale session')

    expect(state.abortRequested).toBe(false)
    expect(client.workspaceDiffRuns.size).toBe(1)
    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(mockSocket.emit).not.toHaveBeenCalledWith('context_status', expect.objectContaining({ roomId: 'room-1', status: 'ready' }))
  })

  it('keeps workspace diff finalization pending when bridge interrupt is not synced yet', async () => {
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    const client = await createClient('/tmp/workspace')
    const sessionId = await workerSessionId()
    const runId = 'cccccccccccccccccccccccccccccccc'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })

    await expect(client.interrupt('room-1')).resolves.toBe(false)

    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).not.toHaveBeenCalled()
    expect(client.workspaceDiffRuns.size).toBe(1)
    expect(mockSocket.emit).not.toHaveBeenCalledWith('context_status', expect.objectContaining({ roomId: 'room-1', status: 'ready' }))

    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any).mockReturnValueOnce(workspaceDraft(runId, sessionId))
    await client.finalizeWorkspaceDiffOnce(state, 'failed', 'terminal-message-id')

    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({ runId, status: 'failed' })
  })

  it('discards workspace diff finalization when the room session generation changed', async () => {
    const client = await createClient('/tmp/workspace')
    const staleSessionId = await workerSessionId('44444444444444444444444444444444')
    const runId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId: staleSessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun

    await client.finalizeWorkspaceDiffOnce(state, 'completed', 'late-message-id')

    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).not.toHaveBeenCalled()
    expect(trackerMock.discardWorkspaceRunCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ runId }))
    expect(client.workspaceDiffRuns.size).toBe(0)
  })

  it('drops late assistant output after clear-context rotates the room session generation', async () => {
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    const client = await createClient('/tmp/workspace')
    let sessionSeed = '11111111111111111111111111111111'
    client.__testStorage.getRoom.mockImplementation(() => ({ sessionSeed, workspace: '/tmp/workspace', authorizationRevision: 0 }))
    bridgeMock.streamOutput.mockImplementationOnce(async function* (runId: string) {
      sessionSeed = '22222222222222222222222222222222'
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'late',
        cursor: 1,
        output: 'late',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const sessionId = await workerSessionId()
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(
      sessionId,
      'Interrupted because group chat room state changed',
      'default',
    )
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionId, 'default')
    expect(client.__testStorage.saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message_stream_end', expect.objectContaining({ roomId: 'room-1' }))
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ role: 'assistant' }), expect.any(Function))
    expect(trackerMock.discardWorkspaceRunCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'bridge-run-id',
      sessionId,
    }))
    expect(client.workspaceDiffRuns.size).toBe(0)
  })

  it('cleans up no-change workspace runs and keeps overlapping runs isolated', async () => {
    const client = await createClient('/tmp/workspace')
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    const runA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const runB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const sessionId = await workerSessionId()
    const stateA = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId: runA, workspace: '/tmp/workspace' })
    const stateB = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId: runB, workspace: '/tmp/workspace' })

    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(workspaceDraft(runB, sessionId))

    await client.finalizeWorkspaceDiffOnce(stateA, 'completed', null)
    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(client.workspaceDiffRuns.size).toBe(1)

    await client.finalizeWorkspaceDiffOnce(stateA, 'completed', null)
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).toHaveBeenCalledTimes(1)

    await client.finalizeWorkspaceDiffOnce(stateB, 'failed', null)
    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({ runId: runB, status: 'failed' })
    expect(client.workspaceDiffRuns.size).toBe(0)
  })
})
