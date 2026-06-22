import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSystemPromptMock = vi.fn()
const getSessionMock = vi.fn()
const createSessionMock = vi.fn()
const addMessageMock = vi.fn()
const updateSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const updateUsageMock = vi.fn()
const buildCompressedHistoryMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn(async (_sessionId: string, _profile: string, history: any[]) => history)
const pushStateMock = vi.fn()
const replaceStateMock = vi.fn()
const forceCompressBridgeHistoryMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, contextTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
  state.contextTokens = contextTokens
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens,
  })
  return contextTokens
})
const getCachedBridgeContextOverheadMock = vi.fn(() => undefined)
const contextTokensWithCachedOverheadMock = vi.fn((_state: any, messageTokens: number) => messageTokens)
const updateMessageContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => updateContextTokenUsageMock(sid, state, emit, messageTokens, usage))
const flushBridgePendingToDbMock = vi.fn()
const ensureOpenBridgeAssistantMessageMock = vi.fn()
const syncBridgeReasoningToMessageMock = vi.fn()
const recordBridgeToolStartedMock = vi.fn()
const recordBridgeToolCompletedMock = vi.fn()
const resolveBridgeRunModelConfigMock = vi.fn()
const issueModelRunJwtMock = vi.fn(async () => 'model-run-token')
const homes: string[] = []

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  buildCompressedHistory: buildCompressedHistoryMock,
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  pushState: pushStateMock,
  replaceState: replaceStateMock,
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  getCachedBridgeContextOverhead: getCachedBridgeContextOverheadMock,
  contextTokensWithCachedOverhead: contextTokensWithCachedOverheadMock,
  updateContextTokenUsage: updateContextTokenUsageMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
  ensureOpenBridgeAssistantMessage: ensureOpenBridgeAssistantMessageMock,
  syncBridgeReasoningToMessage: syncBridgeReasoningToMessageMock,
  recordBridgeToolStarted: recordBridgeToolStartedMock,
  recordBridgeToolCompleted: recordBridgeToolCompletedMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/model-config', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-final-context/${profile || 'default'}`,
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  issueModelRunJwt: issueModelRunJwtMock,
}))

function makeSocket() {
  return {
    connected: true,
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    data: {},
  } as any
}

function makeNamespace(emit: ReturnType<typeof vi.fn>) {
  const room = new Set(['socket-1'])
  return {
    adapter: { rooms: new Map([['session:session-1', room]]) },
    to: vi.fn(() => ({ emit })),
  } as any
}

function makeState() {
  return {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
  } as any
}

