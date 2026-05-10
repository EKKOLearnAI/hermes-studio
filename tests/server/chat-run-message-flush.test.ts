import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB module before importing
const addMessageMock = vi.fn()
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
  getSession: vi.fn(),
  getSessionDetail: vi.fn(),
  getSessionDetailPaginated: vi.fn(),
  createSession: vi.fn(),
  updateSessionStats: vi.fn(),
  useLocalSessionStore: vi.fn(() => false),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailFromDb: vi.fn(),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  ChatContextCompressor: class {},
  countTokens: vi.fn(() => 1),
  SUMMARY_PREFIX: '[Summary] ',
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(),
}))

vi.mock('../../packages/server/src/lib/llm-json', () => ({
  parseLLMJSON: vi.fn(),
  parseToolArguments: vi.fn(),
  parseAnthropicContentArray: vi.fn(),
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => ''),
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: vi.fn(),
}))

// --- Types mirroring chat-run-socket.ts ---

interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  runMarker?: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp: number
  finish_reason?: string | null
}

interface ResponseRunState {
  runMarker?: string
  responseId?: string
  insertedKeys: Set<string>
  toolCalls: Map<string, any>
}

interface SessionState {
  messages: SessionMessage[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  queue: any[]
  responseRun?: ResponseRunState
}

function createSessionState(): SessionState {
  return { messages: [], isWorking: false, events: [], queue: [] }
}

function createRun(runMarker: string): ResponseRunState {
  return { runMarker, insertedKeys: new Set<string>(), toolCalls: new Map<string, any>() }
}

// --- Simulated event handlers (mirroring actual implementation) ---

function applyDelta(state: SessionState, sessionId: string, runMarker: string, deltaText: string) {
  const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
  if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
    last.content += deltaText
  } else {
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      role: 'assistant',
      content: deltaText,
      timestamp: Date.now(),
    })
  }
}

function applyTextDone(state: SessionState, runMarker: string) {
  const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
  if (last?.role === 'assistant' && last.finish_reason == null) {
    last.finish_reason = 'stop'
  }
}

function applyToolCall(state: SessionState, sessionId: string, runMarker: string, callId: string, name: string, args: string) {
  const run = state.responseRun!
  const key = `assistant:${callId}`
  if (!run.insertedKeys.has(key)) {
    run.insertedKeys.add(key)
    const toolCall = { id: callId, type: 'function', function: { name, arguments: args } }
    run.toolCalls.set(callId, toolCall)
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      role: 'assistant',
      content: '',
      tool_calls: [toolCall],
      finish_reason: 'tool_calls',
      timestamp: Date.now(),
    })
  }
}

function applyToolOutput(state: SessionState, sessionId: string, runMarker: string, callId: string, output: string) {
  const run = state.responseRun!
  const key = `tool:${callId}`
  if (!run.insertedKeys.has(key)) {
    run.insertedKeys.add(key)
    const toolName = run.toolCalls.get(callId)?.function?.name || null
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      role: 'tool',
      content: output,
      tool_call_id: callId,
      tool_name: toolName,
      timestamp: Date.now(),
    })
  }
}

/** Mirrors flushResponseRunToDb — writes all non-user messages for this run to DB. */
function flushResponseRunToDb(state: SessionState, sessionId: string) {
  const run = state.responseRun
  if (!run?.runMarker) return
  for (const msg of state.messages) {
    if (msg.runMarker !== run.runMarker) continue
    if (msg.role === 'user') continue
    addMessageMock({
      session_id: sessionId,
      role: msg.role,
      content: msg.content || '',
      tool_call_id: msg.tool_call_id ?? null,
      tool_calls: msg.tool_calls ?? null,
      tool_name: msg.tool_name ?? null,
      finish_reason: msg.finish_reason ?? null,
      timestamp: msg.timestamp,
    })
  }
}

const SID = 'test-session'
const MARKER = 'resp_run_abc123'

