// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
}))

const sessionsApi = vi.hoisted(() => ({
  generateSessionTitle: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
}))

const settingsStore = vi.hoisted(() => ({
  sessionTitleGeneration: { enabled: true, use_chat_model: true, prompt: '' },
  display: { bell_on_complete: false },
}))

const profilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
}))

const appStore = vi.hoisted(() => ({
  modelGroups: [],
  selectedModel: 'gpt-4o',
  selectedProvider: 'openai',
  waitForModelsForRun: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: sessionsApi.deleteSession,
  fetchSession: vi.fn(),
  fetchSessions: sessionsApi.fetchSessions,
  fetchSessionMessagesPage: sessionsApi.fetchSessionMessagesPage,
  generateSessionTitle: sessionsApi.generateSessionTitle,
  setSessionModel: sessionsApi.setSessionModel,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStore,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStore,
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore } from '@/stores/hermes/chat'

describe('chat store title generation timing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    appStore.waitForModelsForRun.mockResolvedValue(undefined)
    chatApi.resumeSession.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: 'session-1',
        messages: [],
        isWorking: false,
        events: [],
      })
      return {} as any
    })
  })

  it('sets the standard first-message title immediately without generating an AI title', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'default', provider: 'openai', model: 'gpt-4o' })
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Plan a trip to Kyoto', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Sure — I can help.', timestamp: 2 },
    ] as any
    session.title = ''
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('Also include Osaka')

    expect(session.title).toBe('Plan a trip to Kyoto')
    expect(sessionsApi.generateSessionTitle).not.toHaveBeenCalled()
  })

  it('does not orchestrate AI title generation from the client after run completion', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'default', provider: 'openai', model: 'gpt-4o' })
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('Plan a trip to Kyoto and Osaka')
    expect(session.title).toBe('Plan a trip to Kyoto and Osaka')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1]
    onEvent({ event: 'run.completed', output: 'Sure — here is an itinerary.', queue_remaining: 0 })

    await vi.waitFor(() => {
      expect(sessionsApi.generateSessionTitle).not.toHaveBeenCalled()
    })
    expect(session.title).toBe('Plan a trip to Kyoto and Osaka')
  })

  it('applies the server-generated title from the run.completed payload', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'default', provider: 'openai', model: 'gpt-4o' })
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('Plan a trip to Kyoto')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1]
    onEvent({
      event: 'run.completed',
      output: 'Sure — here is an itinerary.',
      queue_remaining: 0,
      title_generation: { ok: true, applied: true, title: 'Kyoto Osaka' },
    })

    await vi.waitFor(() => {
      expect(session.title).toBe('Kyoto Osaka')
    })
    expect(sessionsApi.generateSessionTitle).not.toHaveBeenCalled()
  })
})
