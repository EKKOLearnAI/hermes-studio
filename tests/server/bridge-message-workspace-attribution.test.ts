import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('bridge assistant workspace attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rebinds the in-memory assistant message to its persisted row id for session resume', async () => {
    addMessageMock.mockReturnValue(73)
    const state: any = {
      messages: [{
        id: 1,
        session_id: 'session-hermes',
        runMarker: 'run-hermes',
        role: 'assistant',
        content: 'Finished the workspace update.',
        timestamp: 1,
      }],
      isWorking: true,
      events: [],
      queue: [],
      bridgePendingAssistantContent: 'Finished the workspace update.',
      bridgePendingReasoningContent: '',
    }
    const { flushBridgePendingToDb } = await import('../../packages/server/src/services/hermes/run-chat/bridge-message')

    const persistedId = flushBridgePendingToDb(state, 'session-hermes', 'run-hermes')

    expect(persistedId).toBe('73')
    expect(state.bridgeAssistantMessageId).toBe('73')
    expect(state.messages[0]).toMatchObject({ id: 73, finish_reason: 'stop' })
  })
})
