import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeMock = vi.hoisted(() => ({
  clarifyRespond: vi.fn(),
  statusIfLoaded: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: vi.fn(() => null),
  getSessionDetail: vi.fn(() => null),
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
  userCanAccessProfile: vi.fn(() => true),
}))

function createSocketHarness() {
  const handlers = new Map<string, Function>()
  const namespaceEmit = vi.fn()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => ({ emit: namespaceEmit })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = {
    of: vi.fn(() => namespace),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    data: {},
    handshake: { auth: {}, query: { profile: 'default' } },
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
    join: vi.fn(),
    emit: vi.fn(),
  }
  return { handlers, io, namespace, namespaceEmit, socket }
}

describe('ChatRunSocket clarify responses', () => {
  beforeEach(() => {
    vi.resetModules()
    bridgeMock.clarifyRespond.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
  })

  it('forwards clarify.respond events to the bridge and emits clarify.resolved', async () => {
    bridgeMock.clarifyRespond.mockResolvedValue({ ok: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, namespace, namespaceEmit, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option A',
    })

    expect(bridgeMock.clarifyRespond).toHaveBeenCalledWith('clarify-1', 'Use option A')
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
    expect(namespaceEmit).toHaveBeenCalledWith('clarify.resolved', {
      event: 'clarify.resolved',
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      resolved: true,
    })
  })

  it('does not replay answered clarify prompts when the session resumes', async () => {
    bridgeMock.clarifyRespond.mockResolvedValue({ ok: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const toolEvent = {
      event: 'tool.started',
      data: { event: 'tool.started', tool_call_id: 'tool-1' },
    }
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      events: [
        {
          event: 'clarify.requested',
          data: {
            event: 'clarify.requested',
            clarify_id: 'clarify-1',
            question: 'Pick one',
          },
        },
        toolEvent,
      ],
      queue: [],
    })

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option A',
    })
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect((server as any).sessionMap.get('session-1').events).toEqual([toolEvent])
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: true,
      events: [toolEvent],
    }))
  })

  it('emits an unresolved clarify result when the bridge rejects the response', async () => {
    bridgeMock.clarifyRespond.mockRejectedValue(new Error('unknown clarify request'))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, namespaceEmit, socket } = createSocketHarness()
    const namespace = {
      adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
      to: vi.fn(() => ({ emit: namespaceEmit })),
      use: vi.fn(),
      on: vi.fn(),
    }
    const server = new ChatRunSocket({ of: vi.fn(() => namespace) } as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option B',
    })

    expect(namespaceEmit).toHaveBeenCalledWith('clarify.resolved', {
      event: 'clarify.resolved',
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      resolved: false,
      error: 'unknown clarify request',
    })
  })
})
