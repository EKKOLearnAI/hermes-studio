// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store compression state', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: sessionId === 'session-1',
        events: [],
      })
      return {} as any
    })
  })

  it('does not show a background session compression indicator in the active session', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-1'), makeSession('session-2')]

    await store.switchSession('session-1')
    const handlers = chatApi.registerSessionHandlers.mock.calls.find(call => call[0] === 'session-1')?.[1]
    expect(handlers).toBeTruthy()

    await store.switchSession('session-2')
    handlers.onCompressionStarted({
      event: 'compression.started',
      session_id: 'session-1',
      message_count: 6,
      token_count: 1234,
    })

    expect(store.activeSessionId).toBe('session-2')
    expect(store.compressionState).toBeNull()

    await store.switchSession('session-1')
    expect(store.compressionState).toEqual(expect.objectContaining({
      compressing: true,
      messageCount: 6,
      beforeTokens: 1234,
    }))
  })
})
