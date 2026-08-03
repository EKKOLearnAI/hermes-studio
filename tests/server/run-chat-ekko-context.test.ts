import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const getSessionMock = vi.hoisted(() => vi.fn())
const createSessionMock = vi.hoisted(() => vi.fn())
const addMessageMock = vi.hoisted(() => vi.fn())
const addMessagesMock = vi.hoisted(() => vi.fn())
const updateMessageDisplayContentMock = vi.hoisted(() => vi.fn(() => true))
const updateSessionMock = vi.hoisted(() => vi.fn())
const updateSessionStatsMock = vi.hoisted(() => vi.fn())
const resolveBridgeRunModelConfigMock = vi.hoisted(() => vi.fn())
const resolveEkkoProviderRuntimeConfigMock = vi.hoisted(() => vi.fn())
const resolveModelProviderConfigsMock = vi.hoisted(() => vi.fn())
const agentRunMock = vi.hoisted(() => vi.fn())
const agentEstimateContextMock = vi.hoisted(() => vi.fn(async () => ({ contextTokens: 5_000 })))
const agentSessionWorkspaceDirectoryMock = vi.hoisted(() => (
  vi.fn((sessionId: string) => `/tmp/ekko-workspace/default/${sessionId}`)
))
const getGlobalEkkoAgentMock = vi.hoisted(() => vi.fn(() => ({
  run: agentRunMock,
  estimateContext: agentEstimateContextMock,
  sessionWorkspaceDirectory: agentSessionWorkspaceDirectoryMock,
})))
const buildCompressedHistoryMock = vi.hoisted(() => vi.fn())
const recordSessionUsageMock = vi.hoisted(() => vi.fn())
const startWorkspaceRunCheckpointMock = vi.hoisted(() => vi.fn())
const completeWorkspaceRunCheckpointMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  addMessages: addMessagesMock,
  updateMessageDisplayContent: updateMessageDisplayContentMock,
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

