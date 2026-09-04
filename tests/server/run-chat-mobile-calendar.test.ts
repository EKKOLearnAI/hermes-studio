import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeMock = vi.hoisted(() => ({ statusIfLoaded: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({ start: vi.fn(async () => {}), ensureReady: vi.fn() })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: {
    resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
    resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
    stop: vi.fn(),
  },
  handleChatCodingAgentSessionCommand: vi.fn(),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: vi.fn() })),
  respondToChatEkkoToolApproval: vi.fn(() => ({ handled: false, resolved: false })),
  respondToChatEkkoClarification: vi.fn(() => ({ handled: false, resolved: false })),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const sessionStoreMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(() => null),
  getSessionDetail: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => sessionStoreMock)
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

function harness() {
  const handlers = new Map<string, Function>()
  const emitted: Array<{ room: string; event: string; payload: any }> = []
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    sockets: new Map(),
    to: vi.fn((room: string) => ({ emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })) })),
    use: vi.fn(), on: vi.fn(), emit: vi.fn(),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    data: {},
    handshake: { auth: {}, query: { profile: 'default' } },
    on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
    join: vi.fn(),
    emit: vi.fn(),
  }
  return { emitted, handlers, io: { of: vi.fn(() => namespace) }, socket }
}

describe('ChatRunSocket mobile calendar and reminders', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    sessionStoreMock.getSession.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
    })
  })

  it('requests a calendar list and sanitizes the App response', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], events: [], queue: [], isWorking: true, profile: 'default', source: 'coding_agent',
    })
    ;(server as any).onConnection(socket)
    const resultPromise = server.requestMobileCalendar({
      sessionId: 'session-1',
      profile: 'default',
      capability: 'calendar',
      action: 'list',
      purpose: 'Plan tomorrow',
      limit: 20,
      timeoutMs: 10_000,
    })
    const requested = emitted.find(item => item.event === 'calendar.requested')
    expect(requested?.payload).toMatchObject({
      session_id: 'session-1',
      capability: 'calendar',
      action: 'list',
      purpose: 'Plan tomorrow',
      limit: 20,
    })
    handlers.get('calendar.respond')?.({
      session_id: 'session-1',
      calendar_request_id: requested?.payload.calendar_request_id,
      status: 'success',
      result: {
        capability: 'calendar',
        action: 'list',
        items: [{ id: '1', title: 'Meeting', startMs: 1, secret: 'drop-me' }],
      },
    })
    await expect(resultPromise).resolves.toEqual({
      status: 'success',
      result: {
        capability: 'calendar',
        action: 'list',
        items: [{ id: '1', title: 'Meeting', startMs: 1 }],
      },
    })
    expect((server as any).sessionMap.get('session-1').events).toEqual([])
  })

  it('supports reminder completion but rejects delete and workflow requests', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = harness()
    const server = new ChatRunSocket(io as any)
    expect(() => server.requestMobileCalendar({
      sessionId: 'session-1',
      profile: 'default',
      capability: 'reminder',
      action: 'delete',
      purpose: 'Delete it',
      item: { id: '1' },
    })).toThrow('Unsupported reminder action')
    sessionStoreMock.getSession.mockReturnValue({ id: 'session-1', profile: 'default', source: 'workflow' })
    expect(() => server.requestMobileCalendar({
      sessionId: 'session-1',
      profile: 'default',
      capability: 'reminder',
      action: 'complete',
      purpose: 'Complete it',
      item: { id: '1' },
    })).toThrow('available only in direct chats')
  })
})
