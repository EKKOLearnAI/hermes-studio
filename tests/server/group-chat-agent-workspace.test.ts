import { beforeEach, describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => [] as string[])

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
  chat: vi.fn(async (_sessionId: string) => {
    order.push('chat')
    return { ok: true, run_id: 'bridge-run-id', session_id: _sessionId, status: 'running' }
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
    bridgeMock.chat.mockImplementation(async (_sessionId: string) => {
      order.push('chat')
      return { ok: true, run_id: 'bridge-run-id', session_id: _sessionId, status: 'running' }
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

  async function workerSessionId(seed = 'seed-1') {
    const { groupBridgeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    return groupBridgeSessionId('room-1', 'default', 'Worker', seed)
  }

  it('keeps the session key freshness suffix when long names force bridge session id truncation', async () => {
    const { groupBridgeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const longAgentName = 'Worker'.repeat(40)

    const first = groupBridgeSessionId('room-1', 'default', longAgentName, 'seed-1')
    const second = groupBridgeSessionId('room-1', 'default', longAgentName, 'seed-2')
    const roomA = `room-${'a'.repeat(130)}`
    const roomB = `room-${'a'.repeat(129)}b`
    const collidingPrefixA = groupBridgeSessionId(roomA, 'default', longAgentName, '0')
    const collidingPrefixB = groupBridgeSessionId(roomB, 'default', longAgentName, '0')

    const nonAsciiA = groupBridgeSessionId('room-1', 'default', '丫鬟', '0')
    const nonAsciiB = groupBridgeSessionId('room-1', 'default', '书童', '0')

    expect(first).toHaveLength(120)
    expect(second).toHaveLength(120)
    expect(first).not.toBe(second)
    expect(first).toMatch(/_h_[0-9a-f]{16}$/)
    expect(second).toMatch(/_h_[0-9a-f]{16}$/)
    expect(collidingPrefixA).not.toBe(collidingPrefixB)
    expect(nonAsciiA).not.toBe(nonAsciiB)
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
    } as any) as any
    const storage = { getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '' })) }
    client.setStorage(storage as any)
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))

    const sessionId = await workerSessionId()

    await expect(clients.interruptRoom('room-1')).resolves.toBeUndefined()
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(sessionId, 'Interrupted by group chat user', 'default')
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
    } as any)
    const storage = {
      getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace })),
      saveWorkspaceDiffMessageForRun: vi.fn(),
      updateRoomTotalTokens: vi.fn(),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    }
    client.setStorage(storage as any)
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))
    ;(client as any).__testStorage = storage
    ;(client as any).__testClients = clients
    return client as any
  }

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
      expect.not.objectContaining({ workspace: expect.anything(), run_id: expect.anything() }),
    )
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
      .mockReturnValueOnce({ sessionSeed: 'seed-1', workspace: '/tmp/workspace' })
      .mockReturnValue({ sessionSeed: 'seed-2', workspace: '/tmp/workspace' })

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
    expect(order.slice(0, 2)).toEqual(['chat', 'checkpoint'])
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
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
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
    const staleSessionId = await workerSessionId('old-seed')
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
    client.__testStorage.getRoom
      .mockReturnValueOnce({ sessionSeed: 'seed-1', workspace: '/tmp/workspace' })
      .mockReturnValueOnce({ sessionSeed: 'seed-1', workspace: '/tmp/workspace' })
      .mockReturnValue({ sessionSeed: 'seed-2', workspace: '/tmp/workspace' })

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
    expect(trackerMock.discardWorkspaceRunCheckpoint).not.toHaveBeenCalled()
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
