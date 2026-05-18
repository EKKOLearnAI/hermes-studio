// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const switchModelMock = vi.hoisted(() => vi.fn())
const startRunViaSocketMock = vi.hoisted(() => vi.fn(() => ({ abort: vi.fn() })))
const fetchSessionMock = vi.hoisted(() => vi.fn())
const resumeSessionMock = vi.hoisted(() => vi.fn((_sessionId: string, onResumed: (data: any) => void) => {
  onResumed({ messages: [], isWorking: false, events: [] })
  return { disconnect: vi.fn() }
}))

vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => ''),
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    selectedModel: 'default-model',
    selectedProvider: 'default-provider',
    switchModel: switchModelMock,
  }),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: startRunViaSocketMock,
  resumeSession: resumeSessionMock,
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => null),
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: fetchSessionMock,
  fetchSessions: vi.fn(() => Promise.resolve([])),
}))

import { useChatStore } from '@/stores/hermes/chat'

function setActiveTestSession(store: ReturnType<typeof useChatStore>) {
  store.activeSession = {
    id: 'session-1',
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store user-mode model selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    isUserModeMock.mockReturnValue(false)
    fetchSessionMock.mockResolvedValue(null)
    resumeSessionMock.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ messages: [], isWorking: false, events: [] })
      return { disconnect: vi.fn() }
    })
  })

  it('keeps compact model changes session-local in chat plane user mode', async () => {
    isUserModeMock.mockReturnValue(true)
    const store = useChatStore()
    setActiveTestSession(store)

    await store.switchSessionModel('gpt-5.4', 'openai')

    expect(store.activeSession?.model).toBe('gpt-5.4')
    expect(store.activeSession?.provider).toBe('openai')
    expect(switchModelMock).not.toHaveBeenCalled()
  })

  it('keeps updating the default model outside chat plane user mode', async () => {
    const store = useChatStore()
    setActiveTestSession(store)

    await store.switchSessionModel('gpt-5.4', 'openai')

    expect(switchModelMock).toHaveBeenCalledWith('gpt-5.4', 'openai')
  })

  it('includes the session provider in chat run payloads', async () => {
    const store = useChatStore()
    store.newChat()
    store.activeSession!.model = 'gpt-5.4'
    store.activeSession!.provider = 'openai'

    await store.sendMessage('hello')

    expect(startRunViaSocketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        provider: 'openai',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
    )
  })

  it('stores tool completed output on the visible tool message', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('run a terminal command')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool: 'terminal',
      preview: 'pip install matplotlib numpy Pillow -q',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      output: 'TypeError: FigureCanvasAgg.print_jpg() got an unexpected keyword argument',
      duration: 3.9,
    })

    const toolMessage = store.activeSession!.messages.find(m => m.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolStatus: 'done',
      toolResult: 'TypeError: FigureCanvasAgg.print_jpg() got an unexpected keyword argument',
      toolDuration: 3.9,
    })
  })

  it('does not update an older tool card when broker tool ids repeat across runs', async () => {
    const store = useChatStore()
    store.newChat()
    const sid = store.activeSession!.id
    store.activeSession!.messages = [
      {
        id: 'old-user',
        role: 'user',
        content: 'old command',
        timestamp: Date.now() - 10_000,
      },
      {
        id: 'old-tool',
        role: 'tool',
        content: '',
        timestamp: Date.now() - 9_000,
        toolCallId: 'broker_tool_reused_terminal',
        toolName: 'terminal',
        toolPreview: 'printf OLD',
        toolStatus: 'done',
      },
      {
        id: 'old-assistant',
        role: 'assistant',
        content: 'old done',
        timestamp: Date.now() - 8_000,
      },
    ]

    await store.sendMessage('run a new terminal command')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: sid,
      tool_call_id: 'broker_tool_reused_terminal',
      tool: 'terminal',
      preview: 'printf NEW',
    })
    onEvent({
      event: 'tool.completed',
      session_id: sid,
      tool_call_id: 'broker_tool_reused_terminal',
      output: 'NEW',
      duration: 1.2,
    })

    const oldTool = store.activeSession!.messages.find(m => m.id === 'old-tool')
    const newTool = store.activeSession!.messages.find(m => m.role === 'tool' && m.id !== 'old-tool')

    expect(oldTool).toMatchObject({
      toolPreview: 'printf OLD',
    })
    expect(oldTool?.toolResult).toBeUndefined()
    expect(newTool).toMatchObject({
      toolPreview: 'printf NEW',
      toolResult: 'NEW',
      toolStatus: 'done',
    })
    expect(store.activeSession!.messages.map(m => m.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'tool',
    ])
  })

  it('surfaces empty final output after tool activity as an error', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('use a tool and then fail')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool: 'execute_code',
      preview: 'install dependencies',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      output: 'Deps installed',
      duration: 3.2,
    })
    onEvent({
      event: 'run.completed',
      session_id: store.activeSession!.id,
      output: '',
    })

    const systemMessage = store.activeSession!.messages.find(m => m.role === 'system')
    expect(systemMessage?.content).toContain('no final output after tool activity')
  })

  it('restores historical tool calls from empty assistant envelopes after refresh', async () => {
    const store = useChatStore()
    store.newChat()
    const sessionId = store.activeSession!.id
    fetchSessionMock.mockResolvedValue({
      id: sessionId,
      title: 'tool session',
      messages: [
        {
          id: 1,
          role: 'user',
          content: 'create a doc',
          timestamp: 1,
        },
        {
          id: 2,
          role: 'assistant',
          content: '',
          timestamp: 2,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'lark_cli',
              arguments: '{"cmd":"docx create"}',
            },
          }],
        },
        {
          id: 3,
          role: 'tool',
          content: 'created doc',
          timestamp: 3,
          tool_call_id: 'call-1',
          tool_name: 'lark_cli',
        },
        {
          id: 4,
          role: 'assistant',
          content: 'Done.',
          timestamp: 4,
        },
      ],
    })

    await store.refreshActiveSession()

    const toolMessage = store.activeSession!.messages.find(m => m.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'lark_cli',
      toolCallId: 'call-1',
      toolArgs: '{"cmd":"docx create"}',
      toolResult: 'created doc',
      toolStatus: 'done',
    })
    expect(store.activeSession!.messages.some(m => m.role === 'assistant' && m.content === 'Done.')).toBe(true)
  })

  it('does not treat reasoning-only streaming as a final assistant reply', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('think but do not answer')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'reasoning.delta',
      session_id: store.activeSession!.id,
      delta: 'checking context',
    })
    onEvent({
      event: 'run.completed',
      session_id: store.activeSession!.id,
      output: '',
    })

    const systemMessage = store.activeSession!.messages.find(m => m.role === 'system')
    expect(systemMessage?.content).toContain('Agent returned no output')
  })

  it('keeps a tool run as one thinking message, tool card, then one streamed result message', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('run terminal and answer')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'reasoning.delta',
      session_id: store.activeSession!.id,
      delta: 'I should call the terminal.',
    })
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool_call_id: 'call-terminal-1',
      tool: 'terminal',
      preview: 'printf STREAM_FIXED_OK',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      tool_call_id: 'call-terminal-1',
      output: 'STREAM_FIXED_OK',
      duration: 0.5,
    })
    onEvent({
      event: 'message.delta',
      session_id: store.activeSession!.id,
      delta: 'STREAM_',
    })
    onEvent({
      event: 'message.delta',
      session_id: store.activeSession!.id,
      delta: 'FIXED_OK',
    })
    onEvent({
      event: 'run.completed',
      session_id: store.activeSession!.id,
      output: 'STREAM_FIXED_OK',
    })

    const messages = store.activeSession!.messages
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning: 'I should call the terminal.',
      isStreaming: false,
    })
    expect(messages[2]).toMatchObject({
      role: 'tool',
      toolName: 'terminal',
      toolStatus: 'done',
      toolResult: 'STREAM_FIXED_OK',
    })
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      content: 'STREAM_FIXED_OK',
      isStreaming: false,
    })
    expect(messages[3].reasoning).toBeUndefined()
  })

  it('keeps streamed run failure errors visible after the socket error callback', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('generate a video')
    fetchSessionMock.mockResolvedValue({
      id: store.activeSession!.id,
      title: 'generate a video',
      messages: [{ role: 'user', content: 'generate a video' }],
    })

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    const onError = startRunViaSocketMock.mock.calls[0][3]
    onEvent({
      event: 'run.failed',
      session_id: store.activeSession!.id,
      error: 'HTTP 429: The service may be temporarily overloaded',
    })
    onError(new Error('HTTP 429: The service may be temporarily overloaded'))
    await new Promise(resolve => setTimeout(resolve, 0))

    const systemMessage = store.activeSession!.messages.find(m => m.role === 'system')
    expect(systemMessage?.content).toContain('HTTP 429')
  })

  it('does not let a stale resume response overwrite the currently active session', async () => {
    const callbacks = new Map<string, (data: any) => void>()
    resumeSessionMock.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      callbacks.set(sessionId, onResumed)
      return { disconnect: vi.fn() }
    })

    const store = useChatStore()
    store.newChat()
    const firstId = store.activeSession!.id
    store.newChat()
    const secondId = store.activeSession!.id

    callbacks.get(firstId)!({
      session_id: firstId,
      isWorking: false,
      events: [],
      messages: [{
        id: 1,
        session_id: firstId,
        role: 'assistant',
        content: 'stale first-session reply',
        timestamp: Date.now() / 1000,
      }],
    })

    expect(store.activeSessionId).toBe(secondId)
    expect(store.sessions.find(s => s.id === secondId)?.messages).toEqual([])
    expect(store.sessions.find(s => s.id === firstId)?.messages[0]?.content).toBe('stale first-session reply')
  })
})
