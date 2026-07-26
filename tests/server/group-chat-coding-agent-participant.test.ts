import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runtimeListeners, managerMock, startCodingAgentRunMock, sendCodingAgentRunInputMock, stopCodingAgentRunMock, socket } = vi.hoisted(() => {
  const runtimeListeners = new Map<string, (event: string, payload: any) => void>()
  const managerMock = {
    subscribe: vi.fn((sessionId: string, listener: (event: string, payload: any) => void, _eventToken?: string) => {
      runtimeListeners.set(sessionId, listener)
      return () => runtimeListeners.delete(sessionId)
    }),
    runIdForSession: vi.fn(() => undefined),
    isSessionLaunchCompatible: vi.fn(() => false),
    stop: vi.fn(() => true),
    stopAndWait: vi.fn(async () => true),
    completeWorkspaceDiffForSession: vi.fn(() => null),
  }
  const startCodingAgentRunMock = vi.fn(async (_id: string, input: any) => ({
    agentSessionId: 'runner-1',
    sessionId: input.sessionId,
    pid: 0,
  }))
  const sendCodingAgentRunInputMock = vi.fn(() => ({ runId: 'runner-1' }))
  const stopCodingAgentRunMock = vi.fn(() => ({ stopped: true }))
  const socket: any = {
    id: 'socket-coding-agent',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === 'connect') queueMicrotask(handler)
      return socket
    }),
    emit: vi.fn((event: string, payload: any, ack?: (value: any) => void) => {
      if (event === 'join') ack?.({ roomId: payload.roomId, roomName: 'Room', members: [], messages: [], rooms: [payload.roomId] })
      if (event === 'message') ack?.({ id: payload.id || 'message-1' })
    }),
    disconnect: vi.fn(),
  }
  return { runtimeListeners, managerMock, startCodingAgentRunMock, sendCodingAgentRunInputMock, stopCodingAgentRunMock, socket }
})

vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }))
vi.mock('../../packages/server/src/services/auth', () => ({ getToken: vi.fn(async () => 'test-token') }))
vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({ codingAgentRunManager: managerMock }))
vi.mock('../../packages/server/src/services/coding-agents', () => ({
  startCodingAgentRun: startCodingAgentRunMock,
  sendCodingAgentRunInput: sendCodingAgentRunInputMock,
  stopCodingAgentRun: stopCodingAgentRunMock,
}))
vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: class {
    async chat() { throw new Error('Hermes bridge must not run for a coding-agent participant') }
  },
}))

