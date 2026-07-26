import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const getSessionMock = vi.hoisted(() => vi.fn())
const createSessionMock = vi.hoisted(() => vi.fn())
const addMessageMock = vi.hoisted(() => vi.fn())
const updateSessionMock = vi.hoisted(() => vi.fn())
const updateSessionStatsMock = vi.hoisted(() => vi.fn())
const resolveBridgeRunModelConfigMock = vi.hoisted(() => vi.fn())
const agentRunMock = vi.hoisted(() => vi.fn())
const agentEstimateContextMock = vi.hoisted(() => vi.fn(async () => ({ contextTokens: 5_000 })))
const getGlobalEkkoAgentMock = vi.hoisted(() => vi.fn(() => ({
  run: agentRunMock,
  estimateContext: agentEstimateContextMock,
})))
const buildCompressedHistoryMock = vi.hoisted(() => vi.fn())
const recordSessionUsageMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/model-config', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/run-chat/compression')>()
  return {
    ...actual,
    buildCompressedHistory: buildCompressedHistoryMock,
  }
})

vi.mock('../../packages/server/src/services/ekko-agent/manager', () => ({
  getGlobalEkkoAgent: getGlobalEkkoAgentMock,
}))

vi.mock('../../packages/server/src/services/ekko-agent/mcp', () => ({
  resolveEkkoMcpServers: vi.fn(() => undefined),
}))

vi.mock('../../packages/ekko-agent/src', () => ({
  createModelClient: vi.fn(() => ({
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
  })),
  resolveModelProviderConfigs: vi.fn(() => ({
    providerConfig: {
      provider: 'test',
      model: 'ekko-test-model',
      apiMode: 'chat_completions',
    },
  })),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
}))

vi.mock('../../packages/server/src/services/hermes/pet-state-socket', () => ({
  observeRunChatPetEvent: vi.fn(),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/usage-recorder', () => ({
  recordSessionUsage: recordSessionUsageMock,
}))

function makeHarness() {
  const roomTarget = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => roomTarget),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    join: vi.fn(),
    emit: vi.fn(),
    to: vi.fn(() => roomTarget),
  }
  const state = {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
    inputTokens: 10,
    outputTokens: 5,
  }
  const sessionMap = new Map<string, any>([['session-1', state]])
  const events: Array<{ event: string; payload: any }> = []
  return { nsp, socket, sessionMap, state, events }
}

