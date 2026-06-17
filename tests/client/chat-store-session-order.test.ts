// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'
import { fetchSessions } from '@/api/hermes/sessions'

vi.mock('@/api/hermes/sessions', () => ({
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
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
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
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

function makeSession(id: string, times: Partial<{ started_at: number; ended_at: number | null; last_active: number }>) {
  return {
    id,
    profile: 'default',
    source: 'cli',
    title: id,
    preview: '',
    started_at: times.started_at ?? 1,
    ended_at: times.ended_at ?? null,
    last_active: times.last_active,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    model: 'gpt-test',
    provider: 'test',
  }
}

describe('chat session ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('orders sessions by the newest known activity timestamp, including started_at', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('older-active-session', { started_at: 100, last_active: 900 }),
        makeSession('new-session-with-stale-last-active', { started_at: 1000, last_active: 200 }),
      ] as any)
      .mockResolvedValueOnce([])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual([
      'new-session-with-stale-last-active',
      'older-active-session',
    ])
    expect(store.sessions[0].updatedAt).toBe(1000_000)
  })
})