import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('Group Chat coding-agent participant runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeListeners.clear()
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(false)
  })

  it('runs a Codex participant through the existing coding-agent lifecycle and persists its Room reply', async () => {
    const participant = {
      agentId: 'participant-codex',
      profile: 'default',
      name: 'Codex A',
      description: 'implementation agent',
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      sessionId: 'gc-room-1-participant-codex-0',
      sessionGeneration: 0,
      mode: 'scoped',
      provider: 'openai',
      model: 'gpt-5-codex',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      invited: 1,
    }
    const clients = new AgentClients()
    const updateRoomTotalTokens = vi.fn()
    const updateRoomAgentContinuity = vi.fn()
    const saveWorkspaceDiffMessageForRun = vi.fn(() => ({ message: { id: 'diff-message' }, totalTokens: 42 }))
    clients.setStorage({
      getRoom: vi.fn(() => ({ id: 'room-1', workspace: '/workspace/project' })),
      getRoomAgentByAgentId: vi.fn(() => participant),
      getRoomMembers: vi.fn(() => []),
      getMessagesForContext: vi.fn(() => [{ id: 'human-message-1', timestamp: 1_790_000_000, roomSeq: 27 }]),
      updateRoomTotalTokens,
      updateRoomAgentContinuity,
      saveWorkspaceDiffMessageForRun,
    })
    const client = await clients.createAgent({ ...participant, backgroundDelegationEnabled: false } as any)

    const reply = client.replyToMention('room-1', {
      messageId: 'human-message-1',
      content: '@Codex A implement the API',
      senderName: 'Customer',
      senderId: 'human-1',
      timestamp: 1,
    })

    await vi.waitFor(() => expect(startCodingAgentRunMock).toHaveBeenCalled())
    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: participant.sessionId,
      profile: 'default',
      mode: 'scoped',
      provider: 'openai',
      model: 'gpt-5-codex',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      workspace: '/workspace/project',
    }))
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith(
      participant.sessionId,
      expect.stringContaining('implement the API'),
      expect.any(String),
      [],
      undefined,
      expect.any(String),
    )

    const listener = runtimeListeners.get(participant.sessionId)
    expect(listener).toBeTypeOf('function')
    listener?.('reasoning.delta', { delta: 'Inspecting.' })
    listener?.('tool.started', { tool_call_id: 'call-1', name: 'terminal', arguments: '{"command":"npm test"}' })
    listener?.('tool.completed', { tool_call_id: 'call-1', name: 'terminal', output: 'passed' })
    listener?.('usage.updated', { inputTokens: 10, outputTokens: 5, contextTokens: 25 })
    listener?.('message.delta', { delta: 'Implemented.' })
    listener?.('run.completed', {
      run_id: 'runner-1',
      output: 'Implemented.',
      workspace_run_change: {
        change_id: 'change-1', session_id: participant.sessionId, run_id: 'runner-1', source: 'run',
        workspace: '/workspace/project', started_at: 1, finished_at: 2, files_changed: 0,
        additions: 0, deletions: 0, total_patch_bytes: 0, files: [],
      },
    })
    await reply

    expect(socket.emit).toHaveBeenCalledWith('message_reasoning_delta', expect.objectContaining({
      roomId: 'room-1',
      delta: 'Inspecting.',
      agentSessionId: participant.sessionId,
    }))
    expect(socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      content: 'Implemented.',
      role: 'assistant',
      agentSessionId: participant.sessionId,
    }), expect.any(Function))
    expect(socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      role: 'assistant',
      tool_calls: [expect.objectContaining({ id: 'call-1' })],
    }), expect.any(Function))
    expect(socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1', role: 'tool', tool_call_id: 'call-1', content: 'passed',
    }), expect.any(Function))
    expect(updateRoomTotalTokens).toHaveBeenCalledWith('room-1', 25)
    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1', sessionId: participant.sessionId, runId: 'runner-1', status: 'completed',
    }))
    expect(updateRoomAgentContinuity).toHaveBeenCalledWith('room-1', participant.agentId, {
      lastSeenRoomSeq: 27,
      lastSuccessfulRunId: 'runner-1',
    })
  })

  it('drops all late events after a participant session generation rotates', async () => {
    const participant = {
      agentId: 'participant-codex', profile: 'default', name: 'Codex A', description: '',
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc-room-1-participant-codex-0',
      sessionGeneration: 0, mode: 'scoped', provider: 'openai', model: 'gpt-5-codex',
      apiMode: 'codex_responses', reasoningEffort: 'high', invited: 1,
    }
    let persisted = participant
    const updateRoomTotalTokens = vi.fn()
    const updateRoomAgentContinuity = vi.fn()
    const saveWorkspaceDiffMessageForRun = vi.fn()
    const clients = new AgentClients()
    clients.setStorage({
      getRoom: vi.fn(() => ({ id: 'room-1', workspace: '/workspace/project' })),
      getRoomAgentByAgentId: vi.fn(() => persisted),
      getRoomMembers: vi.fn(() => []),
      getMessagesForContext: vi.fn(() => []),
      updateRoomTotalTokens,
      updateRoomAgentContinuity,
      saveWorkspaceDiffMessageForRun,
    })
    const client = await clients.createAgent({ ...participant, backgroundDelegationEnabled: false } as any)
    const reply = client.replyToMention('room-1', {
      messageId: 'human-message-stale', content: '@Codex A run', senderName: 'Customer', senderId: 'human-1', timestamp: 1,
    })
    await vi.waitFor(() => expect(sendCodingAgentRunInputMock).toHaveBeenCalled())

    const listener = runtimeListeners.get(participant.sessionId)
    await client.interrupt('room-1')
    persisted = {
      ...participant,
      sessionId: 'gc-room-1-participant-codex-1',
      sessionGeneration: 1,
    }
    listener?.('message.delta', { delta: 'stale output' })
    listener?.('usage.updated', { contextTokens: 999 })
    listener?.('tool.started', { tool_call_id: 'stale-tool', name: 'terminal', arguments: '{}' })
    listener?.('run.completed', {
      run_id: 'stale-run',
      output: 'stale output',
      workspace_run_change: { run_id: 'stale-run' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(socket.emit).not.toHaveBeenCalledWith('message_delta', expect.objectContaining({ delta: 'stale output' }))
    expect(updateRoomTotalTokens).not.toHaveBeenCalled()
    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(updateRoomAgentContinuity).not.toHaveBeenCalled()
    await reply
  })

  it('projects canonical Room context into a coding-agent turn with participant attribution', async () => {
    const participant = {
      agentId: 'participant-codex', profile: 'default', name: 'Codex A', description: 'implementation agent',
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc-room-1-participant-codex-0',
      sessionGeneration: 0, mode: 'scoped', provider: 'openai', model: 'gpt-5-codex',
      apiMode: 'codex_responses', reasoningEffort: 'high', invited: 1,
    }
    const contextEngine = {
      buildContext: vi.fn(async () => ({
        conversationHistory: [
          { role: 'user', content: '[Alice]: requirement' },
          { role: 'user', content: '[Claude Review]: concern' },
          { role: 'assistant', content: 'Earlier Codex result' },
        ],
        instructions: 'Room instructions',
        meta: {},
      })),
    }
    const clients = new AgentClients()
    clients.setStorage({
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Product Room', workspace: '' })),
      getRoomAgentByAgentId: vi.fn(() => participant),
      getRoomMembers: vi.fn(() => [{ userId: 'alice', name: 'Alice', description: 'owner' }]),
      getMessagesForContext: vi.fn(() => []),
    })
    clients.setContextEngine(contextEngine)
    const client = await clients.createAgent({ ...participant, backgroundDelegationEnabled: false } as any)

    const reply = client.replyToMention('room-1', {
      messageId: 'human-message-2', content: '@Codex A continue', senderName: 'Alice', senderId: 'alice', timestamp: 2,
    })
    await vi.waitFor(() => expect(sendCodingAgentRunInputMock).toHaveBeenCalled())
    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: participant.sessionId,
      runtimeContext: 'group_chat',
    }))
    expect(contextEngine.buildContext).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1', agentId: participant.agentId, currentMessage: expect.objectContaining({ id: 'human-message-2' }),
    }))
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith(
      participant.sessionId,
      expect.stringContaining('continue'),
      expect.stringContaining('[Claude Review]: concern'),
      [],
      undefined,
      expect.any(String),
    )
    runtimeListeners.get(participant.sessionId)?.('run.completed', { output: 'Done' })
    await reply
  })

  it('fences an interrupted reply while canonical context is still building', async () => {
    const participant = {
      agentId: 'participant-codex', profile: 'default', name: 'Codex A', description: '',
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc-room-1-participant-codex-0',
      sessionGeneration: 0, mode: 'scoped', provider: 'openai', model: 'gpt-5-codex',
      apiMode: 'codex_responses', reasoningEffort: 'high', invited: 1,
    }
    let releaseContext!: (value: any) => void
    const contextEngine = {
      buildContext: vi.fn(() => new Promise(resolve => { releaseContext = resolve })),
    }
    const clients = new AgentClients()
    clients.setStorage({
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Product Room', workspace: '' })),
      getRoomAgentByAgentId: vi.fn(() => participant),
      getRoomMembers: vi.fn(() => []),
      getMessagesForContext: vi.fn(() => []),
    })
    clients.setContextEngine(contextEngine)
    const client = await clients.createAgent({ ...participant, backgroundDelegationEnabled: false } as any)

    const reply = client.replyToMention('room-1', {
      messageId: 'human-message-interrupt', content: '@Codex A continue', senderName: 'Alice', senderId: 'alice', timestamp: 2,
    })
    await vi.waitFor(() => expect(contextEngine.buildContext).toHaveBeenCalled())
    await expect(client.interrupt('room-1')).resolves.toBe(true)
    releaseContext({ conversationHistory: [], instructions: '', meta: {} })
    await reply

    expect(startCodingAgentRunMock).not.toHaveBeenCalled()
    expect(sendCodingAgentRunInputMock).not.toHaveBeenCalled()
  })

  it('interrupts only the persisted coding-agent participant session', async () => {
    const participant = {
      agentId: 'participant-claude',
      profile: 'default',
      name: 'Claude Review',
      description: '',
      runtime: 'coding_agent',
      codingAgentId: 'claude-code',
      sessionId: 'gc-room-1-participant-claude-0',
      sessionGeneration: 0,
      mode: 'scoped',
      provider: 'anthropic',
      model: 'claude-sonnet',
      apiMode: 'anthropic_messages',
      reasoningEffort: 'high',
      invited: 1,
    }
    const clients = new AgentClients()
    const saveWorkspaceDiffMessageForRun = vi.fn()
    managerMock.runIdForSession.mockReturnValue('run-aborted' as any)
    managerMock.completeWorkspaceDiffForSession.mockReturnValue({ run_id: 'run-aborted', files: [] } as any)
    clients.setStorage({
      getRoom: vi.fn(() => ({ id: 'room-1', workspace: '/workspace/project' })),
      getRoomAgentByAgentId: vi.fn(() => participant),
      saveWorkspaceDiffMessageForRun,
    })
    const client = await clients.createAgent({ ...participant, backgroundDelegationEnabled: false } as any)

    await expect(client.interrupt('room-1')).resolves.toBe(true)

    expect(managerMock.stopAndWait).toHaveBeenCalledWith(participant.sessionId, {
      reportClosed: false,
      graceMs: 15_000,
    })
    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1', sessionId: participant.sessionId, runId: 'run-aborted', status: 'aborted',
    }))
  })
})
