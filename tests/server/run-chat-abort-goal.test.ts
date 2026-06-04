import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateSessionStatsMock = vi.fn()
const flushBridgePendingToDbMock = vi.fn()
const flushResponseRunToDbMock = vi.fn()
const replaceStateMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/response-stream', () => ({
  flushResponseRunToDb: flushResponseRunToDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  replaceState: replaceStateMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
}))

function makeHarness() {
  const emit = vi.fn()
  const nsp = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => ({ emit })),
  }
  const socket = {
    connected: true,
    emit: vi.fn(),
  }
  return { emit, nsp, socket }
}

describe('run chat abort goal handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 0, outputTokens: 0 })
  })

  it('pauses an active goal and clears hidden goal continuations when aborting a CLI run', async () => {
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue goal', profile: 'default', goalContinuation: true },
        { queue_id: 'user-1', input: 'normal follow-up', profile: 'default', source: 'cli' },
      ],
      runId: 'run-1',
      profile: 'default',
      source: 'cli',
    } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      interrupt: vi.fn().mockResolvedValue({ ok: true }),
      goalPause: vi.fn().mockResolvedValue({ handled: true, status: 'paused', reason: 'user-interrupted' }),
    }
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, runQueuedItem)

    expect(bridge.interrupt).toHaveBeenCalledWith('session-1', 'Aborted by user', 'default')
    expect(bridge.goalPause).toHaveBeenCalledWith('session-1', 'user-interrupted', 'default')
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'user-1',
    }), 'default')
    expect(state.queue).toEqual([])
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      synced: true,
    }))
  })

  it('keeps the session locked when a CLI interrupt does not sync before timeout', async () => {
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue goal', profile: 'default', goalContinuation: true },
        { queue_id: 'user-1', input: 'normal follow-up', profile: 'default', source: 'cli' },
      ],
      runId: 'run-1',
      profile: 'default',
      source: 'cli',
    } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      interrupt: vi.fn().mockResolvedValue({ ok: true, synced: false }),
      goalPause: vi.fn().mockResolvedValue({ handled: true, status: 'paused', reason: 'user-interrupted' }),
    }
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, runQueuedItem)

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(calcAndUpdateUsageMock).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(true)
    expect(state.isAborting).toBe(true)
    expect(state.runId).toBe('run-1')
    expect(state.queue).toEqual([
      { queue_id: 'user-1', input: 'normal follow-up', profile: 'default', source: 'cli' },
    ])
    expect(emit).toHaveBeenCalledWith('abort.timeout', expect.objectContaining({
      session_id: 'session-1',
      run_id: 'run-1',
      synced: false,
    }))
    expect(emit).not.toHaveBeenCalledWith('abort.completed', expect.anything())
  })
})
