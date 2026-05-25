import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn()
const createSessionMock = vi.fn()
const getSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
  clearSessionMessages: vi.fn(),
  createSession: createSessionMock,
  getSession: getSessionMock,
  renameSession: vi.fn(),
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  buildDbHistory: vi.fn(),
  estimateSnapshotAwareHistoryUsage: vi.fn(),
  forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: vi.fn((_map: Map<string, any>, sessionId: string) => _map.get(sessionId)),
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: vi.fn(),
  contextTokensWithCachedOverhead: vi.fn(),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/abort', () => ({
  handleAbort: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

function makeContext(state: any, commandResult: Record<string, unknown> = {
  handled: true,
  message: '[IMPORTANT: expanded plan skill prompt]',
}) {
  const namespaceEmit = vi.fn()
  const nsp = {
    to: vi.fn(() => ({ emit: namespaceEmit })),
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    join: vi.fn(),
    emit: vi.fn(),
  }
  const sessionMap = new Map([['session-1', state]])
  const runQueuedItem = vi.fn()
  const bridge = {
    command: vi.fn(async () => commandResult),
    status: vi.fn(async () => ({
      exists: true,
      running: false,
      current_run_id: null,
      message_count: 0,
    })),
  }
  return { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket }
}

describe('plan session command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli' })
  })

  it('queues running plan commands once without visible command echo', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command')
    const command = parseSessionCommand('/plan build the feature')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'client-queue-id',
      runQueuedItem,
    })

    expect(addMessageMock).not.toHaveBeenCalled()
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'client-queue-id',
      input: '[IMPORTANT: expanded plan skill prompt]',
      displayInput: '/plan build the feature',
      displayRole: 'command',
      storageMessage: '/plan build the feature',
    })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queue_length: 1,
      queued_messages: [expect.objectContaining({
        id: 'client-queue-id',
        role: 'command',
        content: '/plan build the feature',
        queued: true,
      })],
    }))
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.anything())
  })

  it('starts an idle goal command as a hidden kickoff run', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'set',
      message: 'Goal set.',
      kickoff_prompt: 'fix the tests',
      max_turns: 20,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command')
    const command = parseSessionCommand('/goal fix the tests')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'goal-queue-id',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', 'goal fix the tests', 'default')
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'set',
      message: 'Goal set.',
      terminal: false,
      started: true,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'goal-queue-id',
      input: 'fix the tests',
      displayInput: null,
      storageMessage: 'fix the tests',
      source: 'cli',
    }), 'default')
  })

  it('clears queued goal continuations when pausing a goal', async () => {
    const state = {
      messages: [],
      isWorking: true,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue', displayInput: null, storageMessage: 'continue', profile: 'default', goalContinuation: true },
        { queue_id: 'user-1', input: 'user message', profile: 'default' },
      ],
    }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'pause',
      message: 'Goal paused.',
      clear_goal_continuations: true,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command')
    const command = parseSessionCommand('/goal pause')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({ queue_id: 'user-1' })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queue_length: 1,
      queued_messages: [expect.objectContaining({ id: 'user-1', content: 'user message' })],
    }))
  })

  it('emits a goal-specific clear action for goal done', async () => {
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue', displayInput: null, storageMessage: 'continue', profile: 'default', goalContinuation: true },
      ],
    }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'clear',
      message: 'Goal cleared.',
      clear_goal_continuations: true,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command')
    const command = parseSessionCommand('/goal done')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', 'goal done', 'default')
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'goal_clear',
      message: 'Goal cleared.',
      terminal: true,
      started: false,
    }))
  })

  it('starts a resumed goal as a hidden continuation run', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'resume',
      message: 'Goal resumed.',
      kickoff_prompt: '[Continuing toward your standing goal]\nGoal: fix the tests',
      max_turns: 20,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command')
    const command = parseSessionCommand('/goal resume')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'resume-queue-id',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', 'goal resume', 'default')
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'resume',
      message: 'Goal resumed.',
      terminal: false,
      started: true,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'resume-queue-id',
      input: '[Continuing toward your standing goal]\nGoal: fix the tests',
      displayInput: null,
      storageMessage: '[Continuing toward your standing goal]\nGoal: fix the tests',
      source: 'cli',
    }), 'default')
  })

  it('includes bridge run state in goal status output', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'goal_status',
      message: 'Goal (active, 0/20 turns): build docs',
    })
    bridge.status.mockResolvedValueOnce({
      exists: true,
      running: true,
      current_run_id: 'run-123',
      message_count: 4,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command')
    const command = parseSessionCommand('/goal status')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'goal_status',
      message: 'Goal (active, 0/20 turns): build docs\nCurrent turn: 1/20 running (completed turns: 0/20; count updates after the judge).\nRun: running (run-123)',
      bridgeStatus: expect.objectContaining({
        running: true,
        currentRunId: 'run-123',
      }),
    }))
  })
})