vi.mock('../../packages/server/src/services/ekko-agent/provider-runtime', () => ({
  resolveEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
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
  resolveModelProviderConfigs: resolveModelProviderConfigsMock,
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

vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: startWorkspaceRunCheckpointMock,
  completeWorkspaceRunCheckpoint: completeWorkspaceRunCheckpointMock,
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
    addMessagesMock.mockImplementation((messages: unknown[]) => messages.map((_, index) => 100 + index))
    resolveBridgeRunModelConfigMock.mockResolvedValue({
      model: 'ekko-test-model',
      provider: 'test-provider',
    })
    resolveEkkoProviderRuntimeConfigMock.mockResolvedValue({
      provider: 'test-provider',
      apiMode: 'chat_completions',
    })
    resolveModelProviderConfigsMock.mockReturnValue({
      providerConfig: {
        provider: 'test',
        model: 'ekko-test-model',
        apiMode: 'chat_completions',
      },
    })
    completeWorkspaceRunCheckpointMock.mockReturnValue(null)
  })

  it('attaches a completed workspace diff to the persisted Ekko assistant message', async () => {
    const change = {
      change_id: 'change-1',
      session_id: 'session-1',
      run_id: 'run-1',
      assistant_message_id: '202',
      files_changed: 1,
      additions: 2,
      deletions: 0,
      files: [],
    }
    addMessageMock
      .mockReturnValueOnce(101)
      .mockReturnValueOnce(202)
    completeWorkspaceRunCheckpointMock.mockReturnValueOnce(change)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-1', maxSteps: 3 })
      return {
        runId: 'run-1',
        output: { role: 'assistant', content: 'done' },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 5_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'edit the file',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(startWorkspaceRunCheckpointMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: '/tmp/workspace',
    })
    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: '/tmp/workspace',
      assistantMessageId: '202',
    })
    expect(events).toContainEqual({
      event: 'workspace.diff.completed',
      payload: expect.objectContaining({
        event: 'workspace.diff.completed',
        run_id: 'run-1',
        change_id: 'change-1',
        change,
      }),
    })
    expect(events).toContainEqual({
      event: 'run.completed',
      payload: expect.objectContaining({
        run_id: 'run-1',
        workspace_run_change: change,
      }),
    })
    expect(events.findIndex(item => item.event === 'workspace.diff.completed'))
      .toBeLessThan(events.findIndex(item => item.event === 'run.completed'))
  }, 15_000)

  it('completes an Ekko workspace diff on run failure without inventing an assistant id', async () => {
    const change = {
      change_id: 'change-failed',
      session_id: 'session-1',
      run_id: 'run-failed',
      assistant_message_id: '',
      files_changed: 1,
      additions: 1,
      deletions: 0,
      files: [],
    }
    completeWorkspaceRunCheckpointMock.mockReturnValueOnce(change)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-failed', maxSteps: 3 })
      throw new Error('provider failed')
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'edit then fail',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      runId: 'run-failed',
      assistantMessageId: null,
    }))
    expect(events).toContainEqual({
      event: 'run.failed',
      payload: expect.objectContaining({
        run_id: 'run-failed',
        workspace_run_change: change,
      }),
    })
  }, 15_000)

  it('completes and publishes an Ekko workspace diff when the run is aborted', async () => {
    const change = {
      change_id: 'change-aborted',
      session_id: 'session-1',
      run_id: 'run-aborted',
      assistant_message_id: '',
      files_changed: 1,
      additions: 1,
      deletions: 0,
      files: [],
    }
    completeWorkspaceRunCheckpointMock.mockReturnValueOnce(change)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-aborted', maxSteps: 3 })
      const error = new Error('Run aborted.')
      error.name = 'AbortError'
      throw error
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'edit until stopped',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({
      event: 'workspace.diff.completed',
      payload: expect.objectContaining({
        run_id: 'run-aborted',
        change,
      }),
    })
    expect(events.some(item => item.event === 'run.completed' || item.event === 'run.failed')).toBe(false)
  }, 15_000)

  it('forwards the selected reasoning effort and requests an automatic summary', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'think carefully',
      coding_agent_id: 'ekko-agent',
      reasoning_effort: 'high',
      background_delegation_enabled: false,
      instructions: 'Keep the spoken response short and use plain text.',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      backgroundDelegationEnabled: false,
      modelDefaults: expect.objectContaining({
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      }),
      messages: expect.arrayContaining([{
        role: 'system',
        content: 'Keep the spoken response short and use plain text.',
      }]),
    }))
  })

  it('uses the Hermes Responses default reasoning effort when none is selected', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'think carefully',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      modelDefaults: expect.objectContaining({
        reasoningEffort: 'medium',
        reasoningSummary: 'auto',
      }),
    }))
  })

  it('preserves an explicit request to disable reasoning', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'answer directly',
      coding_agent_id: 'ekko-agent',
      reasoning_effort: 'none',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'none',
      reasoningSummary: 'auto',
    }))
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
      input.onEvent({
        type: 'skill.review.started',
        runId: 'run-1',
        reviewId: 'review-1',
      })
      input.onEvent({
        type: 'skill.review.completed',
        runId: 'run-1',
        reviewId: 'review-1',
        mutations: 1,
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
    expect(events).toEqual(expect.arrayContaining([
      {
        event: 'skill.review.started',
        payload: {
          event: 'skill.review.started',
          run_id: 'run-1',
          review_id: 'review-1',
          session_id: 'session-1',
        },
      },
      {
        event: 'skill.review.completed',
        payload: {
          event: 'skill.review.completed',
          run_id: 'run-1',
          review_id: 'review-1',
          mutations: 1,
          session_id: 'session-1',
        },
      },
    ]))
    const runInput = agentRunMock.mock.calls[0][0]
    expect(getGlobalEkkoAgentMock).toHaveBeenCalledWith('default')
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
    runInput.onSkillReviewUsage({
      purpose: 'ekko-skill-review',
      usage: { inputTokens: 34, outputTokens: 6, cacheReadTokens: 8 },
      model: 'ekko-review-model',
      callIndex: 1,
    })
    expect(recordSessionUsageMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: expect.stringMatching(/^skill-review:.+:call:1$/),
      source: 'ekko_agent',
      agent: 'ekko_agent',
      usageScope: 'model_call',
      purpose: 'ekko-skill-review',
      apiCalls: 1,
      usage: { inputTokens: 34, outputTokens: 6, cacheReadTokens: 8 },
      profile: 'default',
      model: 'ekko-review-model',
      provider: 'test-provider',
      isEstimated: false,
    })
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

  it('keeps Ekko background subtask state and accounts for late child usage', async () => {
    let runtimeEvent: ((event: any) => void) | undefined
    const dequeueNextQueuedRun = vi.fn(() => false)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      runtimeEvent = input.onEvent
      input.onEvent({ type: 'run.started', runId: 'run-parent', maxSteps: 3 })
      input.onEvent({
        type: 'subagent.start',
        runId: 'run-parent',
        subagentId: 'child-background',
        goal: 'Run validation',
        background: true,
        model: 'ekko-test-model',
        startedAt: 1_000,
      })
      return {
        runId: 'run-parent',
        output: {
          role: 'assistant',
          content: 'Validation is running.',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'run checks in the background',
      coding_agent_id: 'ekko-agent',
      instructions: 'Keep the spoken response short and use plain text.',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, dequeueNextQueuedRun)

    expect(state.backgroundTasks['child-background']).toEqual(expect.objectContaining({
      runtime: 'ekko',
      subagent_id: 'child-background',
      goal: 'Run validation',
      status: 'running',
      last_event: 'subagent.start',
    }))
    expect(state.inputTokens).toBe(13)
    expect(state.outputTokens).toBe(7)
    expect(events).toContainEqual(expect.objectContaining({
      event: 'run.completed',
      payload: expect.objectContaining({
        run_id: 'run-parent',
        background_pending: 1,
      }),
    }))

    runtimeEvent?.({
      type: 'subagent.text',
      runId: 'run-parent',
      childRunId: 'run-child',
      subagentId: 'child-background',
      goal: 'Run validation',
      background: true,
      text: 'All checks\n\n',
    })
    runtimeEvent?.({
      type: 'subagent.text',
      runId: 'run-parent',
      childRunId: 'run-child',
      subagentId: 'child-background',
      goal: 'Run validation',
      background: true,
      text: 'passed.',
    })
    state.messages.push({
      id: 77,
      session_id: 'session-1',
      role: 'tool',
      content: JSON.stringify({
        runtime: 'ekko',
        mode: 'background',
        subagent_id: 'child-background',
        status: 'running',
      }),
      tool_call_id: 'delegate-call',
      tool_name: 'delegate_task',
      timestamp: 1,
    })
    runtimeEvent?.({
      type: 'subagent.complete',
      runId: 'run-parent',
      childRunId: 'run-child',
      subagentId: 'child-background',
      goal: 'Run validation',
      background: true,
      status: 'completed',
      summary: 'All checks passed.',
      output: 'All checks\n\npassed.',
      outputTail: 'All checks\n\npassed.',
      durationMs: 2_500,
      toolCount: 2,
      apiCalls: 2,
      inputTokens: 11,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
    })

    expect(state.backgroundTasks['child-background']).toEqual(expect.objectContaining({
      runtime: 'ekko',
      status: 'completed',
      last_event: 'subagent.complete',
      summary: 'All checks passed.',
      api_calls: 2,
      input_tokens: 11,
      output_tokens: 4,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
      reasoning_tokens: 1,
    }))
    expect(state.inputTokens).toBe(24)
    expect(state.outputTokens).toBe(11)
    expect(updateMessageDisplayContentMock).toHaveBeenCalledWith(
      'session-1',
      77,
      expect.stringContaining('"status":"completed"'),
    )
    expect(state.messages.find(message => message.id === 77)?.display_content)
      .toContain('"runtime":"ekko"')
    expect(dequeueNextQueuedRun).toHaveBeenCalledOnce()
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1', 'default')
    expect(state.queue).toHaveLength(1)
    expect(state.queue[0]).toEqual(expect.objectContaining({
      queue_id: 'ekko_subagent_child-background',
      displayInput: null,
      codingAgentId: 'ekko-agent',
      instructions: 'Keep the spoken response short and use plain text.',
      autonomous: true,
      backgroundDelegationId: 'child-background',
    }))
    expect(state.queue[0].input).toContain('All checks\n\npassed.')
    expect(recordSessionUsageMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-parent:subagent:child-background',
      source: 'ekko_agent',
      agent: 'ekko_agent',
      usageScope: 'model_call',
      purpose: 'ekko-background-subtask',
      apiCalls: 2,
      usage: {
        inputTokens: 11,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
      },
      profile: 'default',
      model: 'ekko-test-model',
      provider: 'test-provider',
      isEstimated: false,
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'subagent.start',
        payload: expect.objectContaining({
          subagent_id: 'child-background',
          background: true,
        }),
      }),
      expect.objectContaining({
        event: 'subagent.complete',
        payload: expect.objectContaining({
          parent_run_id: 'run-parent',
          child_run_id: 'run-child',
          subagent_id: 'child-background',
          status: 'completed',
          summary: 'All checks\n\npassed.',
        }),
      }),
      expect.objectContaining({
        event: 'usage.updated',
        payload: expect.objectContaining({
          input_tokens: 24,
          output_tokens: 11,
          total_tokens: 35,
        }),
      }),
    ]))
  })

  it('queues a completed background result without starting it while the parent run is busy', async () => {
    const dequeueNextQueuedRun = vi.fn(() => false)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-parent', maxSteps: 3 })
      input.onEvent({
        type: 'subagent.start',
        runId: 'run-parent',
        subagentId: 'child-background',
        goal: 'Run validation',
        background: true,
        startedAt: 1_000,
      })
      input.onEvent({
        type: 'subagent.complete',
        runId: 'run-parent',
        childRunId: 'run-child',
        subagentId: 'child-background',
        goal: 'Run validation',
        background: true,
        status: 'completed',
        summary: 'Validation passed.',
        output: 'Validation passed.',
        outputTail: 'Validation passed.',
        durationMs: 500,
        toolCount: 0,
        apiCalls: 1,
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      })
      expect(dequeueNextQueuedRun).not.toHaveBeenCalled()
      return {
        runId: 'run-parent',
        output: {
          role: 'assistant',
          content: 'The background task is running.',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'run checks in the background',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, dequeueNextQueuedRun)

    expect(state.queue).toHaveLength(1)
    expect(dequeueNextQueuedRun).toHaveBeenCalledOnce()
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1', 'default')
  })

  it('marks the parent continuation as an autonomous run for the completed child', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-autonomous', maxSteps: 3 })
      return {
        runId: 'run-autonomous',
        output: {
          role: 'assistant',
          content: 'Validation passed.',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'Background subtask result: Validation passed.',
      display_input: null,
      coding_agent_id: 'ekko-agent',
      queue_id: 'ekko_subagent_child-background',
      autonomous: true,
      background_delegation_id: 'child-background',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false), true)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.started',
        payload: expect.objectContaining({
          run_id: 'run-autonomous',
          autonomous: true,
          delegation_id: 'child-background',
        }),
      }),
      expect.objectContaining({
        event: 'run.completed',
        payload: expect.objectContaining({
          run_id: 'run-autonomous',
          autonomous: true,
          delegation_id: 'child-background',
          background_pending: 0,
        }),
      }),
    ]))
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

    expect(agentSessionWorkspaceDirectoryMock).not.toHaveBeenCalled()
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      agent: 'ekko-agent',
      api_mode: 'chat_completions',
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

  it('keeps MCU Ekko sessions classified as global agent sessions', async () => {
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
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'hello from MCU',
      source: 'coding_agent',
      session_source: 'global_agent',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      source: 'global_agent',
      agent: 'ekko-agent',
      agent_mode: 'scoped',
    }))
  })

  it('migrates an existing Hermes MCU session to Ekko metadata', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'global_agent',
      agent: 'hermes',
      agent_mode: '',
      agent_session_id: '',
      agent_native_session_id: '',
      model: 'ekko-test-model',
      provider: 'test-provider',
      workspace: '/tmp/existing-mcu-workspace',
    })
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'continue on Ekko',
      source: 'coding_agent',
      session_source: 'global_agent',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(createSessionMock).not.toHaveBeenCalled()
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', {
      source: 'global_agent',
      agent: 'ekko-agent',
      agent_mode: 'scoped',
      agent_session_id: '',
      agent_native_session_id: '',
    })
    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      toolContext: expect.objectContaining({
        cwd: '/tmp/existing-mcu-workspace',
        workspaceRoot: '/tmp/existing-mcu-workspace',
      }),
    }))
  })

  it('uses the profile-scoped Ekko session workspace by default', async () => {
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
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    const workspace = '/tmp/ekko-workspace/default/session-1'
    expect(agentSessionWorkspaceDirectoryMock).toHaveBeenCalledWith('session-1')
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      agent: 'ekko-agent',
      workspace,
    }))
    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      toolContext: expect.objectContaining({
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    }))
    expect(events).toContainEqual({
      event: 'session.workspace.updated',
      payload: {
        event: 'session.workspace.updated',
        session_id: 'session-1',
        workspace,
      },
    })
  })

  it('loads and persists the configured API mode when the session and request omit it', async () => {
    getSessionMock.mockReturnValueOnce({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'ekko-agent',
      model: 'ekko-test-model',
      provider: 'custom:fun-codex',
      api_mode: '',
      workspace: '/tmp/workspace',
    })
    resolveBridgeRunModelConfigMock.mockResolvedValueOnce({
      model: 'ekko-test-model',
      provider: 'custom:fun-codex',
    })
    resolveEkkoProviderRuntimeConfigMock.mockResolvedValueOnce({
      provider: 'custom:fun-codex',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
    })
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'use the configured protocol',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(resolveEkkoProviderRuntimeConfigMock).toHaveBeenCalledWith({
      profile: 'default',
      provider: 'custom:fun-codex',
      model: 'ekko-test-model',
      baseUrl: undefined,
      apiKey: undefined,
      apiMode: undefined,
    })
    expect(resolveModelProviderConfigsMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom:fun-codex',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', {
      api_mode: 'codex_responses',
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

  it('passes only log correlation context into the internally logged runtime', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-log', maxSteps: 3 })
      input.onEvent({ type: 'model.started', runId: 'run-log', step: 1 })
      input.onEvent({
        type: 'model.retry',
        runId: 'run-log',
        step: 1,
        retry: 1,
        maxRetries: 3,
        error: 'provider timeout',
      })
      input.onEvent({
        type: 'model.message',
        runId: 'run-log',
        step: 1,
        message: { role: 'assistant', content: 'done' },
      })
      input.onEvent({
        type: 'tool.started',
        runId: 'run-log',
        step: 1,
        toolCallId: 'call-1',
        toolName: 'terminal_exec',
        arguments: { command: '/bin/sh', timeoutMs: 650_000 },
      })
      input.onEvent({
        type: 'tool.failed',
        runId: 'run-log',
        step: 1,
        toolCallId: 'call-1',
        toolName: 'terminal_exec',
        result: { ok: false, content: 'timed out', error: 'timed out' },
        durationMs: 120_000,
      })
      input.onEvent({ type: 'model.delta', runId: 'run-log', step: 1, text: 'done' })
      input.onEvent({
        type: 'run.completed',
        runId: 'run-log',
        output: { role: 'assistant', content: 'done' },
        steps: 1,
      })
      return {
        runId: 'run-log',
        output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'run a tool',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      logContext: {
        profile: 'default',
        sessionId: 'session-1',
        turnId: expect.any(String),
      },
    }))
  })

  it('incrementally persists a completed tool group before an aborted run exits', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-abort', maxSteps: 3 })
      input.onEvent({
        type: 'model.message',
        runId: 'run-abort',
        step: 1,
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call-search',
            name: 'skill_list',
            arguments: { query: 'apikey-image-gen' },
          }],
        },
      })
      input.onEvent({
        type: 'tool.completed',
        runId: 'run-abort',
        step: 1,
        toolCallId: 'call-search',
        toolName: 'skill_list',
        result: { ok: true, content: '{"skills":["apikey-image-gen"]}' },
        durationMs: 5,
      })
      expect(addMessagesMock).toHaveBeenCalledTimes(1)
      const abortError = new Error('Run aborted.')
      abortError.name = 'AbortError'
      throw abortError
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'generate an image',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(addMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [{
          id: 'call-search',
          type: 'function',
          function: {
            name: 'skill_list',
            arguments: '{"query":"apikey-image-gen"}',
          },
        }],
        finish_reason: 'tool_calls',
      }),
      expect.objectContaining({
        role: 'tool',
        content: '{"skills":["apikey-image-gen"]}',
        tool_call_id: 'call-search',
        tool_name: 'skill_list',
      }),
    ])
    expect(state.messages.slice(-2).map((message: any) => message.role)).toEqual(['assistant', 'tool'])
    expect(events.some(item => item.event === 'run.failed')).toBe(false)
  })

  it('waits for every result before atomically persisting a multi-tool group', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-multi', maxSteps: 3 })
      input.onEvent({
        type: 'model.message',
        runId: 'run-multi',
        step: 1,
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-one', name: 'skill_list', arguments: { query: 'image' } },
            { id: 'call-two', name: 'skill_view', arguments: { name: 'apikey-image-gen' } },
          ],
        },
      })
      input.onEvent({
        type: 'tool.completed',
        runId: 'run-multi',
        step: 1,
        toolCallId: 'call-one',
        toolName: 'skill_list',
        result: { ok: true, content: 'found' },
        durationMs: 2,
      })
      expect(addMessagesMock).not.toHaveBeenCalled()
      input.onEvent({
        type: 'tool.failed',
        runId: 'run-multi',
        step: 1,
        toolCallId: 'call-two',
        toolName: 'skill_view',
        result: { ok: false, content: 'read failed', error: 'read failed' },
        durationMs: 3,
      })
      expect(addMessagesMock).toHaveBeenCalledTimes(1)
      const abortError = new Error('Run aborted.')
      abortError.name = 'AbortError'
      throw abortError
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'use both tools',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    const rows = addMessagesMock.mock.calls[0][0]
    expect(rows.map((row: any) => row.role)).toEqual(['assistant', 'tool', 'tool'])
    expect(rows[2]).toEqual(expect.objectContaining({
      tool_call_id: 'call-two',
      finish_reason: 'error',
    }))
  })

  it('does not duplicate incrementally persisted tool messages after a successful run', async () => {
    const modelStep = {
      type: 'model',
      step: 1,
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call-once',
          name: 'skill_list',
          arguments: { query: 'image' },
        }],
      },
    }
    const toolStep = {
      type: 'tool',
      step: 1,
      toolCallId: 'call-once',
      toolName: 'skill_list',
      result: { ok: true, content: 'found' },
    }
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-success', maxSteps: 3 })
      input.onEvent({
        type: 'model.message',
        runId: 'run-success',
        step: 1,
        message: modelStep.message,
      })
      input.onEvent({
        type: 'tool.completed',
        runId: 'run-success',
        step: 1,
        toolCallId: 'call-once',
        toolName: 'skill_list',
        result: toolStep.result,
        durationMs: 2,
      })
      return {
        runId: 'run-success',
        output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
        steps: [modelStep, toolStep],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'find the skill',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(addMessagesMock).toHaveBeenCalledTimes(1)
    expect(addMessageMock.mock.calls.filter(call => call[0]?.tool_calls?.length)).toHaveLength(0)
    expect(addMessageMock.mock.calls.filter(call => call[0]?.role === 'tool')).toHaveLength(0)
  })

  it('includes paired non-empty and empty tool results in Ekko history for follow-up turns', async () => {
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
        }, {
          id: 'call_empty',
          type: 'function',
          function: {
            name: 'terminal_exec',
            arguments: '{"command":"mdfind example"}',
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
        content: '',
        tool_call_id: 'call_empty',
        tool_name: 'terminal_exec',
        timestamp: 1003,
      },
      {
        id: 5,
        session_id: 'session-1',
        role: 'tool',
        content: 'orphan result',
        tool_call_id: 'call_orphan',
        tool_name: 'browser_navigate',
        timestamp: 1004,
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
        }, {
          id: 'call_empty',
          name: 'terminal_exec',
          arguments: { command: 'mdfind example' },
          rawArguments: '{"command":"mdfind example"}',
        }],
      },
      {
        role: 'tool',
        content: '{"forecast":"sunny"}',
        toolCallId: 'call_weather',
        name: 'browser_navigate',
      },
      {
        role: 'tool',
        content: '(no output)',
        toolCallId: 'call_empty',
        name: 'terminal_exec',
      },
      { role: 'user', content: 'thanks' },
    ])
    expect(runInput.messages.some((message: any) => message.content === 'orphan result')).toBe(false)
  })
})