describe('chat-run message flush', () => {
  beforeEach(() => {
    addMessageMock.mockClear()
  })

  it('flushes simple text response to DB on normal completion', () => {
    const state = createSessionState()
    state.responseRun = createRun(MARKER)

    state.messages.push({ id: 1, session_id: SID, runMarker: MARKER, role: 'user', content: 'hello', timestamp: 100 })
    applyDelta(state, SID, MARKER, 'Hello! ')
    applyDelta(state, SID, MARKER, 'How can I help?')
    applyTextDone(state, MARKER)

    flushResponseRunToDb(state, SID)

    expect(addMessageMock).toHaveBeenCalledTimes(1)
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: SID,
      role: 'assistant',
      content: 'Hello! How can I help?',
      finish_reason: 'stop',
    }))
  })

  it('flushes tool calls with correct interleaved order', () => {
    const state = createSessionState()
    state.responseRun = createRun(MARKER)

    state.messages.push({ id: 1, session_id: SID, runMarker: MARKER, role: 'user', content: 'search baidu', timestamp: 100 })
    applyDelta(state, SID, MARKER, 'Let me search.')
    applyTextDone(state, MARKER)
    applyToolCall(state, SID, MARKER, 'call_1', 'terminal', '{"cmd":"opencli web read baidu"}')
    applyToolOutput(state, SID, MARKER, 'call_1', '{"output": "百度热搜..."}')
    applyDelta(state, SID, MARKER, 'Here are the results:')
    applyTextDone(state, MARKER)

    flushResponseRunToDb(state, SID)

    expect(addMessageMock).toHaveBeenCalledTimes(4)
    const calls = addMessageMock.mock.calls.map(c => ({ role: c[0].role, hasToolCalls: !!c[0].tool_calls?.length }))
    expect(calls).toEqual([
      { role: 'assistant', hasToolCalls: false },
      { role: 'assistant', hasToolCalls: true },
      { role: 'tool', hasToolCalls: false },
      { role: 'assistant', hasToolCalls: false },
    ])
  })

  it('flushes partial messages on abort (no output_text.done)', () => {
    const state = createSessionState()
    state.responseRun = createRun(MARKER)

    state.messages.push({ id: 1, session_id: SID, runMarker: MARKER, role: 'user', content: 'hello', timestamp: 100 })
    applyDelta(state, SID, MARKER, 'Let me ')
    applyDelta(state, SID, MARKER, 'search...')

    flushResponseRunToDb(state, SID)

    expect(addMessageMock).toHaveBeenCalledTimes(1)
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      content: 'Let me search...',
    }))
  })

  it('does not write user messages (already written by handleRun)', () => {
    const state = createSessionState()
    state.responseRun = createRun(MARKER)

    state.messages.push({ id: 1, session_id: SID, runMarker: MARKER, role: 'user', content: 'user msg', timestamp: 100 })
    state.messages.push({ id: 2, session_id: SID, runMarker: MARKER, role: 'assistant', content: 'reply', timestamp: 101, finish_reason: 'stop' })

    flushResponseRunToDb(state, SID)

    expect(addMessageMock).toHaveBeenCalledTimes(1)
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }))
  })

  it('does not merge separate assistant messages around tool calls', () => {
    const state = createSessionState()
    state.responseRun = createRun(MARKER)

    applyDelta(state, SID, MARKER, 'Text before tool.')
    applyTextDone(state, MARKER)
    applyToolCall(state, SID, MARKER, 'call_1', 'search', '{"q":"test"}')
    applyToolOutput(state, SID, MARKER, 'call_1', 'search results')
    applyDelta(state, SID, MARKER, 'Text after tool.')
    applyTextDone(state, MARKER)

    flushResponseRunToDb(state, SID)

    const assistantTextCalls = addMessageMock.mock.calls
      .filter(c => c[0].role === 'assistant' && !c[0].tool_calls?.length)

    expect(assistantTextCalls).toHaveLength(2)
    expect(assistantTextCalls[0][0].content).toBe('Text before tool.')
    expect(assistantTextCalls[1][0].content).toBe('Text after tool.')
  })

  it('handles text → tool → text without output_text.done between them', () => {
    // Scenario: only one output_text.done at the very end, not between blocks
    const state = createSessionState()
    state.responseRun = createRun(MARKER)

    // First text block via deltas, NO output_text.done yet
    applyDelta(state, SID, MARKER, '没卡，刚搜完。')
    applyToolCall(state, SID, MARKER, 'call_1', 'browser', '{"url":"..."}')
    applyToolOutput(state, SID, MARKER, 'call_1', '')
    // Second text block via deltas
    applyDelta(state, SID, MARKER, '搜到了！详情如下：')
    // Now output_text.done fires — only marks finish_reason, does NOT overwrite
    applyTextDone(state, MARKER)

    flushResponseRunToDb(state, SID)

    const assistantTextCalls = addMessageMock.mock.calls
      .filter(c => c[0].role === 'assistant' && !c[0].tool_calls?.length)

    // Must have 2 separate text messages, NOT merged
    expect(assistantTextCalls).toHaveLength(2)
    expect(assistantTextCalls[0][0].content).toBe('没卡，刚搜完。')
    expect(assistantTextCalls[1][0].content).toBe('搜到了！详情如下：')
  })

  it('multiple tool calls with text between them stay separated', () => {
    const state = createSessionState()
    state.responseRun = createRun(MARKER)

    applyDelta(state, SID, MARKER, 'Text A.')
    applyTextDone(state, MARKER)
    applyToolCall(state, SID, MARKER, 'call_1', 'search', '{}')
    applyToolOutput(state, SID, MARKER, 'call_1', 'result1')
    applyDelta(state, SID, MARKER, 'Text B.')
    applyTextDone(state, MARKER)
    applyToolCall(state, SID, MARKER, 'call_2', 'search', '{}')
    applyToolOutput(state, SID, MARKER, 'call_2', 'result2')
    applyDelta(state, SID, MARKER, 'Text C.')
    applyTextDone(state, MARKER)

    flushResponseRunToDb(state, SID)

    const textCalls = addMessageMock.mock.calls
      .filter(c => c[0].role === 'assistant' && !c[0].tool_calls?.length)
      .map(c => c[0].content)

    expect(textCalls).toEqual(['Text A.', 'Text B.', 'Text C.'])
  })
})
