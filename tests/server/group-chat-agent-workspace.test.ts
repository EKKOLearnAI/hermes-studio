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
  chat: vi.fn(async (_sessionId: string, _input: unknown, _history: unknown, _instructions: unknown, _profile: unknown, options: any) => {
    order.push('chat')
    return { ok: true, run_id: options?.run_id || 'bridge-run-id', session_id: _sessionId, status: 'running' }
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
    bridgeMock.chat.mockImplementation(async (_sessionId: string, _input: unknown, _history: unknown, _instructions: unknown, _profile: unknown, options: any) => {
      order.push('chat')
      return { ok: true, run_id: options?.run_id || 'bridge-run-id', session_id: _sessionId, status: 'running' }
    })
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
    ;(client as any).__testStorage = storage
    return client as any
  }

  it('omits workspace and requested run_id when the room has no workspace', async () => {
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

  it('starts a checkpoint with a pre-generated run_id before bridge.chat', async () => {
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const options = bridgeMock.chat.mock.calls[0][5]
    expect(options.workspace).toBe('/tmp/workspace')
    expect(options.run_id).toMatch(/^[0-9a-f]{32}$/)
    expect(trackerMock.startWorkspaceRunCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      runId: options.run_id,
      workspace: '/tmp/workspace',
    }))
    expect(order.slice(0, 2)).toEqual(['checkpoint', 'chat'])
  })

  it('discards the checkpoint if the bridge returns a different run_id', async () => {
    bridgeMock.chat.mockImplementationOnce(async () => {
      order.push('chat')
      return { ok: true, run_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', session_id: 'session-1', status: 'running' }
    })
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.discardWorkspaceRunCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      runId: expect.stringMatching(/^[0-9a-f]{32}$/),
    }))
  })

  it('finalizes an aborted workspace diff on interrupt and ignores a later stream finalizer', async () => {
    const client = await createClient('/tmp/workspace')
    const sessionId = 'gc_room-1_default_Worker_seed-1'
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

  it('does not mark workspace diff runs aborted when bridge interrupt fails', async () => {
    bridgeMock.interrupt.mockRejectedValueOnce(new Error('stale session'))
    const client = await createClient('/tmp/workspace')
    const sessionId = 'gc_room-1_default_Worker_seed-1'
    const runId = 'dddddddddddddddddddddddddddddddd'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun

    await expect(client.interrupt('room-1')).rejects.toThrow('stale session')

    expect(state.abortRequested).toBe(false)
    expect(client.workspaceDiffRuns.size).toBe(1)
    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(mockSocket.emit).not.toHaveBeenCalledWith('context_status', expect.objectContaining({ roomId: 'room-1', status: 'ready' }))
  })

  it('defers aborted workspace diff finalization when bridge interrupt is not synced yet', async () => {
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    const client = await createClient('/tmp/workspace')
    const sessionId = 'gc_room-1_default_Worker_seed-1'
    const runId = 'cccccccccccccccccccccccccccccccc'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })

    await client.interrupt('room-1')

    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).not.toHaveBeenCalled()
    expect(client.workspaceDiffRuns.size).toBe(1)

    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any).mockReturnValueOnce(workspaceDraft(runId, sessionId))
    await client.finalizeWorkspaceDiffOnce(state, 'failed', 'terminal-message-id')

    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({ runId, status: 'aborted' })
  })

  it('discards workspace diff finalization when the room session generation changed', async () => {
    const client = await createClient('/tmp/workspace')
    const staleSessionId = 'gc_room-1_default_Worker_old-seed'
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

    expect(client.__testStorage.saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ role: 'assistant' }), expect.any(Function))
    expect(trackerMock.discardWorkspaceRunCheckpoint).toHaveBeenCalled()
  })

  it('cleans up no-change workspace runs and keeps overlapping runs isolated', async () => {
    const client = await createClient('/tmp/workspace')
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    const runA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const runB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const sessionId = 'gc_room-1_default_Worker_seed-1'
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
