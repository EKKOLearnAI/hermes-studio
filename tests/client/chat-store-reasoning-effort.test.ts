// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
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
  archiveSession: vi.fn(),
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

function makeSession(id = 'session-1'): Session {
  return {
    id,
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const LS_PREFIX = 'hermes:reasoning_effort:'

describe('chat store per-session reasoning effort', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('persists the chosen effort on the active session', () => {
    const store = useChatStore()
    const session = makeSession('s1')
    store.sessions = [session]

    store.setSessionReasoningEffort('s1', 'low')

    expect(store.sessions[0].reasoningEffort).toBe('low')
    expect(localStorage.getItem(LS_PREFIX + 's1')).toBe('low')
  })

  it('clears persistence when the value is empty', () => {
    const store = useChatStore()
    const session = makeSession('s2')
    store.sessions = [session]
    store.setSessionReasoningEffort('s2', 'high')
    expect(localStorage.getItem(LS_PREFIX + 's2')).toBe('high')

    store.setSessionReasoningEffort('s2', '')

    expect(store.sessions[0].reasoningEffort).toBeUndefined()
    expect(localStorage.getItem(LS_PREFIX + 's2')).toBeNull()
  })

  it('keeps each session independent', () => {
    const store = useChatStore()
    const a = makeSession('a')
    const b = makeSession('b')
    store.sessions = [a, b]

    store.setSessionReasoningEffort('a', 'minimal')
    store.setSessionReasoningEffort('b', 'high')

    expect(store.sessions.find(s => s.id === 'a')?.reasoningEffort).toBe('minimal')
    expect(store.sessions.find(s => s.id === 'b')?.reasoningEffort).toBe('high')
  })

  it('is a no-op when the session does not exist', () => {
    const store = useChatStore()
    store.sessions = [makeSession('only-one')]

    expect(() => store.setSessionReasoningEffort('missing', 'high')).not.toThrow()
    expect(store.sessions[0].reasoningEffort).toBeUndefined()
    expect(localStorage.getItem(LS_PREFIX + 'missing')).toBeNull()
  })

  it('hydrates reasoningEffort from localStorage when sessions arrive without it', async () => {
    localStorage.setItem(LS_PREFIX + 'rehydrated', 'medium')
    const store = useChatStore()

    // Simulate a fresh session list coming from the server (no reasoningEffort)
    store.sessions = [makeSession('rehydrated')]

    // The watcher fires asynchronously; flush microtasks
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.sessions[0].reasoningEffort).toBe('medium')
  })
})
