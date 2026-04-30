// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockChatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  connectChatRun: vi.fn(),
  resumeSession: vi.fn(),
}))

const mockSessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchSession: vi.fn(),
  deleteSession: vi.fn(),
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
    last_active: 1710000001,
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

describe('chat attachment context', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    window.localStorage.clear()

    mockSessionsApi.fetchSessions.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue(null)
    mockSessionsApi.deleteSession.mockResolvedValue(true)
    mockChatApi.connectChatRun.mockReturnValue({
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    })
    mockChatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [] })
      return mockChatApi.connectChatRun()
    })
    mockChatApi.startRunViaSocket.mockImplementation((_body: any, _onEvent: any, _onDone: any, _onError: any, onStarted?: (runId: string) => void) => {
      onStarted?.('run-1')
      return { abort: vi.fn() }
    })
  })

  it('sends uploaded file references to the server while keeping the visible user bubble clean', async () => {
    const file = new File(['screenshot-bytes'], 'screenshot.png', { type: 'image/png' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [{ name: 'screenshot.png', path: '/tmp/uploaded-screenshot.png' }] }),
    }))
    window.localStorage.setItem('hermes_api_key', 'test-token')

    const store = useChatStore()
    await store.sendMessage('please inspect this', [{
      id: 'att-1',
      name: 'screenshot.png',
      type: 'image/png',
      size: file.size,
      url: 'blob:screenshot',
      file,
    }])

    expect(mockChatApi.startRunViaSocket).toHaveBeenCalledTimes(1)
    const payload = mockChatApi.startRunViaSocket.mock.calls[0][0]
    expect(payload.input).toContain('please inspect this')
    expect(payload.input).toContain('[File: screenshot.png](/tmp/uploaded-screenshot.png)')
    expect(payload.session_id).toBe(store.activeSessionId)
    expect(payload).not.toHaveProperty('conversation_history')

    expect(store.messages[0].content).toBe('please inspect this')
    expect(store.messages[0].content).not.toContain('[File:')
    expect(store.messages[0].contextContent).toContain('[File: screenshot.png](/tmp/uploaded-screenshot.png)')
    expect(store.messages[0].attachments?.[0]).toEqual(expect.objectContaining({
      name: 'screenshot.png',
      uploadPath: '/tmp/uploaded-screenshot.png',
    }))
    expect(store.messages[0].attachments?.[0].url).toContain('path=%2Ftmp%2Fuploaded-screenshot.png')
    expect(store.messages[0].attachments?.[0].url).not.toContain('token=')
    expect(store.messages[0].attachments?.[0].file).toBeUndefined()
    expect(JSON.stringify(store.messages)).not.toContain('test-token')
  })

  it('converts server-returned upload markdown into hidden context and restored attachments', async () => {
    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('sess-file', 'File Session')])
    window.localStorage.setItem('hermes_api_key', 'restored-token')
    mockChatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        isWorking: false,
        events: [],
        messages: [
          {
            id: 1,
            session_id: sessionId,
            role: 'user',
            content: 'please inspect this\n\n[File: screenshot.png](/tmp/uploaded-screenshot.png)',
            timestamp: 1710000000,
          },
        ],
      })
      return mockChatApi.connectChatRun()
    })

    const store = useChatStore()
    await store.loadSessions()

    expect(store.messages[0].content).toBe('please inspect this')
    expect(store.messages[0].content).not.toContain('[File:')
    expect(store.messages[0].contextContent).toBe('please inspect this\n\n[File: screenshot.png](/tmp/uploaded-screenshot.png)')
    expect(store.messages[0].attachments).toEqual([
      expect.objectContaining({
        name: 'screenshot.png',
        type: 'image/png',
        size: 0,
        uploadPath: '/tmp/uploaded-screenshot.png',
        url: expect.stringContaining('/api/hermes/download?'),
      }),
    ])
    expect(store.messages[0].attachments?.[0].url).not.toContain('token=')
    expect(JSON.stringify(store.messages)).not.toContain('restored-token')
  })
})
