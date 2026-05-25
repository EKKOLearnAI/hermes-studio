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

function makeContext(state: any) {
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
    command: vi.fn(async () => ({
      handled: true,
      message: '[IMPORTANT: expanded plan skill prompt]',
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
})
