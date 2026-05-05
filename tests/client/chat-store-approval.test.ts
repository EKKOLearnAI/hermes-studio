// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApiMocks = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn((sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [] })
    return {} as any
  }),
  registerSessionHandlers: vi.fn(() => vi.fn()),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  submitApprovalViaSocket: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => chatApiMocks)

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
}))

vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => ''),
}))

import { useChatStore } from '@/stores/hermes/chat'

describe('chat store approval commands', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('submits /approve through the active streaming run instead of starting a new run', async () => {
    const store = useChatStore()

    store.newChat()
    const sessionId = store.activeSessionId!
    await store.sendMessage('start risky work')
    expect(chatApiMocks.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(store.isStreaming).toBe(true)

    await store.sendMessage('/approve session')

    expect(chatApiMocks.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(chatApiMocks.submitApprovalViaSocket).toHaveBeenCalledWith(sessionId, 'session', false)
    expect(store.messages.at(-1)?.role).toBe('user')
    expect(store.messages.at(-1)?.content).toBe('/approve session')
  })

  it('keeps ordinary chat text blocked while a run is streaming', async () => {
    const store = useChatStore()

    store.newChat()
    await store.sendMessage('start risky work')
    expect(store.isStreaming).toBe(true)

    await store.sendMessage('this should not start another run')

    expect(chatApiMocks.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(chatApiMocks.submitApprovalViaSocket).not.toHaveBeenCalled()
    expect(store.messages.map(m => m.content)).not.toContain('this should not start another run')
  })
})