describe('bridge run final context usage', () => {
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-bridge-run-token-'))
    homes.push(home)
    process.env.HERMES_WEB_UI_HOME = home
    vi.clearAllMocks()
    getSystemPromptMock.mockReturnValue('system prompt')
    issueModelRunJwtMock.mockResolvedValue('model-run-token')
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '' })
    resolveBridgeRunModelConfigMock.mockResolvedValue({ model: 'gpt-test', provider: 'openai' })
    buildCompressedHistoryMock.mockResolvedValue([{ role: 'user', content: 'previous' }])
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ])
    buildSnapshotAwareHistoryMock.mockImplementation(async (_sessionId: string, _profile: string, history: any[]) => history)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 11, outputTokens: 7 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 11, outputTokens: 7 })
    getCachedBridgeContextOverheadMock.mockImplementation((state: any) => {
      const fixed = state?.bridgeContext?.fixedContextTokens
      return typeof fixed === 'number' ? fixed : undefined
    })
    contextTokensWithCachedOverheadMock.mockImplementation((state: any, messageTokens: number) => {
      const fixed = state?.bridgeContext?.fixedContextTokens
      return typeof fixed === 'number' ? fixed + messageTokens : messageTokens
    })
    updateMessageContextTokenUsageMock.mockImplementation((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
      const contextTokens = contextTokensWithCachedOverheadMock(state, messageTokens)
      return updateContextTokenUsageMock(sid, state, emit, contextTokens, usage)
    })
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('refreshes full context tokens when a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).toHaveBeenCalledWith(
      'session-1',
      [],
      expect.not.stringContaining('[Current Hermes profile:'),
      'default',
      { model: 'gpt-test', provider: 'openai' },
    )
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('system prompt')
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('X-Hermes-Profile')
    expect(state.contextTokens).toBe(12345)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('releases working state when the bridge stream ends without a terminal chunk', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          session_id: 'session-1',
          done: false,
          status: 'running',
          delta: 'partial reply',
          cursor: 1,
          output: 'partial reply',
          events: [],
          event_cursor: 0,
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'partial reply',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'partial reply',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('stores a super admin model-run token for the profile without adding it to bridge instructions', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    socket.data.user = { id: 1, username: 'admin', role: 'super_admin' }
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    const instructions = bridge.contextEstimate.mock.calls[0][2]
    expect(issueModelRunJwtMock).toHaveBeenCalledWith({ id: 1, username: 'admin', role: 'super_admin' })
    expect(readFileSync(join(process.env.HERMES_WEB_UI_HOME || '', 'profiles', 'default', '.model-run-token'), 'utf-8').trim()).toBe('model-run-token')
    expect(instructions).not.toContain('[Current Hermes profile:')
    expect(instructions).not.toContain('pass the current Hermes profile as the profile argument')
    expect(instructions).not.toContain('model-run-token')
    expect(instructions).not.toContain('Current Hermes Web UI model run token')
    expect(instructions).not.toContain('token argument')
    expect(instructions).not.toContain('list_mcp_resources')
    expect(instructions).not.toContain('mcp__hermes-studio__')
  })

  it('creates global-agent bridge sessions with source global_agent', async () => {
    getSessionMock.mockReturnValue(undefined)
    addMessageMock.mockReturnValue(42)
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 42,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', source: 'global_agent' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      source: 'global_agent',
      workspace: '/tmp/hermes-bridge-final-context/default/workspace',
    }))
    expect(state.source).toBe('global_agent')
  })

  it('evaluates active goals after a successful bridge run and queues continuation prompts', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn()
    addMessageMock.mockReturnValue(42)
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      goalEvaluate: vi.fn().mockResolvedValue({
        handled: true,
        should_continue: true,
        continuation_prompt: '[Continuing toward your standing goal]\nGoal: fix tests',
        message: '↻ Continuing toward goal (1/20): tests still fail',
        verdict: 'continue',
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'not finished',
          result: { final_response: 'not finished' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: 'hello',
        session_id: 'session-1',
        model_groups: [{ provider: 'openai', models: ['gpt-test'] }],
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    expect(bridge.goalEvaluate).toHaveBeenCalledWith('session-1', 'not finished', 'default')
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-1',
      role: 'command',
      content: '↻ Continuing toward goal (1/20): tests still fail',
    }))
    expect(emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'continue',
      message: '↻ Continuing toward goal (1/20): tests still fail',
    }))
    expect(state.queue).toEqual([expect.objectContaining({
      input: '[Continuing toward your standing goal]\nGoal: fix tests',
      displayInput: null,
      storageMessage: '[Continuing toward your standing goal]\nGoal: fix tests',
      model: 'gpt-test',
      provider: 'openai',
      model_groups: [{ provider: 'openai', models: ['gpt-test'] }],
      goalContinuation: true,
    })])
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1')
  })

  it('skips hidden goal continuation runs without pausing when the judge is unavailable', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn()
    addMessageMock.mockReturnValue(43)
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      command: vi.fn(),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      goalEvaluate: vi.fn().mockResolvedValue({
        handled: true,
        should_continue: true,
        continuation_prompt: '[Continuing toward your standing goal]\nGoal: fix tests',
        message: '↻ Continuing toward goal (1/20): no auxiliary client configured',
        verdict: 'continue',
        reason: 'no auxiliary client configured',
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'done',
          result: { final_response: 'done' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    expect(bridge.command).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(dequeueNextQueuedRun).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'judge_unavailable',
      message: 'Goal judge is not configured; automatic goal continuation was skipped. The goal remains active, but Hermes cannot mark it done automatically.',
    }))
  })

  it('uses cached fixed context instead of bridge estimate when available', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [{
            event: 'bridge.context.ready',
            fixed_context_tokens: 20_000,
            system_prompt_tokens: 3_000,
            tool_tokens: 17_000,
          }],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).not.toHaveBeenCalled()
    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      18,
      { inputTokens: 11, outputTokens: 7 },
    )
    expect(state.contextTokens).toBe(20_018)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      contextTokens: 20_018,
    }))
  })

  it('keeps bridge context ready updates on the snapshot-aware token baseline', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 28_000, outputTokens: 0 })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'very large old context' },
      { role: 'assistant', content: 'large old response' },
      { role: 'user', content: 'hello' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: '[Previous context summary]\n\nsmall summary' },
      { role: 'user', content: 'hello' },
    ])
    estimateUsageTokensFromMessagesMock.mockImplementation((messages: any[]) => {
      if (messages?.[0]?.content?.includes('small summary')) {
        return { inputTokens: 9_000, outputTokens: 0 }
      }
      return { inputTokens: 28_000, outputTokens: 0 }
    })
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [{
            event: 'bridge.context.ready',
            fixed_context_tokens: 10_000,
            system_prompt_tokens: 2_000,
            tool_tokens: 8_000,
          }],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      9_000,
      { inputTokens: 28_000, outputTokens: 0 },
    )
    expect(updateMessageContextTokenUsageMock).not.toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      28_000,
      { inputTokens: 28_000, outputTokens: 0 },
    )
    expect(state.contextTokens).toBe(19_000)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      contextTokens: 19_000,
    }))
  })

  it('persists pending tool marker text before a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const persistedContent: string[] = []
    flushBridgePendingToDbMock.mockImplementation((targetState: any) => {
      persistedContent.push(targetState.bridgePendingAssistantContent || '')
      targetState.bridgePendingAssistantContent = ''
    })
    ensureOpenBridgeAssistantMessageMock.mockImplementation((targetState: any, sessionId: string, runMarker: string) => {
      let message = [...targetState.messages].reverse().find((m: any) => m.runMarker === runMarker && m.role === 'assistant' && m.finish_reason == null)
      if (!message) {
        message = {
          id: targetState.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: '',
          timestamp: Math.floor(Date.now() / 1000),
        }
        targetState.messages.push(message)
      }
      return message
    })
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: false, status: 'running', delta: 'Text [Call', events: [] }
        yield { run_id: 'run-1', done: true, status: 'completed', output: '', events: [] }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(persistedContent).toContain('Text [Call')
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'Text ',
      output: 'Text ',
    }))
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: '[Call',
      output: 'Text [Call',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'Text [Call',
    }))
  })

  it('persists the visible plan command instead of the expanded skill prompt', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'planned' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '[IMPORTANT: expanded plan skill prompt]',
        display_input: '/plan build the feature',
        display_role: 'command',
        storage_message: '/plan build the feature',
        session_id: 'session-1',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.role === 'command')).toEqual(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: '[IMPORTANT: expanded plan skill prompt]',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '[IMPORTANT: expanded plan skill prompt]',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({ storage_message: '/plan build the feature' }),
    )
  })

  it('persists expanded skill prompts as user history with visible command display fields', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '[IMPORTANT: expanded skill prompt]',
        display_input: '/skill github-pr-review check PR 123',
        display_role: 'command',
        storage_message: '[IMPORTANT: expanded skill prompt]',
        session_id: 'session-1',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.content === '[IMPORTANT: expanded skill prompt]')).toEqual(expect.objectContaining({
      role: 'user',
      display_role: 'command',
      display_content: '/skill github-pr-review check PR 123',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: '[IMPORTANT: expanded skill prompt]',
      display_role: 'command',
      display_content: '/skill github-pr-review check PR 123',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '[IMPORTANT: expanded skill prompt]',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({ storage_message: '[IMPORTANT: expanded skill prompt]' }),
    )
  })

  it('refreshes full context tokens when a bridge run fails', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockRejectedValue(new Error('bridge timeout')),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 54321,
        fixed_context_tokens: 54303,
        message_count: 1,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.contextTokens).toBe(54321)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      error: 'bridge timeout',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
  })

  it('emits bridge lifecycle status events so retries are visible', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [
            { event: 'status', kind: 'lifecycle', text: 'Retrying in 3.0s (attempt 1/3)...' },
          ],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(replaceStateMock).toHaveBeenCalledWith(sessionMap, 'session-1', 'agent.event', expect.objectContaining({
      event: 'agent.event',
      kind: 'lifecycle',
      text: 'Retrying in 3.0s (attempt 1/3)...',
    }))
    expect(emit).toHaveBeenCalledWith('agent.event', expect.objectContaining({
      event: 'agent.event',
      kind: 'lifecycle',
      text: 'Retrying in 3.0s (attempt 1/3)...',
    }))
  })
})
