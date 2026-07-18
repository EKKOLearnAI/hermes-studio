// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { alignWorkspaceChangeAssistantMessage, attachWorkspaceChangesToExactTurns, useChatStore } from '@/stores/hermes/chat'

const sessionApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(),
}))

const chatApi = vi.hoisted(() => ({
  resumePayload: null as any,
  resumeSession: vi.fn((sessionId: string, callback: (data: any) => void) => {
    callback({ ...chatApi.resumePayload, session_id: sessionId })
    return {} as any
  }),
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
}))

vi.mock('@/api/hermes/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: sessionApi.fetchSessions,
  fetchWorkspaceRunChangesForSession: sessionApi.fetchWorkspaceRunChangesForSession,
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default' }))
vi.mock('@/api/hermes/download', () => ({ getDownloadUrl: (_path: string, name: string) => `/download/${name}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

function summary() {
  return {
    id: 'session-1', profile: 'default', source: 'coding_agent', agent: 'codex', title: 'Turn changes',
    preview: '', started_at: 1, ended_at: 2, last_active: 2, message_count: 4, tool_call_count: 0,
    input_tokens: 0, output_tokens: 0, model: 'gpt-test', provider: 'test',
  }
}

function change(id: string, assistantMessageId?: string) {
  return {
    change_id: id,
    assistant_message_id: assistantMessageId || '',
    session_id: 'session-1', run_id: 'run-1', source: 'run', workspace: '/tmp/repo', workspace_kind: 'git',
    started_at: 1, finished_at: 2, files_changed: 1, additions: 2, deletions: 1,
    truncated: false, total_patch_bytes: 20, created_at: 2,
    files: [{
      id: id === 'change-1' ? 1 : 2, change_id: id, session_id: 'session-1', path: `${id}.ts`, old_path: null,
      change_type: 'modified', additions: 2, deletions: 1, size_before: 1, size_after: 2,
      patch_bytes: 20, truncated: false, binary: false, created_at: 2,
    }],
  }
}

describe('chat workspace diff turn association', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    sessionApi.fetchSessions.mockResolvedValueOnce([summary()]).mockResolvedValueOnce([])
    chatApi.resumePayload = {
      isWorking: false,
      messages: [
        { id: 1, session_id: 'session-1', role: 'user', content: 'first', timestamp: 1 },
        { id: 2, session_id: 'session-1', role: 'assistant', content: 'first done', timestamp: 2 },
        { id: 3, session_id: 'session-1', role: 'user', content: 'second', timestamp: 3 },
        { id: 4, session_id: 'session-1', role: 'assistant', content: 'second done', timestamp: 4 },
      ],
      events: [], queueLength: 0, messageLoadedCount: 4, messageTotal: 4, hasMoreBefore: false,
    }
  })

  it('attaches each persisted change to its exact assistant turn without synthetic cards', async () => {
    sessionApi.fetchWorkspaceRunChangesForSession.mockResolvedValue([
      change('change-1', '2'),
      change('change-2', '4'),
      change('change-3', '4'),
    ])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSession?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(store.activeSession?.messages.find(message => message.id === '2')?.workspaceChanges?.map(item => item.change_id)).toEqual([
      'change-1',
    ])
    expect(store.activeSession?.messages.find(message => message.id === '4')?.workspaceChanges?.map(item => item.change_id)).toEqual([
      'change-2',
      'change-3',
    ])
  })

  it('preserves tool-call workspace change restoration alongside turn associations', async () => {
    chatApi.resumePayload.messages.splice(3, 0, {
      id: 5,
      session_id: 'session-1',
      role: 'tool',
      content: 'workspace result',
      tool_call_id: 'tool-change',
      timestamp: 3.5,
    })
    sessionApi.fetchWorkspaceRunChangesForSession.mockResolvedValue([change('tool-change')])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSession?.messages.find(message => message.toolCallId === 'tool-change')?.toolChange?.change_id)
      .toBe('tool-change')
  })

  it('keeps a standalone timestamp fallback for legacy changes without an assistant id', async () => {
    sessionApi.fetchWorkspaceRunChangesForSession.mockResolvedValue([change('legacy-change')])

    const store = useChatStore()
    await store.loadSessions()

    const legacy = store.activeSession?.messages.find(message => message.id === 'workspace-run-change:legacy-change')
    expect(legacy).toMatchObject({ role: 'tool', toolChange: { change_id: 'legacy-change' } })
  })

  it('aligns a live assistant temporary id with the persisted attribution id', () => {
    const messages = [{
      id: 'temporary-assistant',
      role: 'assistant' as const,
      content: 'third done',
      timestamp: 5,
      isStreaming: false,
    }]
    const attributedChange = change('change-live', '42')

    expect(alignWorkspaceChangeAssistantMessage(messages, attributedChange, 'temporary-assistant')).toBe('42')
    expect(messages[0].id).toBe('42')
    expect(attachWorkspaceChangesToExactTurns(messages, [attributedChange])).toEqual([])
    expect(messages[0].workspaceChanges?.map(item => item.change_id)).toEqual(['change-live'])
  })

  it('moves an unresolved explicit association from fallback to the assistant after pagination loads it', () => {
    const unresolved = change('change-page-1', '2')
    const messages = [
      { id: '4', role: 'assistant' as const, content: 'newer', timestamp: 4 },
    ]

    expect(attachWorkspaceChangesToExactTurns(messages, [unresolved])).toEqual([unresolved])

    messages.unshift({ id: '2', role: 'assistant', content: 'older', timestamp: 2 })
    expect(attachWorkspaceChangesToExactTurns(messages, [unresolved])).toEqual([])
    expect(messages[0].workspaceChanges?.map(item => item.change_id)).toEqual(['change-page-1'])
  })

  it('does not overwrite existing tool-message change metadata while recomputing turn associations', () => {
    const existing = change('tool-change')
    const messages = [{
      id: 'tool-1', role: 'tool' as const, content: '', timestamp: 1, toolChange: existing,
    }]

    attachWorkspaceChangesToExactTurns(messages, [change('turn-change', '42')])

    expect(messages[0].toolChange).toBe(existing)
    expect(messages[0].workspaceChanges).toEqual([])
  })
})
