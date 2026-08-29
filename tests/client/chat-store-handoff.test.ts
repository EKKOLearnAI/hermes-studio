// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn((_sessionId: string, cb: (data: any) => void) => {
    cb({ session_id: _sessionId, isWorking: false, messages: [] })
  }),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => ({
  showCompletionNotification: vi.fn(),
}))

vi.mock('@/utils/session-sync', () => ({
  subscribeSessionSync: vi.fn(() => vi.fn()),
  publishSessionSync: vi.fn(),
}))

describe('chat store handoff sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('opens a Hermes handoff session with lineage and workspace metadata', async () => {
    const store = useChatStore()

    store.openHandoffSession({
      id: 'handoff-1',
      title: 'handoff: Codex work',
      source: 'cli',
      agent: 'hermes',
      workspace: '/repo',
      profile: 'research',
    })

    expect(store.sessions[0]).toMatchObject({
      id: 'handoff-1',
      title: 'handoff: Codex work',
      source: 'cli',
      agent: 'hermes',
      workspace: '/repo',
      profile: 'research',
      isLocalOnly: false,
    })
    await vi.waitFor(() => expect(store.activeSessionId).toBe('handoff-1'))
  })

  it('switches to an existing handoff session without duplicating it', async () => {
    const store = useChatStore()
    store.openHandoffSession({
      id: 'handoff-1',
      title: 'handoff: Claude work',
      source: 'cli',
      agent: 'hermes',
    })
    store.openHandoffSession({
      id: 'handoff-1',
      title: 'handoff: Claude work',
      source: 'cli',
      agent: 'hermes',
    })

    expect(store.sessions.filter(session => session.id === 'handoff-1')).toHaveLength(1)
    await vi.waitFor(() => expect(store.activeSessionId).toBe('handoff-1'))
  })
})
