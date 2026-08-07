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
    bridgeMock.destroy.mockResolvedValue(undefined)
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
    const selectedModelA = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low',
    })
    const selectedModelB = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      provider: 'provider-a',
      model: 'model-b',
      reasoningEffort: 'low',
    })

    expect(first).toHaveLength(120)
    expect(second).toHaveLength(120)
    expect(first).not.toBe(second)
    expect(first).toMatch(/_h_[0-9a-f]{16}$/)
    expect(second).toMatch(/_h_[0-9a-f]{16}$/)
    expect(collidingPrefixA).not.toBe(collidingPrefixB)
    expect(nonAsciiA).not.toBe(nonAsciiB)
    expect(selectedModelA).not.toBe(selectedModelB)

    const hermesSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'hermes',
      provider: 'provider-a',
      model: 'model-a',
    })
    const codexSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'codex',
      provider: 'provider-a',
      model: 'model-a',
    })
    const codexResponsesSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'codex',
      provider: 'provider-a',
      model: 'model-a',
      apiMode: 'codex_responses',
    })
    const codexChatSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'codex',
      provider: 'provider-a',
      model: 'model-a',
      apiMode: 'chat_completions',
    })
    const hermesWithIgnoredApiMode = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'hermes',
      provider: 'provider-a',
      model: 'model-a',
      apiMode: 'anthropic_messages',
    })
    expect(hermesSession).not.toBe(codexSession)
    expect(codexResponsesSession).not.toBe(codexChatSession)
    expect(hermesWithIgnoredApiMode).toBe(hermesSession)
  })

  it('generates a complete entry mention DTO for an agent reply handoff', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const author = await clients.createAgent({
      agentId: 'agent-author',
      profile: 'default',
      name: 'Author',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    })
    clients.rooms.set('room-1', new Map([
      ['agent-author', author],
      ['agent-reviewer', { agentId: 'agent-reviewer', name: 'Reviewer' }],
    ]))

    await author.sendMessage('room-1', '@Reviewer please verify this.', 'handoff-1')

    expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      id: 'handoff-1',
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    }), expect.any(Function))
  })

  it('does not generate a structured mention for the replying agent itself', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const author = await clients.createAgent({
      agentId: 'agent-author',
      profile: 'default',
      name: 'Author',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    })
    const replyToMention = vi.fn(async () => {})
    clients.rooms.set('room-1', new Map([
      ['agent-author', author],
      ['agent-reviewer', { agentId: 'agent-reviewer', name: 'Reviewer', replyToMention }],
    ]))

    await author.sendMessage('room-1', '@Author status: waiting for @Reviewer.', 'self-mention-1')

    expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      id: 'self-mention-1',
      content: '@Author status: waiting for @Reviewer.',
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    }), expect.any(Function))
    expect(replyToMention).not.toHaveBeenCalled()
  })

  it('dispatches a Codex group agent through chat-run without invoking the Hermes bridge', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('reasoning.delta', { delta: 'thinking' })
      options.onEvent?.('tool.started', {
        tool_call_id: 'tool-1',
        name: 'list_files',
        arguments: { path: '/tmp' },
      })
      options.onEvent?.('tool.completed', {
        tool_call_id: 'tool-1',
        name: 'list_files',
        output: 'file.txt',
      })
      options.onEvent?.('reasoning.delta', { delta: 'next thought' })
      options.onEvent?.('tool.started', {
        tool_call_id: 'tool-2',
        name: 'read_file',
        arguments: { path: '/tmp/file.txt' },
      })
      options.onEvent?.('tool.failed', {
        tool_call_id: 'tool-2',
        name: 'read_file',
        output: 'permission denied',
        error: 'permission denied',
      })
      options.onEvent?.('message.delta', { delta: 'Codex answer' })
      return { ok: true, output: 'Codex answer', reasoning: 'thinkingnext thought' }
    })
    const chatRunService = {
      runAndWait,
      abortSession: vi.fn(async () => {}),
    }
    const clients = new AgentClients()
    clients.setChatRunService(chatRunService)
    const client = await clients.createAgent({
      agentId: 'agent-codex',
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Coder',
      description: 'Writes code',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ name: 'Engineering Room', sessionSeed: 'seed-1', workspace: '', maxHistoryTokens: 32000 })),
      getRoomMembers: vi.fn(() => [
        { id: 'member-1', userId: 'human-1', name: 'Human', description: 'Product owner' },
      ]),
      getRoomAgents: vi.fn(() => [
        { id: 'room-agent-1', agentId: 'agent-codex', name: 'Coder', description: 'Writes code' },
        { id: 'room-agent-2', agentId: 'agent-reviewer', name: 'Reviewer', description: 'Reviews changes' },
      ]),
      getMessagesForContext: vi.fn(() => [{
        id: 'msg-1',
        roomId: 'room-1',
        senderId: 'human-1',
        senderName: 'Human',
        content: '@Coder implement it',
        timestamp: 1,
        role: 'user',
      }]),
      getContextSnapshot: vi.fn(() => null),
    })

    await client.replyToMention('room-1', {
      messageId: 'msg-1',
      content: '@Coder implement it',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    }, {
      summary: 'Use the shared room architecture.',
      history: [{
        id: 'prior-1',
        timestamp: 0,
        role: 'assistant',
        senderName: 'Reviewer',
        content: 'Keep single chat unchanged.',
      }],
    })

    expect(runAndWait).toHaveBeenCalledWith(expect.objectContaining({
      coding_agent_id: 'codex',
      source: 'workflow',
      session_source: 'workflow',
      mode: 'scoped',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoning_effort: 'high',
      group_room_id: 'room-1',
      group_agent_id: 'agent-codex',
      background_delegation_enabled: false,
      context_compression_enabled: false,
    }), expect.objectContaining({
      profile: 'research',
      onEvent: expect.any(Function),
    }))
    expect(runAndWait.mock.calls[0][1]).not.toHaveProperty('timeoutMs')
    expect(String(runAndWait.mock.calls[0][0].input)).toContain('截至总结锚点的群聊总结')
    expect(String(runAndWait.mock.calls[0][0].input)).toContain('Keep single chat unchanged.')
    expect(runAndWait.mock.calls[0][0].instructions).toContain('你是"Coder"，群聊房间"Engineering Room"中的 AI 助手')
    expect(runAndWait.mock.calls[0][0].instructions).toContain('- Human: Product owner')
    expect(runAndWait.mock.calls[0][0].instructions).toContain('- Reviewer: Reviews changes')
    expect(runAndWait.mock.calls[0][0].group_system_prompt).toBe(runAndWait.mock.calls[0][0].instructions)
    expect(bridgeMock.chat).not.toHaveBeenCalled()
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        content: 'Codex answer',
        reasoning: null,
      }),
      expect.any(Function),
    )
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        role: 'tool',
        tool_call_id: 'tool-2',
        tool_name: 'read_file',
        content: 'permission denied',
        finish_reason: 'error',
      }),
      expect.any(Function),
    )
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        role: 'assistant',
        tool_calls: [expect.objectContaining({
          id: 'tool-1',
          function: expect.objectContaining({ name: 'list_files' }),
        })],
        reasoning: 'thinking',
      }),
      expect.any(Function),
    )
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        role: 'tool',
        tool_call_id: 'tool-1',
        tool_name: 'list_files',
        content: 'file.txt',
      }),
      expect.any(Function),
    )
    const persistedAgentMessages = mockSocket.emit.mock.calls
      .filter(([event, payload]) => event === 'message' && payload?.roomId === 'room-1')
      .map(([, payload]) => payload)
    expect(persistedAgentMessages
      .filter(payload => payload.role === 'assistant' && payload.tool_calls?.length)
      .map(payload => payload.reasoning)).toEqual(['thinking', 'next thought'])
    expect(new Set(persistedAgentMessages.map(payload => payload.run_id)).size).toBe(1)
    expect(persistedAgentMessages.every(payload => /^gcmsg_/.test(payload.run_id))).toBe(true)
    expect(runAndWait.mock.calls[0][0].session_id).toMatch(/^gc_run_/)
  })

  it.each([
    ['ekko', 'ekko-agent'],
    ['claude', 'claude-code'],
  ] as const)('passes the dynamic group system prompt to the %s runtime', async (agent, codingAgentId) => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('message.delta', { delta: 'done' })
      return { ok: true, output: 'done' }
    })
    const clients = new AgentClients()
    clients.setChatRunService({
      runAndWait,
      abortSession: vi.fn(async () => {}),
    })
    const client = await clients.createAgent({
      agentId: `agent-${agent}`,
      agent,
      profile: 'default',
      name: agent === 'ekko' ? 'Ekko' : 'Claude',
      description: `${agent} room role`,
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ name: 'Runtime Room', workspace: '' })),
      getRoomMembers: vi.fn(() => [
        { id: 'member-1', userId: 'human-1', name: 'Human', description: 'Room owner' },
      ]),
      getRoomAgents: vi.fn(() => [
        {
          id: `room-agent-${agent}`,
          agentId: `agent-${agent}`,
          name: agent === 'ekko' ? 'Ekko' : 'Claude',
          description: `${agent} room role`,
        },
      ]),
    })

    await client.replyToMention('room-runtime', {
      messageId: `msg-${agent}`,
      content: `@${agent === 'ekko' ? 'Ekko' : 'Claude'} reply`,
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    const runData = runAndWait.mock.calls[0][0]
    expect(runAndWait.mock.calls[0][1]).not.toHaveProperty('timeoutMs')
    expect(runData.coding_agent_id).toBe(codingAgentId)
    expect(runData.instructions).toContain(`你是"${agent === 'ekko' ? 'Ekko' : 'Claude'}"，群聊房间"Runtime Room"中的 AI 助手`)
    expect(runData.instructions).toContain('- Human: Room owner')
    expect(runData.group_system_prompt).toBe(runData.instructions)
    expect(runData.group_room_id).toBe('room-runtime')
    expect(runData.group_agent_id).toBe(`agent-${agent}`)
  })

  it('finishes a group-only Codex tool card when chat-run has no matching completed event', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('tool.started', {
        tool_call_id: 'call-write-stdin',
        name: 'write_stdin',
        arguments: { session_id: 86404, chars: '', yield_time_ms: 3000 },
      })
      options.onEvent?.('message.delta', { delta: 'Weather answer' })
      return { ok: true, output: 'Weather answer' }
    })
    const clients = new AgentClients()
    clients.setChatRunService({
      runAndWait,
      abortSession: vi.fn(async () => {}),
    })
    const client = await clients.createAgent({
      agentId: 'agent-codex-terminal-tool',
      agent: 'codex',
      profile: 'default',
      name: 'Codex',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '', maxHistoryTokens: 32000 })),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    })

    await client.replyToMention('room-terminal-tool', {
      messageId: 'msg-terminal-tool',
      content: '@Codex check the weather',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    const persistedMessages = mockSocket.emit.mock.calls
      .filter(([event, payload]) => event === 'message' && payload?.roomId === 'room-terminal-tool')
      .map(([, payload]) => payload)
    const toolCallIndex = persistedMessages.findIndex(payload => payload.role === 'assistant' && payload.tool_calls?.[0]?.id === 'call-write-stdin')
    const toolResultIndex = persistedMessages.findIndex(payload => payload.role === 'tool' && payload.tool_call_id === 'call-write-stdin')
    const finalAnswerIndex = persistedMessages.findIndex(payload => payload.role === 'assistant' && payload.content === 'Weather answer')

    expect(toolCallIndex).toBeGreaterThanOrEqual(0)
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex)
    expect(finalAnswerIndex).toBeGreaterThan(toolResultIndex)
    expect(persistedMessages[toolResultIndex]).toEqual(expect.objectContaining({
      tool_name: 'write_stdin',
      content: '',
      run_id: persistedMessages[toolCallIndex].run_id,
    }))
  })

  it('interrupts a non-Hermes group agent through chat-run only', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const chatRunService = {
      runAndWait: vi.fn(),
      abortSession: vi.fn(async () => {}),
    }
    const clients = new AgentClients()
    clients.setChatRunService(chatRunService)
    const client = await clients.createAgent({
      agentId: 'agent-ekko',
      agent: 'ekko',
      profile: 'default',
      name: 'Ekko',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({ getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '' })) })
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))
    const activeSessionId = `gc_run_room-1_default_Ekko_${'a'.repeat(32)}`
    client.activeSessions.set('room-1', activeSessionId)

    await clients.interruptAgent('room-1', 'Ekko')

    expect(chatRunService.abortSession).toHaveBeenCalledWith(
      activeSessionId,
      'Interrupted by group chat user',
    )
    expect(bridgeMock.interrupt).not.toHaveBeenCalled()
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
    const storage = { getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '' })) }
    client.setStorage(storage as any)
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))

    await expect(clients.interruptRoom('room-1')).resolves.toBeUndefined()
    expect(bridgeMock.interrupt).not.toHaveBeenCalled()
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

    const firstMention = clients.processMentions('room-1', {
      content: '@Worker first',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })
    await waitFor(() => bridgeMock.chat.mock.calls.length === 1)
    await clients.processMentions('room-1', {
      content: '@Worker second',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 2,
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    const interruptPromise = clients.interruptRoom('room-1')
    await waitFor(() => bridgeMock.interrupt.mock.calls.length === 1)
    finishStream()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(bridgeMock.chat).toHaveBeenCalledTimes(1)
    finishInterrupt()
    await interruptPromise
    await firstMention
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(bridgeMock.chat).toHaveBeenCalledTimes(1)
  })

  it('marks a mentioned agent active before rolling-summary preparation finishes', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const statuses: Array<{ agentName: string; status: string }> = []
    let finishSummary!: (value: { summary: string; history: [] }) => void
    const replyToMention = vi.fn(async () => {})
    const agent = {
      id: 'agent-socket-1',
      agentId: 'agent-1',
      name: 'Worker',
      replyToMention,
    }
    clients.rooms.set('room-1', new Map([[agent.agentId, agent]]))
    clients.setActivityBroadcaster((_roomId: string, agentName: string, status: string) => {
      statuses.push({ agentName, status })
    })
    clients.setRoomSummaryService({
      prepareForMessage: vi.fn(() => new Promise(resolve => { finishSummary = resolve })),
    })

    const processing = clients.processMentions('room-1', {
      messageId: 'message-10',
      content: '@Worker check this',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    expect(statuses[0]).toEqual({ agentName: 'Worker', status: 'replying' })
    expect(replyToMention).not.toHaveBeenCalled()

    finishSummary({ summary: 'summary', history: [] })
    await processing
    expect(replyToMention).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toEqual({ agentName: 'Worker', status: 'ready' })
  })

  it('dispatches an agent handoff after a CJK speaker prefix', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const replyToMention = vi.fn(async () => {})
    const codex = {
      id: 'codex-socket',
      agentId: 'agent-codex',
      name: 'codex',
      replyToMention,
    }
    clients.rooms.set('room-1', new Map([[codex.agentId, codex]]))

    await clients.processMentions('room-1', {
      messageId: 'hermes-handoff-1',
      content: 'hermes：@codex 老板喊你，出来露个脸。',
      senderName: 'hermes',
      senderId: 'agent-hermes',
      timestamp: 1,
      role: 'assistant',
      mentionDepth: 1,
      mentions: [{ type: 'agent', participantId: 'agent-codex' }],
    })

    expect(replyToMention).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({
        messageId: 'hermes-handoff-1',
        mentionDepth: 1,
      }),
      { summary: '', history: [] },
      expect.any(Function),
    )
  })

  it('attaches a validated structured mention to an agent reply before it is persisted', async () => {
    const client = await createClient('')
    client.__testStorage.getRoomAgents = vi.fn(() => [
      { agentId: 'agent-1', name: 'Worker' },
      { agentId: 'agent-reviewer', name: 'Reviewer' },
    ])
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: '@Reviewer please verify this',
        cursor: 1,
        output: '@Reviewer please verify this',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })

    await client.replyToMention('room-1', {
      content: '@Worker prepare the patch',
      senderName: 'Alice',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        content: '@Reviewer please verify this',
        mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
      }),
      expect.any(Function),
    )
  })

  it('keeps an agent active until all queued mentions finish', async () => {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const statuses: string[] = []
    let finishFirst!: () => void
    const replyToMention = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce(undefined)
    const agent = {
      id: 'agent-socket-1',
      agentId: 'agent-1',
      name: 'Worker',
      replyToMention,
    }
    clients.rooms.set('room-1', new Map([[agent.agentId, agent]]))
    clients.setActivityBroadcaster((_roomId: string, _agentName: string, status: string) => {
      statuses.push(status)
    })

    const first = clients.processMentions('room-1', {
      messageId: 'message-1',
      content: '@Worker first',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })
    await Promise.resolve()
    await clients.processMentions('room-1', {
      messageId: 'message-2',
      content: '@Worker second',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 2,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    expect(statuses).toEqual(['replying'])
    finishFirst()
    await first
    expect(replyToMention).toHaveBeenCalledTimes(2)
    expect(statuses).toEqual(['replying', 'ready'])
  })

  async function createClient(
    workspace = '',
    runtimeConfig: { provider?: string; model?: string; reasoningEffort?: string } = {},
  ) {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      ...runtimeConfig,
      name: 'Worker',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
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
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
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
      }),
    )
    expect(String(bridgeMock.chat.mock.calls[0]?.[3])).toContain('你是"Worker"，群聊房间"room-1"中的 AI 助手')
    expect(String(bridgeMock.chat.mock.calls[0]?.[3])).toContain('群聊系统支持 agent 之间通过 @名字 接力')
    expect(bridgeMock.chat.mock.calls[0]?.[5]).not.toHaveProperty('workspace')
    expect(bridgeMock.chat.mock.calls[0]?.[5]).not.toHaveProperty('run_id')
  })

  it('passes the room agent model selection and reasoning effort to the bridge', async () => {
    const client = await createClient('', {
      provider: 'selected-provider',
      model: 'selected-model',
      reasoningEffort: 'high',
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(bridgeMock.chat.mock.calls[0]?.[5]).toMatchObject({
      provider: 'selected-provider',
      model: 'selected-model',
      reasoning_effort: 'high',
    })
  })

  it('does not launch a reply after its fresh session has been superseded', async () => {
    const client = await createClient('/tmp/workspace')
    client.__testStorage.getRoom.mockImplementation(() => {
      client.activeSessions.set('room-1', 'replacement-session')
      return { sessionSeed: 'seed-1', workspace: '/tmp/workspace' }
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('uses and disposes a different temporary bridge session for every reply', async () => {
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })
    await client.replyToMention('room-1', {
      content: '@Worker again',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 2,
    })

    const sessionIds = bridgeMock.chat.mock.calls.map(call => call[0])
    expect(sessionIds).toHaveLength(2)
    expect(sessionIds[0]).toMatch(/^gc_run_/)
    expect(sessionIds[1]).toMatch(/^gc_run_/)
    expect(sessionIds[0]).not.toBe(sessionIds[1])
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionIds[0], 'default')
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionIds[1], 'default')
  })

  it('does not start a bridge workspace run after the room is deleted before launch', async () => {
    const client = await createClient('/tmp/workspace')
    const storage = (client as any).__testStorage
    storage.getRoom.mockReturnValue(undefined)

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
    const { groupRuntimeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
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
    const { groupRuntimeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
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
    const { groupRuntimeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
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
    const { groupRuntimeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
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

  it('drops late assistant output after the active temporary session is replaced', async () => {
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    let activeClient: any
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      activeClient.activeSessions.set('room-1', 'replacement-session')
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
    const client = await createClient('/tmp/workspace')
    activeClient = client

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const sessionId = bridgeMock.chat.mock.calls[0][0]
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(
      sessionId,
      'Interrupted because group chat room state changed',
      'default',
    )
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionId, 'default')
    expect(client.__testStorage.saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(mockSocket.emit).toHaveBeenCalledWith('message_stream_end', expect.objectContaining({
      roomId: 'room-1',
      agentSessionId: sessionId,
    }))
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ role: 'assistant' }), expect.any(Function))
    expect(trackerMock.discardWorkspaceRunCheckpoint).toHaveBeenCalledWith({
      sessionId,
      runId: 'bridge-run-id',
    })
    expect(client.workspaceDiffRuns.size).toBe(0)
  })

  it('cleans up no-change workspace runs and keeps overlapping runs isolated', async () => {
    const client = await createClient('/tmp/workspace')
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    const runA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const runB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const { groupRuntimeSessionId } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
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
