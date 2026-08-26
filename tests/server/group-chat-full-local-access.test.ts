import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  chat: vi.fn(async (_sessionId: string) => ({ ok: true, run_id: 'bridge-run-id', session_id: _sessionId, status: 'running' })),
  streamOutput: vi.fn(async function* (runId: string) {
    yield {
      ok: true, run_id: runId, session_id: 'session-1', status: 'complete',
      delta: 'done', cursor: 1, output: 'done', done: true, events: [], event_cursor: 0,
    }
  }),
  contextEstimate: vi.fn(),
  interrupt: vi.fn(),
  destroy: vi.fn(),
}))

const trackerMock = vi.hoisted(() => ({
  startWorkspaceRunCheckpoint: vi.fn(),
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

describe('group chat full local access switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSocket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'message' && ack) ack({ id: data?.id || 'msg-id' })
      return mockSocket
    })
    trackerMock.completeWorkspaceRunCheckpointDraft.mockReset()
    trackerMock.completeWorkspaceRunCheckpointDraft.mockReturnValue(null)
    bridgeMock.interrupt.mockResolvedValue(undefined)
    bridgeMock.destroy.mockResolvedValue(undefined)
  })

  async function setupRoom(roomOverrides: Record<string, any> = {}) {
    const { AgentClients } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any) => ({ ok: true, output: 'done' }))
    const clients = new AgentClients()
    clients.setChatRunService({ runAndWait, abortSession: vi.fn(async () => {}) })
    const client = await clients.createAgent({
      agentId: 'agent-fullaccess',
      agent: 'codex',
      profile: 'default',
      name: 'FullAccessAgent',
      description: 'Handles local machine work',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any)
    const storage = {
      getRoom: vi.fn(() => ({
        name: 'Secure Room',
        workspace: '/srv/group-chat/secure-room',
        ownerAuthUserId: 42,
        fullLocalAccess: 0,
        ...roomOverrides,
      })),
      getRoomMembers: vi.fn(() => [
        { userId: 'auth:42', name: 'Room Owner' },
        { userId: 'member-guest', name: 'Guest' },
      ]),
      getRoomAgents: vi.fn(() => [{
        id: 'room-agent-fullaccess',
        agentId: 'agent-fullaccess',
        name: 'FullAccessAgent',
        executorType: 'remote',
        ownerMemberId: 'auth:42',
      }]),
    }
    ;(clients as any).rooms.set('room-fullaccess', new Map([[client.agentId, client]]))
    clients.setStorage(storage)
    return { clients, client, storage, runAndWait }
  }

  async function sendMention(clients: any, senderId: string, senderName: string) {
    await clients.processMentions('room-fullaccess', {
      messageId: `message-${senderId}`,
      content: '@FullAccessAgent please handle the local files',
      senderName,
      senderId,
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-fullaccess' }],
    })
  }

  it('injects the non-owner security context when fullLocalAccess is off (default)', async () => {
    const { clients, runAndWait, client } = await setupRoom({ fullLocalAccess: 0 })
    await sendMention(clients, 'member-guest', 'Guest')
    const instructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(instructions).toContain('# Security context: request from a non-owner')
    expect(instructions).toContain('"authorized_workspace": "/srv/group-chat/secure-room"')
    client.disconnect()
  })

  it('skips the non-owner security context when fullLocalAccess is on', async () => {
    const { clients, runAndWait, client } = await setupRoom({ fullLocalAccess: 1 })
    await sendMention(clients, 'member-guest', 'Guest')
    const instructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(instructions).not.toContain('# Security context: request from a non-owner')
    expect(instructions).not.toContain('"authorized_workspace"')
    client.disconnect()
  })

  it('restores the security context after fullLocalAccess is disabled again', async () => {
    const { clients, runAndWait, client } = await setupRoom({ fullLocalAccess: 1 })
    await sendMention(clients, 'member-guest', 'Guest')
    expect(String(runAndWait.mock.calls[0]?.[0]?.instructions || '')).not.toContain('# Security context')

    ;(clients as any)._storage.getRoom.mockReturnValue({
      name: 'Secure Room',
      workspace: '/srv/group-chat/secure-room',
      ownerAuthUserId: 42,
      fullLocalAccess: 0,
    })
    runAndWait.mockClear()
    await sendMention(clients, 'member-guest', 'Guest')
    const instructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(instructions).toContain('# Security context: request from a non-owner')
    expect(instructions).toContain('"authorized_workspace": "/srv/group-chat/secure-room"')
    client.disconnect()
  })

  it('never injects the security context for owner messages regardless of the switch', async () => {
    const { clients, runAndWait, client } = await setupRoom({ fullLocalAccess: 1 })
    await sendMention(clients, 'auth:42', 'Room Owner')
    const instructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(instructions).not.toContain('# Security context: request from a non-owner')
    client.disconnect()
  })

  it('keeps remote-workspace API hints for guest agents even when fullLocalAccess is on', async () => {
    const { clients, runAndWait, client } = await setupRoom({
      fullLocalAccess: 1,
      remoteWorkspaceApi: { access: 'read-write', endpoint: 'http://127.0.0.1:9999/ws', token: 'tok' },
    })
    await sendMention(clients, 'member-guest', 'Guest')
    const instructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(instructions).not.toContain('# Security context: request from a non-owner')
    expect(instructions).toContain('short-lived HTTP JSON API')
    client.disconnect()
  })

  it('gc_rooms schema declares fullLocalAccess with default 0', async () => {
    const { GC_ROOMS_SCHEMA } = await import('../../packages/server/src/db/hermes/schemas')
    expect(GC_ROOMS_SCHEMA.fullLocalAccess).toBe('INTEGER NOT NULL DEFAULT 0')
  })
})