describe('ekko-agent context usage events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentEstimateContextMock.mockResolvedValue({ contextTokens: 5_000 })
    buildCompressedHistoryMock.mockImplementation(async (
      sessionId: string,
      _profile: string,
      _upstream: string,
      _apiKey: string | undefined,
      _emit: unknown,
      sessionMap: Map<string, any>,
      _modelContext: unknown,
      _contextEstimator: unknown,
      _currentInputTokens: number,
      excludeLastUser: boolean,
    ) => {
      const messages = (sessionMap.get(sessionId)?.messages || [])
        .filter((message: any) => ['user', 'assistant', 'tool'].includes(message.role))
      if (!excludeLastUser) return messages
      const latestUserIndex = messages.findLastIndex((message: any) => message.role === 'user')
      return latestUserIndex < 0 ? messages : messages.slice(0, latestUserIndex)
    })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'ekko-agent',
      model: 'ekko-test-model',
      provider: 'test-provider',
      workspace: '/tmp/workspace',
    })
    addMessageMock.mockReturnValue(1)
    resolveBridgeRunModelConfigMock.mockResolvedValue({
      model: 'ekko-test-model',
      provider: 'test-provider',
    })
  })

  it('does not publish step context estimates as formal usage updates', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-1', maxSteps: 3 })
      input.onEvent({
        type: 'context.estimated',
        runId: 'run-1',
        step: 1,
        estimate: {
          contextTokens: 10_000,
          systemPromptTokens: 1_000,
          messageTokens: 2_000,
          toolTokens: 7_000,
          modelContextTokens: 0,
          messageCount: 2,
          toolCount: 5,
        },
      })
      input.onEvent({
        type: 'context.estimated',
        runId: 'run-1',
        step: 2,
        estimate: {
          contextTokens: 30_000,
          systemPromptTokens: 1_000,
          messageTokens: 22_000,
          toolTokens: 7_000,
          modelContextTokens: 0,
          messageCount: 4,
          toolCount: 5,
        },
      })
      input.onEvent({
        type: 'model.usage',
        runId: 'run-1',
        step: 2,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 1,
          reasoningTokens: 1,
        },
      })
      return {
        runId: 'run-1',
        output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 30_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(events.filter(item => item.event === 'context.estimated').map(item => item.payload.contextTokens)).toEqual([
      10_000,
      30_000,
    ])
    const usageEvents = events.filter(item => item.event === 'usage.updated')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].payload).toEqual(expect.objectContaining({
      input_tokens: 13,
      output_tokens: 7,
      total_tokens: 20,
      contextTokens: 30_000,
    }))
    expect(state.contextTokens).toBe(30_000)
    expect(recordSessionUsageMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1:step:2:call:1',
      source: 'ekko_agent',
      agent: 'ekko_agent',
      usageScope: 'model_call',
      apiCalls: 1,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 1,
        reasoningTokens: 1,
      },
      profile: 'default',
      model: 'ekko-test-model',
      provider: 'test-provider',
      isEstimated: false,
    })
    const runInput = agentRunMock.mock.calls[0][0]
    expect(getGlobalEkkoAgentMock).toHaveBeenCalledWith('/tmp/hermes-default/skills')
    runInput.onMemoryUsage({
      purpose: 'ekko-memory-summary',
      usage: { inputTokens: 21, outputTokens: 4, cacheReadTokens: 7 },
      model: 'ekko-summary-model',
      callIndex: 1,
    })
    expect(recordSessionUsageMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: expect.stringMatching(/^memory-summary:.+:call:1$/),
      source: 'ekko_agent',
      agent: 'ekko_agent',
      usageScope: 'model_call',
      purpose: 'ekko-memory-summary',
      apiCalls: 1,
      usage: { inputTokens: 21, outputTokens: 4, cacheReadTokens: 7 },
      profile: 'default',
      model: 'ekko-summary-model',
      provider: 'test-provider',
      isEstimated: false,
    })
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: null,
      end_reason: null,
      last_active: expect.any(Number),
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: expect.any(Number),
      end_reason: 'complete',
    }))
  })

  it('publishes the workspace when a new Ekko session is persisted', async () => {
    getSessionMock.mockReturnValueOnce(null)
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'create a file',
      coding_agent_id: 'ekko-agent',
      workspace: '/tmp/new-workspace',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      agent: 'ekko-agent',
      workspace: '/tmp/new-workspace',
    }))
    expect(events).toContainEqual({
      event: 'session.workspace.updated',
      payload: {
        event: 'session.workspace.updated',
        session_id: 'session-1',
        workspace: '/tmp/new-workspace',
      },
    })
  })

  it('loads frontend image blocks into ephemeral model content parts without storing base64', async () => {
    const imagePath = join(process.cwd(), 'packages/client/public/coding-agents/ekko-agent.png')
    const expectedBase64 = (await readFile(imagePath)).toString('base64')
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'image understood', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image', name: 'ekko-agent.png', path: imagePath, media_type: 'image/png' },
      ],
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    const runInput = agentRunMock.mock.calls[0][0]
    expect(runInput.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Describe this image.'),
        contentParts: [{
          type: 'image',
          mimeType: 'image/png',
          data: expectedBase64,
        }],
      }),
    ])
    const storedUserMessage = addMessageMock.mock.calls.find(call => call[0]?.role === 'user')?.[0]
    expect(storedUserMessage?.content).toContain(imagePath)
    expect(storedUserMessage?.content).not.toContain(expectedBase64)
  })

  it('uses externally compressed history and Ekko fixed-context estimates', async () => {
    buildCompressedHistoryMock.mockImplementationOnce(async (
      _sessionId: string,
      _profile: string,
      _upstream: string,
      _apiKey: string | undefined,
      _emit: unknown,
      _sessionMap: Map<string, any>,
      _modelContext: unknown,
      contextEstimator: (_messages: unknown[], messageTokens: number) => Promise<number>,
    ) => {
      expect(await contextEstimator([], 123)).toBe(5_123)
      return [{
        role: 'user',
        content: '[CONTEXT COMPACTION — REFERENCE ONLY]\n\nsummary',
      }]
    })
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'continued', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 6_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'continue from the checkpoint',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentEstimateContextMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: [],
      memoryEnabled: false,
      model: 'ekko-test-model',
    }))
    expect(agentRunMock.mock.calls[0][0].messages).toEqual([
      {
        role: 'user',
        content: '[CONTEXT COMPACTION — REFERENCE ONLY]\n\nsummary',
      },
      {
        role: 'user',
        content: 'continue from the checkpoint',
      },
    ])
    expect(buildCompressedHistoryMock).toHaveBeenCalledWith(
      'session-1',
      'default',
      '',
      undefined,
      expect.any(Function),
      sessionMap,
      {
        model: 'ekko-test-model',
        provider: 'test-provider',
        allowHermesFallback: false,
      },
      expect.any(Function),
      expect.any(Number),
      true,
    )
  })

  it('includes paired tool results in Ekko history for follow-up turns', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'follow-up done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state } = makeHarness()
    state.messages = [
      {
        id: 1,
        session_id: 'session-1',
        role: 'user',
        content: 'check weather',
        timestamp: 1000,
      },
      {
        id: 2,
        session_id: 'session-1',
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_weather',
          type: 'function',
          function: {
            name: 'browser_navigate',
            arguments: '{"url":"https://weather.example"}',
          },
        }],
        timestamp: 1001,
      },
      {
        id: 3,
        session_id: 'session-1',
        role: 'tool',
        content: '{"forecast":"sunny"}',
        tool_call_id: 'call_weather',
        tool_name: 'browser_navigate',
        timestamp: 1002,
      },
      {
        id: 4,
        session_id: 'session-1',
        role: 'tool',
        content: 'orphan result',
        tool_call_id: 'call_orphan',
        tool_name: 'browser_navigate',
        timestamp: 1003,
      },
    ]

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'thanks',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    const runInput = agentRunMock.mock.calls[0][0]
    expect(runInput.messages).toMatchObject([
      { role: 'user', content: 'check weather' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_weather',
          name: 'browser_navigate',
          arguments: { url: 'https://weather.example' },
          rawArguments: '{"url":"https://weather.example"}',
        }],
      },
      {
        role: 'tool',
        content: '{"forecast":"sunny"}',
        toolCallId: 'call_weather',
        name: 'browser_navigate',
      },
      { role: 'user', content: 'thanks' },
    ])
    expect(runInput.messages.some((message: any) => message.content === 'orphan result')).toBe(false)
  })
})
