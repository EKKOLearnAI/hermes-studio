// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockChatApi = vi.hoisted(() => ({
  startRun: vi.fn(),
  streamRunEvents: vi.fn(),
}))

const mockSessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => mockChatApi)
vi.mock('@/api/hermes/sessions', () => mockSessionsApi)

import { useChatStore } from '@/stores/hermes/chat'

function makeSummary(id: string, title = 'Session') {
  return {
    id,
    source: 'api_server',
    model: 'gpt-4o',
    title,
    started_at: 1710000000,
    ended_at: 1710000001,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'openai',
    estimated_cost_usd: 0,
    actual_cost_usd: 0,
    cost_status: 'estimated',
  }
}

function makeDetail(id: string, messages: Array<Record<string, any>>, overrides: Record<string, any> = {}) {
  return {
    ...makeSummary(id),
    ...overrides,
    messages,
  }
}

function makeHermesMessage(
  id: number,
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
  overrides: Record<string, any> = {},
) {
  return {
    id,
    session_id: overrides.session_id || 'sess-1',
    role,
    content,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    timestamp: 1710000000 + id,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    ...overrides,
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

const PROFILE = 'default'
const ACTIVE_SESSION_KEY = `hermes_active_session_${PROFILE}`
const SESSIONS_CACHE_KEY = `hermes_sessions_cache_v1_${PROFILE}`
const LEGACY_ACTIVE_SESSION_KEY = 'hermes_active_session'
const LEGACY_SESSIONS_CACHE_KEY = 'hermes_sessions_cache_v1'
const sessionMessagesKey = (sessionId: string) => `hermes_session_msgs_v1_${PROFILE}_${sessionId}_`
const inFlightKey = (sessionId: string) => `hermes_in_flight_v1_${PROFILE}_${sessionId}`
const legacySessionMessagesKey = (sessionId: string) => `hermes_session_msgs_v1_${sessionId}`

describe('Chat Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useRealTimers()
    window.localStorage.clear()
    mockSessionsApi.fetchSessions.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue(null)
    mockSessionsApi.deleteSession.mockResolvedValue(true)
    mockSessionsApi.renameSession.mockResolvedValue(true)
    mockChatApi.startRun.mockResolvedValue({ run_id: 'run-1', status: 'queued' })
    mockChatApi.streamRunEvents.mockImplementation(() => ({
      abort: vi.fn(),
    }))
  })

  it('hydrates cached active session immediately and preserves local-only sessions after refresh', async () => {
    const cachedSession = {
      id: 'local-1',
      title: 'Local Draft',
      source: 'api_server',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const cachedMessages = [
      { id: 'm1', role: 'user', content: 'draft', timestamp: 1 },
    ]

    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'local-1')
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([cachedSession]))
    window.localStorage.setItem(sessionMessagesKey('local-1'), JSON.stringify(cachedMessages))
    // Mark local-1 as in-flight so loadSessions preserves it
    window.localStorage.setItem(inFlightKey('local-1'), JSON.stringify({ runId: 'run-1', startedAt: Date.now() }))

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('remote-1', 'Remote Session')])
    mockSessionsApi.fetchSession.mockResolvedValue(null)

    const store = useChatStore()
    const loadPromise = store.loadSessions()

    expect(store.activeSessionId).toBe('local-1')
    expect(store.messages.map(m => m.content)).toEqual(['draft'])

    await loadPromise

    expect(store.sessions.map(s => s.id)).toEqual(['local-1', 'remote-1'])
    expect(store.activeSession?.id).toBe('local-1')
    expect(store.messages.map(m => m.content)).toEqual(['draft'])
  })

  it('persists the user message immediately before any SSE delta arrives', async () => {
    const store = useChatStore()

    await flushPromises()
    await store.sendMessage('hello world')

    const sid = store.activeSessionId
    expect(sid).toBeTruthy()
    expect(window.localStorage.getItem(ACTIVE_SESSION_KEY)).toBe(sid)

    const cachedMessages = JSON.parse(
      window.localStorage.getItem(sessionMessagesKey(sid!)) || '[]',
    )
    expect(cachedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'hello world',
        }),
      ]),
    )
  })

  it('hydrates from default-profile legacy cache and migrates bulky storage to new keys only', async () => {
    const cachedSession = {
      id: 'legacy-1',
      title: 'Legacy Draft',
      source: 'api_server',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const cachedMessages = [
      { id: 'm1', role: 'user', content: 'legacy draft', timestamp: 1 },
    ]

    window.localStorage.setItem(LEGACY_ACTIVE_SESSION_KEY, 'legacy-1')
    window.localStorage.setItem(LEGACY_SESSIONS_CACHE_KEY, JSON.stringify([cachedSession]))
    window.localStorage.setItem(legacySessionMessagesKey('legacy-1'), JSON.stringify(cachedMessages))

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('legacy-1', 'Legacy Draft')])
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail('legacy-1', cachedMessages))

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSessionId).toBe('legacy-1')
    expect(store.messages.map(m => m.content)).toEqual(['legacy draft'])

    expect(window.localStorage.getItem(ACTIVE_SESSION_KEY)).toBe('legacy-1')
    expect(window.localStorage.getItem(SESSIONS_CACHE_KEY)).toBeTruthy()
    expect(window.localStorage.getItem(sessionMessagesKey('legacy-1'))).toBeTruthy()

    expect(window.localStorage.getItem(LEGACY_ACTIVE_SESSION_KEY)).toBeNull()
    expect(window.localStorage.getItem(LEGACY_SESSIONS_CACHE_KEY)).toBeNull()
    expect(window.localStorage.getItem(legacySessionMessagesKey('legacy-1'))).toBeNull()
  })

  it('marks recently active server sessions as live even when this tab did not start the run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T19:00:00.000Z'))

    mockSessionsApi.fetchSessions.mockResolvedValue([
      {
        ...makeSummary('remote-live', 'Remote Live'),
        ended_at: null,
        last_active: Math.floor(Date.now() / 1000) - 60,
      },
      {
        ...makeSummary('remote-idle', 'Remote Idle'),
        ended_at: Math.floor(Date.now() / 1000) - 600,
        last_active: Math.floor(Date.now() / 1000) - 600,
      },
    ])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.isSessionLive('remote-live')).toBe(true)
    expect(store.isSessionLive('remote-idle')).toBe(false)
  })

  it('silently refreshes from server on SSE error instead of appending a fake error bubble', async () => {
    vi.useFakeTimers()

    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-1')
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'sess-1',
          title: 'Recovered Chat',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    )
    window.localStorage.setItem(
      sessionMessagesKey('sess-1'),
      JSON.stringify([
        { id: 'old-user', role: 'user', content: 'old prompt', timestamp: 1 },
      ]),
    )

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('sess-1', 'Recovered Chat')])

    let fetchSessionCalls = 0
    mockSessionsApi.fetchSession.mockImplementation(async () => {
      fetchSessionCalls += 1
      if (fetchSessionCalls === 1) return null
      return makeDetail('sess-1', [
        {
          id: 1,
          session_id: 'sess-1',
          role: 'user',
          content: 'old prompt',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1710000000,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 2,
          session_id: 'sess-1',
          role: 'user',
          content: 'check this',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1710000001,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 3,
          session_id: 'sess-1',
          role: 'assistant',
          content: 'final answer',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1710000002,
          token_count: null,
          finish_reason: 'stop',
          reasoning: null,
        },
      ])
    })

    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      _onEvent: (event: unknown) => void,
      _onDone: () => void,
      onError: (err: Error) => void,
    ) => {
      setTimeout(() => {
        onError(new Error('SSE connection error'))
      }, 0)
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('check this')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    await vi.advanceTimersByTimeAsync(9000)
    await flushPromises()

    expect(store.messages.some(m => m.role === 'system' && m.content.includes('SSE connection error'))).toBe(false)
    expect(store.messages.some(m => m.role === 'assistant' && m.content === 'final answer')).toBe(true)
    expect(store.isRunActive).toBe(false)
    expect(window.localStorage.getItem(inFlightKey('sess-1'))).toBeNull()
  })

  it('keeps colon deltas before and after a tool boundary', async () => {
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      onEvent: (event: any) => void,
    ) => {
      onEvent({ event: 'message.delta', delta: '让我直接读文件：' })
      onEvent({ event: 'tool.started', tool: 'read_file', preview: 'notes.md' })
      onEvent({ event: 'tool.completed' })
      onEvent({ event: 'message.delta', delta: '读取后结论: final' })
      onEvent({ event: 'run.completed' })
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('check file')
    await flushPromises()

    const assistantText = store.messages
      .filter(m => m.role === 'assistant')
      .map(m => m.content)
      .join('')
    expect(assistantText).toBe('让我直接读文件：读取后结论: final')
    expect(store.messages.some(m => m.role === 'tool' && m.toolName === 'read_file' && m.toolStatus === 'done')).toBe(true)
  })

  it('renders raw SSE fallback message events as assistant deltas', async () => {
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      onEvent: (event: any) => void,
    ) => {
      onEvent({ event: 'message', delta: '原因：raw fallback' })
      onEvent({ event: 'run.completed' })
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('raw stream')
    await flushPromises()

    expect(store.messages.some(m => m.role === 'assistant' && m.content === '原因：raw fallback')).toBe(true)
  })

  it('does not stop polling when server messages are stable but the session is still active', async () => {
    vi.useFakeTimers()

    let fetchSessionCalls = 0
    mockSessionsApi.fetchSession.mockImplementation(async () => {
      fetchSessionCalls += 1
      if (fetchSessionCalls === 1) return null
      return makeDetail('sess-1', [
        makeHermesMessage(1, 'user', 'tool gap prompt'),
        makeHermesMessage(2, 'assistant', '让我直接读文件：'),
      ], { ended_at: null })
    })

    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      onEvent: (event: any) => void,
      _onDone: () => void,
      onError: (err: Error) => void,
    ) => {
      onEvent({ event: 'message.delta', delta: '让我直接读文件：' })
      setTimeout(() => onError(new Error('SSE connection error')), 0)
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('tool gap prompt')
    const sid = store.activeSessionId!

    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(9000)
    await flushPromises()

    expect(window.localStorage.getItem(inFlightKey(sid))).toBeTruthy()
    expect(store.isRunActive).toBe(true)
  })

  it('reconciles the final session after run.completed to recover missed deltas', async () => {
    let fetchSessionCalls = 0
    mockSessionsApi.fetchSession.mockImplementation(async () => {
      fetchSessionCalls += 1
      if (fetchSessionCalls === 1) return null
      return makeDetail('sess-1', [
        makeHermesMessage(1, 'user', 'finish prompt'),
        makeHermesMessage(2, 'assistant', '让我直接读文件：读取后结论：完整回答'),
      ], { ended_at: 1710000010 })
    })

    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      onEvent: (event: any) => void,
    ) => {
      onEvent({ event: 'message.delta', delta: '让我直接读文件：' })
      onEvent({ event: 'run.completed' })
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('finish prompt')
    await flushPromises()

    expect(store.messages.some(m => m.role === 'assistant' && m.content === '让我直接读文件：读取后结论：完整回答')).toBe(true)
  })

  it('does not replace longer local tool-boundary text with a stale shorter final fetch', async () => {
    let fetchSessionCalls = 0
    const stalePrefix = '让我直接读文件：较长的工具前说明'
    mockSessionsApi.fetchSession.mockImplementation(async () => {
      fetchSessionCalls += 1
      if (fetchSessionCalls === 1) return null
      return makeDetail('sess-1', [
        makeHermesMessage(1, 'user', 'stale prompt'),
        makeHermesMessage(2, 'assistant', stalePrefix),
      ], { ended_at: 1710000010 })
    })

    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      onEvent: (event: any) => void,
    ) => {
      onEvent({ event: 'message.delta', delta: stalePrefix })
      onEvent({ event: 'tool.started', tool: 'read_file', preview: 'notes.md' })
      onEvent({ event: 'tool.completed' })
      onEvent({ event: 'message.delta', delta: 'OK' })
      onEvent({ event: 'run.completed' })
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('stale prompt')
    await flushPromises()

    const assistantText = store.messages
      .filter(m => m.role === 'assistant')
      .map(m => m.content)
      .join('')
    expect(assistantText).toBe(`${stalePrefix}OK`)
    expect(store.messages.some(m => m.role === 'tool' && m.toolStatus === 'done')).toBe(true)
  })

  it('does not let delayed completion reconciliation clear a newer in-flight run', async () => {
    let resolveReconcile: ((detail: any) => void) | null = null
    const reconcilePromise = new Promise<any>(resolve => { resolveReconcile = resolve })
    mockSessionsApi.fetchSession.mockImplementation(() => reconcilePromise)
    mockChatApi.startRun
      .mockResolvedValueOnce({ run_id: 'run-1', status: 'queued' })
      .mockResolvedValueOnce({ run_id: 'run-2', status: 'queued' })
    let firstRunEvent: ((event: any) => void) | null = null
    mockChatApi.streamRunEvents.mockImplementation((
      runId: string,
      onEvent: (event: any) => void,
    ) => {
      if (runId === 'run-1') firstRunEvent = onEvent
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('first')
    firstRunEvent!({ event: 'run.completed' })
    await flushPromises()
    const sid = store.activeSessionId!
    await store.sendMessage('second')

    expect(JSON.parse(window.localStorage.getItem(inFlightKey(sid)) || '{}').runId).toBe('run-2')

    resolveReconcile!(makeDetail(sid, [
      makeHermesMessage(1, 'user', 'first', { session_id: sid }),
      makeHermesMessage(2, 'assistant', 'first done', { session_id: sid }),
    ], { ended_at: 1710000010 }))
    await flushPromises()

    expect(JSON.parse(window.localStorage.getItem(inFlightKey(sid)) || '{}').runId).toBe('run-2')
  })
})
