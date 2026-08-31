import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Group chat declares the conversation each reply belongs to.
 *
 * `groupRuntimeSessionId` is per-reply on purpose, so Hermes used to see a
 * brand-new conversation on every reply and re-key every affinity hint it
 * derives from that id (NousResearch/hermes-agent#96811). These tests pin the
 * declaration: what is sent, that it holds across replies, that it rotates on
 * the room's own conversation boundary, and that a room we cannot read simply
 * declares nothing.
 */

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
  chat: vi.fn(async (sessionId: string) => ({
    ok: true,
    run_id: 'bridge-run-id',
    session_id: sessionId,
    status: 'running',
  })),
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
  contextEstimate: vi.fn(async () => ({ ok: true })),
  interrupt: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
}))

vi.mock('socket.io-client', () => ({ io: vi.fn(() => mockSocket) }))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ model: { default: 'model-a', provider: 'provider-a' } })),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ updateUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/group-chat-agent-runtime', () => ({
  createGroupPrimaryAgentBridge: vi.fn(() => bridgeMock),
  cancelGroupEkkoClarification: vi.fn(() => ({ resolved: false })),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: vi.fn(),
  completeWorkspaceRunCheckpointDraft: vi.fn(() => null),
  discardWorkspaceRunCheckpoint: vi.fn(),
}))

const MENTION = {
  messageId: 'message-1',
  content: '@Worker take a look',
  senderName: 'Human',
  senderId: 'human-1',
  timestamp: 1,
  role: 'user' as const,
}

async function createClient(seed: string | null = 'seed-1') {
  const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
  const clients = new AgentClients()
  const client = await clients.createAgent({
    agentId: 'agent-1',
    profile: 'default',
    provider: 'provider-a',
    model: 'model-a',
    name: 'Worker',
    description: '',
    invited: 0,
    backgroundDelegationEnabled: false,
  } as any)
  const storage = {
    getRoom: vi.fn(() => (seed === null ? undefined : { sessionSeed: seed, workspace: '' })),
    saveWorkspaceDiffMessageForRun: vi.fn(),
    updateRoomTotalTokens: vi.fn(),
    getMessagesForContext: vi.fn(() => []),
    getContextSnapshot: vi.fn(() => null),
  }
  client.setStorage(storage as any)
  ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))
  return client as any
}

function chatCallOptions(index = 0) {
  return bridgeMock.chat.mock.calls[index]?.[5] as Record<string, unknown> | undefined
}

function chatCallSessionId(index = 0) {
  return bridgeMock.chat.mock.calls[index]?.[0] as string
}

describe('group chat declares the conversation to Hermes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSocket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'message' && ack) ack({ id: data?.id || 'msg-id' })
      return mockSocket
    })
    bridgeMock.chat.mockImplementation(async (sessionId: string) => ({
      ok: true,
      run_id: 'bridge-run-id',
      session_id: sessionId,
      status: 'running',
    }))
  })

  it('sends the room member conversation key alongside the per-reply session id', async () => {
    const { groupBridgeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const client = await createClient('seed-1')

    await client.replyToMention('room-1', MENTION)

    const expected = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-1', {
      agent: 'hermes',
      provider: 'provider-a',
      model: 'model-a',
      apiMode: '',
      reasoningEffort: '',
    })
    expect(chatCallOptions()).toMatchObject({ gateway_session_key: expected })
    // The declaration names the conversation; the first argument still names
    // this one reply, and the two must not be the same value.
    expect(chatCallSessionId()).not.toBe(expected)
    expect(chatCallSessionId()).toMatch(/^gc_run_/)
  })

  it('holds one conversation across replies with distinct session ids', async () => {
    const client = await createClient('seed-1')

    await client.replyToMention('room-1', MENTION)
    await client.replyToMention('room-1', { ...MENTION, messageId: 'message-2' })

    expect(bridgeMock.chat).toHaveBeenCalledTimes(2)
    expect(chatCallSessionId(0)).not.toBe(chatCallSessionId(1))
    expect(chatCallOptions(0)?.gateway_session_key)
      .toBe(chatCallOptions(1)?.gateway_session_key)
  })

  it('rotates the declaration when the room starts a new conversation', async () => {
    const first = await createClient('seed-1')
    await first.replyToMention('room-1', MENTION)
    const before = chatCallOptions(0)?.gateway_session_key

    vi.clearAllMocks()
    const second = await createClient('seed-2')
    await second.replyToMention('room-1', MENTION)
    const after = chatCallOptions(0)?.gateway_session_key

    expect(before).toBeTruthy()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
  })

  it('falls back to the default seed for a room that never reset', async () => {
    const { groupBridgeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const client = await createClient('')

    await client.replyToMention('room-1', MENTION)

    // A room row carries sessionSeed TEXT NOT NULL DEFAULT '0'; an empty value
    // is the same conversation as '0', not a missing declaration.
    expect(chatCallOptions()).toMatchObject({
      gateway_session_key: groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
        agent: 'hermes',
        provider: 'provider-a',
        model: 'model-a',
        apiMode: '',
        reasoningEffort: '',
      }),
    })
  })
})

describe('AgentBridgeClient carries the declared conversation', () => {
  it('forwards the key when one is declared', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, run_id: 'r1' } as any)

    await client.chat('run-1', 'hello', undefined, undefined, 'default', {
      gateway_session_key: 'gc_room_default_Worker_0_h_deadbeefdeadbeef',
    })

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      action: 'chat',
      session_id: 'run-1',
      gateway_session_key: 'gc_room_default_Worker_0_h_deadbeefdeadbeef',
    }))
  })

  it('omits the field entirely when nothing is declared', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, run_id: 'r1' } as any)

    await client.chat('run-1', 'hello')

    expect(request.mock.calls[0][0]).not.toHaveProperty('gateway_session_key')
  })
})
