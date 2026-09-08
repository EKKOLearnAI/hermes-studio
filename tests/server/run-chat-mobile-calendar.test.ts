import { mobileDeviceRoom, mobileDeviceId } from '../../packages/server/src/modules/studio/services/chat-run/mobile-device-target'
const target = { deviceCode: 'iphone', userId: '1', profile: 'default' }
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
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])], [mobileDeviceRoom(target), new Set(['socket-1'])]]) },
    sockets: new Map(),
    to: vi.fn((room: string) => ({ emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })) })),
    use: vi.fn(), on: vi.fn(), emit: vi.fn(),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    data: { mobileDeviceTarget: target },
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
    ;(server as any).mobileRunTargets.set('session-1', target)
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
      device_id: mobileDeviceId(target),
      status: 'success',
      result: {
        capability: 'calendar',
        action: 'list',
        items: [{ id: '1', title: 'Meeting', startMs: 1 }],
      },
    })
    expect((server as any).sessionMap.get('session-1').events).toEqual([])
  })

  it('requires fresh deletion confirmation and rejects late responses', async () => {
    vi.useFakeTimers()
    try {
      const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
      const { emitted, handlers, io, socket } = harness()
      const server = new ChatRunSocket(io as any)
    ;(server as any).mobileRunTargets.set('session-1', target)
      ;(server as any).onConnection(socket)
      const options = { sessionId: 'session-1', profile: 'default', capability: 'reminder' as const,
        action: 'delete', purpose: 'Delete test', item: { id: '1', title: 'test' }, timeoutMs: 3000 }
      const pending = server.requestMobileCalendar(options)
      const first = emitted.find(item => item.event === 'reminder.requested')!.payload
      expect(first.expires_at_ms).toBe(Date.now() + 3000)
      handlers.get('reminder.respond')?.({ session_id: 'session-1', reminder_request_id: first.reminder_request_id, status: 'denied' })
      await expect(pending).resolves.toEqual({ status: 'denied', device_id: mobileDeviceId(target) })
      const timed = server.requestMobileCalendar(options)
      await vi.advanceTimersByTimeAsync(3001)
      await expect(timed).resolves.toMatchObject({ status: 'error' })
      expect((server as any).pendingMobileCalendar.size).toBe(0)
      handlers.get('reminder.respond')?.({ session_id: 'session-1', reminder_request_id: first.reminder_request_id,
        status: 'success', result: { item: { id: '1', deleted: true } } })
      expect((server as any).pendingMobileCalendar.size).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each([undefined, null, 0, 600000, 300000])('uses a matching five-minute card/server deadline for %s', async timeoutMs => {
    vi.useFakeTimers()
    try {
      const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
      const { emitted, io } = harness()
      const server = new ChatRunSocket(io as any)
    ;(server as any).mobileRunTargets.set('session-1', target)
      const promise = server.requestMobileCalendar({ sessionId: 'session-1', profile: 'default', capability: 'reminder', action: 'list', purpose: 'test', timeoutMs })
      const event = emitted.find(entry => entry.event === 'reminder.requested')!.payload
      expect(event.timeout_ms).toBe(300000)
      expect(event.expires_at_ms).toBe(Date.now() + 300000)
      await vi.advanceTimersByTimeAsync(60001)
      expect((server as any).pendingMobileCalendar.size).toBe(1)
      await vi.advanceTimersByTimeAsync(239999)
      await expect(promise).resolves.toMatchObject({ status: 'error' })
      expect((server as any).pendingMobileCalendar.size).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('rejects non-target responses and never broadcasts requested events to other devices', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).mobileRunTargets.set('session-1', target)
    ;(server as any).onConnection(socket)
    const result = server.requestMobileCalendar({ sessionId:'session-1', profile:'default', capability:'reminder', action:'list', purpose:'test' })
    const requests = emitted.filter(v=>v.event==='reminder.requested')
    expect(requests).toHaveLength(1)
    expect(requests[0].room).toBe(mobileDeviceRoom(target))
    const id=requests[0].payload.reminder_request_id
    socket.data.mobileDeviceTarget={...target,deviceCode:'android'}
    handlers.get('reminder.respond')?.({session_id:'session-1',reminder_request_id:id,status:'denied'})
    expect((server as any).pendingMobileCalendar.size).toBe(1)
    socket.data.mobileDeviceTarget=target
    handlers.get('reminder.respond')?.({session_id:'session-1',reminder_request_id:id,status:'denied'})
    await expect(result).resolves.toMatchObject({status:'denied',device_id:mobileDeviceId(target)})
  })
  it('fails closed for missing origin and offline target even if another device is online', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = harness();const server=new ChatRunSocket(io as any)
    const options={sessionId:'session-1',profile:'default',capability:'reminder' as const,action:'list',purpose:'test'}
    expect(()=>server.requestMobileCalendar(options)).toThrow('Mobile target unavailable')
    ;(server as any).mobileRunTargets.set('session-1',{...target,deviceCode:'offline'})
    expect(()=>server.requestMobileCalendar(options)).toThrow('offline')
  })

  it('supports reminder completion but rejects incomplete delete and workflow requests', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).mobileRunTargets.set('session-1', target)
    expect(() => server.requestMobileCalendar({
      sessionId: 'session-1',
      profile: 'default',
      capability: 'reminder',
      action: 'delete',
      purpose: 'Delete it',
      item: { id: '1' },
    })).toThrow('A valid item is required')
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
