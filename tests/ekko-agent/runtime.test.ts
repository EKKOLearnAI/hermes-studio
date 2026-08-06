import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  DelegateTaskTool,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MODEL_MAX_RETRIES,
  buildSystemPrompt,
} from '../../packages/ekko-agent/src/index'
import type {
  AgentTool,
  AgentToolProvider,
  ModelEvent,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from '../../packages/ekko-agent/src/index'

function modelClient(responder: (request: ModelRequest, call: number) => ModelResponse): ModelClient {
  let call = 0
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(async (request: ModelRequest) => responder(request, ++call)),
    stream: vi.fn(),
  }
}

function streamingModelClient(events: ModelEvent[]): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(),
    stream: vi.fn(async function *stream() {
      for (const event of events) yield event
    }),
  }
}

function emptyStreamingWithCreateFallback(response: ModelResponse): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(async () => response),
    stream: vi.fn(async function *stream() {
      yield { type: 'done', response: { finishReason: 'stop' } }
    }),
  }
}

describe('ekko-agent runtime', () => {
  it('runs a model request without tools', async () => {
    const client = modelClient(() => ({
      content: 'hello',
      model: 'test-model',
    }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => events.push(event.type),
    })

    expect(result.output).toMatchObject({
      role: 'assistant',
      content: 'hello',
      model: 'test-model',
    })
    expect(result.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant'])
    expect(events).toEqual(['run.started', 'model.started', 'context.estimated', 'model.message', 'run.completed'])
  })

  it('forwards reasoning controls to model requests', async () => {
    const client = modelClient(request => {
      expect(request).toMatchObject({
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      })
      return { content: 'done' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    await runtime.run({
      messages: ['hi'],
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
    })
  })

  it('estimates provider-visible context without starting a model run', async () => {
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'estimate_only',
        description: 'Included in context estimates',
        parameters: { type: 'object' },
      },
      async execute() {
        return { ok: true, content: 'unused' }
      },
    })
    const client = modelClient(() => ({ content: 'must not run' }))
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const estimate = await runtime.estimateContext({
      messages: ['hello'],
      metadata: { session_id: 'estimate-session' },
    })

    expect(estimate.messageCount).toBe(2)
    expect(estimate.toolCount).toBe(1)
    expect(estimate.systemPromptTokens).toBeGreaterThan(0)
    expect(estimate.messageTokens).toBeGreaterThan(0)
    expect(client.create).not.toHaveBeenCalled()
    expect(client.stream).not.toHaveBeenCalled()
  })

  it('includes assistant reasoning in provider-visible context estimates', async () => {
    const client = modelClient(() => ({ content: 'must not run' }))
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      systemPrompt: '',
    })
    const withoutReasoning = await runtime.estimateContext({
      messages: [
        { role: 'assistant', content: 'Previous answer.' },
        { role: 'user', content: 'Continue.' },
      ],
    })
    const withReasoning = await runtime.estimateContext({
      messages: [
        {
          role: 'assistant',
          content: 'Previous answer.',
          reasoning: { text: 'A long hidden reasoning trace that is replayed to the provider.' },
        },
        { role: 'user', content: 'Continue.' },
      ],
    })

    expect(withReasoning.messageTokens).toBeGreaterThan(withoutReasoning.messageTokens)
    expect(withReasoning.contextTokens - withoutReasoning.contextTokens)
      .toBe(withReasoning.messageTokens - withoutReasoning.messageTokens)
  })

  it('uses one provider reasoning-token estimate instead of counting text and native metadata again', async () => {
    const client = modelClient(() => ({ content: 'must not run' }))
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      systemPrompt: '',
    })
    const base = await runtime.estimateContext({
      messages: [{ role: 'assistant', content: 'Previous answer.' }],
    })
    const withReasoning = await runtime.estimateContext({
      messages: [{
        role: 'assistant',
        content: 'Previous answer.',
        reasoning: {
          text: 'Visible summary that must not be counted a second time.',
          estimatedTokens: 123,
          native: {
            format: 'openai-responses-items',
            data: [{ type: 'reasoning', encrypted_content: 'opaque-native-data' }],
          },
        },
      }],
    })

    expect(withReasoning.messageTokens - base.messageTokens).toBe(123)
  })

  it('emits one model usage event for each completed non-streaming model call', async () => {
    const client = modelClient(() => ({
      content: 'hello',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 6,
        reasoningTokens: 2,
      },
    }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const usageEvents: any[] = []

    await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'model.usage') usageEvents.push(event)
      },
    })

    expect(usageEvents).toEqual([{
      type: 'model.usage',
      runId: expect.any(String),
      step: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 6,
        reasoningTokens: 2,
      },
    }])
  })

  it('collapses repeated streaming usage updates into one event per model call', async () => {
    const client = streamingModelClient([
      { type: 'text-delta', text: 'ok' },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 5 } },
      { type: 'done', response: { finishReason: 'stop' } },
    ])
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const usageEvents: any[] = []

    await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'model.usage') usageEvents.push(event)
      },
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      step: 1,
      usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 5 },
    })
  })

  it('emits model reasoning before the assistant message', async () => {
    const client = modelClient(() => ({
      content: 'answer',
      reasoning: 'thinking path',
    }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []
    const reasoning: string[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        events.push(event.type)
        if (event.type === 'model.reasoning') reasoning.push(event.text)
      },
    })

    expect(result.output.reasoning).toEqual({ text: 'thinking path' })
    expect(reasoning).toEqual(['thinking path'])
    expect(events).toEqual(['run.started', 'model.started', 'context.estimated', 'model.reasoning', 'model.message', 'run.completed'])
  })

  it('streams model text deltas before the final assistant message', async () => {
    const client = streamingModelClient([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'done', response: { finishReason: 'stop' } },
    ])
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []
    const deltas: string[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        events.push(event.type)
        if (event.type === 'model.delta') deltas.push(event.text)
      },
    })

    expect(client.create).not.toHaveBeenCalled()
    expect(client.stream).toHaveBeenCalledTimes(1)
    expect(result.output.content).toBe('Hello')
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(events).toEqual(['run.started', 'model.started', 'context.estimated', 'model.delta', 'model.delta', 'model.message', 'run.completed'])
  })

  it('falls back to non-streaming create when a provider stream returns no output', async () => {
    const client = emptyStreamingWithCreateFallback({ content: 'fallback answer', finishReason: 'stop' })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    const result = await runtime.run({ messages: ['hi'] })

    expect(result.output.content).toBe('fallback answer')
    expect(client.stream).toHaveBeenCalledTimes(1)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(vi.mocked(client.create).mock.calls[0]?.[0]).toMatchObject({ stream: false })
  })

  it('executes tool calls and continues the model loop', async () => {
    const echoTool: AgentTool = {
      definition: {
        name: 'echo',
        description: 'Echo text',
        parameters: { type: 'object' },
      },
      async execute(input) {
        return { ok: true, content: String(input.text || '') }
      },
    }
    const tools = new AgentToolRegistry()
    tools.register(echoTool)
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '',
          toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'from-tool' } }],
          finishReason: 'tool_calls',
        }
      : { content: 'tool said from-tool', finishReason: 'stop' })
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const result = await runtime.run({ messages: ['use echo'] })

    expect(result.output.content).toBe('tool said from-tool')
    expect(result.messages).toMatchObject([
      { role: 'system' },
      { role: 'user', content: 'use echo' },
      { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'echo' }] },
      { role: 'tool', toolCallId: 'call_1', name: 'echo', content: 'from-tool' },
      { role: 'assistant', content: 'tool said from-tool' },
    ])
    expect(result.steps.map(step => step.type)).toEqual(['model', 'tool', 'model'])
  })

  it('waits for foreground delegated tasks and hides delegation from the child', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'delegate-1',
            name: 'delegate_task',
            arguments: {
              goal: 'Inspect the implementation',
              context: 'Focus on runtime.ts',
              mode: 'foreground',
            },
          }],
          finishReason: 'tool_calls',
        }
      }
      if (call === 2) return { content: 'Child inspection result', finishReason: 'stop' }
      return { content: 'Parent used the child result', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    const result = await runtime.run({
      messages: ['Delegate this work'],
      metadata: { session_id: 'foreground-session' },
      onEvent: event => events.push(event),
    })

    expect(result.output.content).toBe('Parent used the child result')
    const childPrompt = requests[1].messages.find(message => message.role === 'user')?.content
    expect(childPrompt).toContain('Inspect the implementation')
    expect(childPrompt).toContain('Focus on runtime.ts')
    expect(requests[1].tools).toBeUndefined()
    expect(requests[1].toolChoice).toBeUndefined()
    expect(result.steps.find(step => step.type === 'tool')).toMatchObject({
      type: 'tool',
      toolName: 'delegate_task',
      result: {
        ok: true,
        data: {
          mode: 'foreground',
          status: 'completed',
          output: 'Child inspection result',
        },
      },
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subagent.start',
        goal: 'Inspect the implementation',
        background: false,
      }),
      expect.objectContaining({
        type: 'subagent.complete',
        status: 'completed',
        background: false,
      }),
    ]))
  })

  it('keeps background delegated tasks alive after the parent run completes', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    let call = 0
    let finishChild!: (response: ModelResponse) => void
    const childResponse = new Promise<ModelResponse>((resolve) => {
      finishChild = resolve
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async () => {
        call += 1
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'delegate-bg',
              name: 'delegate_task',
              arguments: { goal: 'Run validation', mode: 'background' },
            }],
            finishReason: 'tool_calls',
          }
        }
        if (call === 2) return childResponse
        return { content: 'Background task started', finishReason: 'stop' }
      }),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    const result = await runtime.run({
      messages: ['Start it in the background'],
      metadata: { session_id: 'background-session' },
      onEvent: event => events.push(event),
    })

    expect(result.output.content).toBe('Background task started')
    expect(runtime.hasBackgroundTasks('background-session')).toBe(true)
    expect(events.some(event => event.type === 'subagent.complete')).toBe(false)

    finishChild({
      content: 'Validation passed',
      finishReason: 'stop',
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 5,
        reasoningTokens: 2,
      },
    })
    await vi.waitFor(() => {
      expect(runtime.hasBackgroundTasks('background-session')).toBe(false)
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subagent.complete',
        status: 'completed',
        background: true,
        summary: 'Validation passed',
        output: 'Validation passed',
        childRunId: expect.any(String),
        apiCalls: 1,
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 5,
        reasoningTokens: 2,
      }),
    ]))
  })

  it('removes and rejects background delegation when the run disables it', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'delegate-disabled',
            name: 'delegate_task',
            arguments: { goal: 'Run validation later', mode: 'background' },
          }],
          finishReason: 'tool_calls',
        }
      }
      return { content: 'Background delegation was unavailable.', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    const result = await runtime.run({
      messages: ['Do the work'],
      metadata: { session_id: 'no-background-session' },
      backgroundDelegationEnabled: false,
      onEvent: event => events.push(event),
    })

    const delegateDefinition = requests[0].tools?.find(tool => tool.name === 'delegate_task')
    expect((delegateDefinition?.parameters?.properties as any)?.mode?.enum).toEqual(['foreground'])
    expect(result.steps.find(step => step.type === 'tool')).toMatchObject({
      type: 'tool',
      toolName: 'delegate_task',
      result: {
        ok: false,
        error: 'Background subtask delegation is disabled for this run. Use foreground mode.',
      },
    })
    expect(runtime.hasBackgroundTasks('no-background-session')).toBe(false)
    expect(events.some(event => event.type === 'subagent.start')).toBe(false)
  })

  it('aborts detached background delegated tasks by session', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    let call = 0
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async (request) => {
        call += 1
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'delegate-bg-abort',
              name: 'delegate_task',
              arguments: { goal: 'Wait indefinitely', mode: 'background' },
            }],
            finishReason: 'tool_calls',
          }
        }
        if (call === 2) {
          return new Promise<ModelResponse>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => {
              const error = new Error('Run aborted.')
              error.name = 'AbortError'
              reject(error)
            }, { once: true })
          })
        }
        return { content: 'Task started', finishReason: 'stop' }
      }),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    await runtime.run({
      messages: ['Start task'],
      metadata: { session_id: 'abort-background-session' },
      onEvent: event => events.push(event),
    })

    await expect(runtime.abortBackgroundTasks('abort-background-session')).resolves.toBe(1)
    expect(runtime.hasBackgroundTasks('abort-background-session')).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subagent.complete',
        status: 'interrupted',
        background: true,
      }),
    ]))
  })

  it('sanitizes base64 tool results before the next model request', async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from('runtime-avatar').toString('base64')}`
    const avatarTool: AgentTool = {
      definition: {
        name: 'profiles_list',
        description: 'List profiles',
        parameters: { type: 'object' },
      },
      async execute() {
        return {
          ok: true,
          content: JSON.stringify({ profiles: [{ avatar: { type: 'image', dataUrl } }] }),
        }
      },
    }
    const tools = new AgentToolRegistry()
    tools.register(avatarTool)
    let assetUrl = ''
    const client = modelClient((request, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_profiles', name: 'profiles_list', arguments: {} }],
          finishReason: 'tool_calls',
        }
      }
      const toolMessage = request.messages.find(message => message.role === 'tool')
      expect(toolMessage?.content).not.toContain('base64')
      assetUrl = JSON.parse(toolMessage?.content || '{}').profiles[0].avatar.dataUrl
      expect(assetUrl).toMatch(/^file:\/\//)
      return { content: 'done', finishReason: 'stop' }
    })

    try {
      const result = await new AgentRuntime({ modelClient: client, tools })
        .run({ messages: ['list profiles'] })
      expect(result.output.content).toBe('done')
    } finally {
      if (assetUrl) await rm(fileURLToPath(assetUrl), { force: true })
    }
  })

  it('discovers and executes MCP tools from the run tool context', async () => {
    const client = modelClient((request, call) => {
      if (call === 1) {
        expect(request.tools?.some(tool => tool.name === 'fake_echo')).toBe(true)
        return {
          content: '',
          toolCalls: [{ id: 'call_mcp', name: 'fake_echo', arguments: { text: 'hello' } }],
          finishReason: 'tool_calls',
        }
      }
      return { content: 'done', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client })

    const result = await runtime.run({
      messages: ['use mcp'],
      toolContext: {
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [join(process.cwd(), 'tests/fixtures/fake-mcp-server.cjs')],
          },
        },
      },
    })

    expect(result.messages).toMatchObject([
      { role: 'system' },
      { role: 'user', content: 'use mcp' },
      { role: 'assistant', toolCalls: [{ id: 'call_mcp', name: 'fake_echo' }] },
      { role: 'tool', toolCallId: 'call_mcp', name: 'fake_echo', content: 'mcp:hello' },
      { role: 'assistant', content: 'done' },
    ])
  })

  it('returns unknown tool failures as tool messages', async () => {
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '',
          toolCalls: [{ id: 'call_missing', name: 'missing_tool', arguments: {} }],
        }
      : { content: 'handled missing tool' })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry(), maxSteps: 2 })

    const result = await runtime.run({ messages: ['call missing'] })

    expect(result.messages[3]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_missing',
      name: 'missing_tool',
      content: 'Unknown tool: missing_tool',
    })
    expect(result.output.content).toBe('handled missing tool')
  })

  it('stops after consecutive tool failures', async () => {
    const client = modelClient((_request, call) => ({
      content: '',
      toolCalls: [{ id: `call_missing_${call}`, name: 'missing_tool', arguments: {} }],
    }))
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      maxConsecutiveToolFailures: 2,
      maxSteps: 10,
    })
    const events: string[] = []

    const result = await runtime.run({
      messages: ['call missing repeatedly'],
      onEvent: event => events.push(event.type),
    })

    expect(result.output).toMatchObject({
      content: 'Stopped after 2 consecutive tool failures.',
      finishReason: 'tool_failure_limit',
    })
    expect(result.steps.filter(step => step.type === 'tool')).toHaveLength(2)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(events).toContain('run.tool_failure_limit')
  })

  it('passes abort signals into model requests', async () => {
    const controller = new AbortController()
    const client = modelClient((request) => {
      expect(request.signal).toBe(controller.signal)
      return { content: 'done' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    const result = await runtime.run({ messages: ['hi'], signal: controller.signal })

    expect(result.output.content).toBe('done')
  })

  it('stops before a model request when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = modelClient(() => ({ content: 'should not run' }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    await expect(runtime.run({ messages: ['hi'], signal: controller.signal })).rejects.toThrow('Run aborted.')
    expect(client.create).not.toHaveBeenCalled()
  })

  it('defaults maxSteps to 90', async () => {
    const client = modelClient(() => ({ content: 'done' }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const seen: number[] = []

    await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'run.started') seen.push(event.maxSteps)
      },
    })

    expect(DEFAULT_AGENT_MAX_STEPS).toBe(90)
    expect(seen).toEqual([90])
  })

  it('retries each model step before continuing the loop', async () => {
    const client = modelClient((_request, call) => {
      if (call < 3) throw new Error(`temporary failure ${call}`)
      return { content: 'recovered' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const retries: number[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'model.retry') retries.push(event.retry)
      },
    })

    expect(result.output.content).toBe('recovered')
    expect(client.create).toHaveBeenCalledTimes(3)
    expect(retries).toEqual([1, 2])
  })

  it('stops the run after three failed model retries', async () => {
    const client = modelClient(() => {
      throw new Error('still failing')
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []

    await expect(runtime.run({
      messages: ['hi'],
      onEvent: event => events.push(event.type),
    })).rejects.toThrow('still failing')

    expect(DEFAULT_AGENT_MODEL_MAX_RETRIES).toBe(3)
    expect(client.create).toHaveBeenCalledTimes(4)
    expect(events.filter(event => event === 'model.retry')).toHaveLength(3)
    expect(events.at(-1)).toBe('run.failed')
  })

  it('builds a system prompt from runtime context and user system messages without skill instructions', async () => {
    const requests: ModelRequest[] = []
    const client = modelClient((request) => {
      requests.push(request)
      return { content: 'ok' }
    })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      systemPrompt: 'Base prompt.',
      runtimeInstructions: ['Use tools carefully.'],
      skills: [{
        id: 'review',
        name: 'Review',
        instructions: 'Review for correctness.',
      }],
    })

    await runtime.run({
      messages: [
        { role: 'system', content: 'User system.' },
        { role: 'user', content: 'Go' },
      ],
      model: 'test-model',
    })

    expect(requests[0].messages[0].content).toContain('Base prompt.')
    expect(requests[0].messages[0].content).toContain('Use tools carefully.')
    expect(requests[0].messages[0].content).not.toContain('Review for correctness.')
    expect(requests[0].messages[0].content).not.toContain('## Skills')
    expect(requests[0].messages[0].content).toContain('User system.')
    expect(requests[0].messages[0].content).toContain('## Runtime Context\nprovider: test\nmodel: test-model')
    expect(requests[0].messages.filter(message => message.role === 'system')).toHaveLength(1)
  })

  it('does not inject skill instructions when all tools are disabled', async () => {
    const listTools = vi.fn(async () => [])
    const tools = new AgentToolRegistry()
    tools.registerProvider({ id: 'dynamic', listTools })
    const client = modelClient((request) => {
      expect(request.tools).toBeUndefined()
      expect(request.messages[0].content).not.toContain('Keep this skill instruction.')
      return { content: 'ok' }
    })

    await new AgentRuntime({
      modelClient: client,
      tools,
      toolsEnabled: false,
      skills: [{
        id: 'kept-skill',
        name: 'Kept Skill',
        instructions: 'Keep this skill instruction.',
      }],
    }).run({ messages: ['hi'] })

    expect(listTools).not.toHaveBeenCalled()
  })

  it('injects the skill discovery constraint when both skill tools are available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skills-'))
    const skillDirectory = join(root, 'skills')
    const client = modelClient((request) => {
      expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['skill_list', 'skill_view', 'skill_manage']))
      expect(request.messages[0].content).toContain('## Skill Discovery')
      expect(request.messages[0].content).toContain('call skill_list before proceeding')
      expect(request.messages[0].content).toContain('## Skill Evolution')
      return { content: 'ok' }
    })

    try {
      await new AgentRuntime({ modelClient: client, skillDirectory }).run({ messages: ['hi'] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reviews a tool-heavy turn in the background with only skill tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-skill-review-'))
    const skillDirectory = join(root, 'skills')
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, 'input.txt'), 'reusable evidence')
    let mainCalls = 0
    let reviewCalls = 0
    const reviewRequests: ModelRequest[] = []
    const usageEvents: unknown[] = []
    const eventTypes: string[] = []
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async (request: ModelRequest) => {
        if (request.metadata?.purpose === 'ekko-skill-review') {
          reviewRequests.push(request)
          reviewCalls += 1
          if (reviewCalls === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'review-list', name: 'skill_list', arguments: {} }],
              finishReason: 'tool_calls',
            }
          }
          if (reviewCalls === 2) {
            return {
              content: '',
              toolCalls: [{
                id: 'review-create',
                name: 'skill_manage',
                arguments: {
                  action: 'create',
                  name: 'reusable-verification',
                  content: [
                    '---',
                    'name: reusable-verification',
                    'description: Verify recurring changes consistently.',
                    '---',
                    '# Reusable Verification',
                    '## Procedure',
                    'Run the focused check and verify its output.',
                    '',
                  ].join('\n'),
                },
              }],
              finishReason: 'tool_calls',
              usage: { inputTokens: 20, outputTokens: 5 },
            }
          }
          return { content: 'Done.', usage: { inputTokens: 12, outputTokens: 2 } }
        }
        mainCalls += 1
        return mainCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'main-read', name: 'read_file', arguments: { path: 'input.txt' } }],
              finishReason: 'tool_calls',
            }
          : { content: 'Main answer.' }
      }),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({
      modelClient: client,
      skillDirectory,
      skillReviewEveryToolCalls: 1,
    })

    try {
      const result = await runtime.run({
        messages: ['Use the input and finish the task.'],
        metadata: { session_id: 'review-session' },
        toolContext: { workspaceRoot },
        onSkillReviewUsage: event => {
          usageEvents.push(event)
          throw new Error('observer failure')
        },
        onEvent: event => eventTypes.push(event.type),
      })
      expect(result.output.content).toBe('Main answer.')

      await runtime.drainSkillReviews()

      expect(reviewRequests[0].tools?.map(tool => tool.name).sort()).toEqual([
        'skill_list',
        'skill_manage',
        'skill_view',
      ])
      expect(reviewRequests[0].messages[0].content).toContain('background procedural-learning reviewer')
      expect(reviewRequests[0].messages[1].content).toContain('reusable evidence')
      await expect(readFile(
        join(skillDirectory, 'reusable-verification', 'SKILL.md'),
        'utf8',
      )).resolves.toContain('Run the focused check')
      expect(usageEvents).toHaveLength(2)
      expect(eventTypes.indexOf('run.completed')).toBeLessThan(eventTypes.indexOf('skill.review.started'))
      expect(eventTypes).toContain('skill.review.completed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('disables constructor and per-run skills without disabling regular tools', async () => {
    const regularTool: AgentTool = {
      definition: { name: 'regular_tool', parameters: { type: 'object' } },
      async execute() {
        return { ok: true, content: 'regular' }
      },
    }
    const skillTool: AgentTool = {
      definition: { name: 'skill_tool', parameters: { type: 'object' } },
      async execute() {
        return { ok: true, content: 'skill' }
      },
    }
    const tools = new AgentToolRegistry()
    tools.register(regularTool)
    const client = modelClient((request) => {
      expect(request.tools?.map(tool => tool.name)).toEqual(['regular_tool'])
      expect(request.messages[0].content).not.toContain('Disabled constructor skill.')
      expect(request.messages[0].content).not.toContain('Disabled run skill.')
      return { content: 'ok' }
    })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools,
      skillsEnabled: false,
      skills: [{
        id: 'constructor-skill',
        name: 'Constructor Skill',
        instructions: 'Disabled constructor skill.',
        tools: [skillTool],
      }],
    })

    runtime.registerSkill({
      id: 'registered-skill',
      name: 'Registered Skill',
      instructions: 'Disabled registered skill.',
      tools: [skillTool],
    })
    await runtime.run({
      messages: ['hi'],
      skills: [{
        id: 'run-skill',
        name: 'Run Skill',
        instructions: 'Disabled run skill.',
        tools: [skillTool],
      }],
    })
  })

  it('refreshes dynamic tool providers before running', async () => {
    const providerTool: AgentTool = {
      definition: { name: 'provided_tool', parameters: { type: 'object' } },
      async execute() {
        return { ok: true, content: 'provided' }
      },
    }
    const provider: AgentToolProvider = {
      id: 'test-provider',
      async listTools() {
        return [providerTool]
      },
    }
    const tools = new AgentToolRegistry()
    tools.registerProvider(provider)
    const client = modelClient((request) => {
      expect(request.tools?.map(tool => tool.name)).toContain('provided_tool')
      return { content: 'ok' }
    })

    await new AgentRuntime({ modelClient: client, tools }).run({ messages: ['hi'] })
  })

  it('stores model context by session and sends it on follow-up runs', async () => {
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      return {
        content: `ok-${call}`,
        context: { responseId: `resp-${call}` },
      }
    })
    const runtime = new AgentRuntime({ modelClient: client })

    const first = await runtime.run({
      messages: ['first'],
      metadata: { session_id: 'session-a' },
    })
    const second = await runtime.run({
      messages: ['second'],
      metadata: { session_id: 'session-a' },
    })
    await runtime.run({
      messages: ['other'],
      metadata: { session_id: 'session-b' },
    })

    expect(first.context).toEqual({ responseId: 'resp-1' })
    expect(second.context).toEqual({ responseId: 'resp-2' })
    expect(requests[0].context).toBeUndefined()
    expect(requests[1].context).toEqual({ responseId: 'resp-1' })
    expect(requests[2].context).toBeUndefined()
  })

  it('buildSystemPrompt omits structured tool descriptions', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Base',
    })

    expect(prompt).toContain('Base')
    expect(prompt).not.toContain('Available Tools')
    expect(prompt).not.toContain('read_file')
  })

  it('buildSystemPrompt includes provider and model in runtime context', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Base',
      context: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        workspaceRoot: '/tmp/workspace',
      },
    })

    expect(prompt).toContain([
      '## Runtime Context',
      'provider: openrouter',
      'model: anthropic/claude-sonnet-4',
      'workspaceRoot: /tmp/workspace',
    ].join('\n'))
  })

  it('buildSystemPrompt adds the on-demand skill discovery constraint', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Base',
      skillDiscoveryEnabled: true,
      skillManagementEnabled: true,
    })

    expect(prompt).toContain('## Skill Discovery')
    expect(prompt).toContain('call skill_list before proceeding')
    expect(prompt).toContain('call skill_view with its exact name')
    expect(prompt).toContain('## Skill Evolution')
    expect(prompt).toContain('Prefer a small patch over a full edit.')
    expect(prompt).not.toContain('## Skills')
  })

  it('buildSystemPrompt always includes Ekko image and file output guidance', () => {
    const prompt = buildSystemPrompt({ basePrompt: 'Base' })

    expect(prompt).toContain('## Image and File Output')
    expect(prompt).toContain('![description](/absolute/path/image.png)')
    expect(prompt).toContain('![description](<C:/absolute/path/image.png>)')
    expect(prompt).toContain('Do not use relative paths or `file://` URLs.')
  })

  it('buildSystemPrompt requires dependency preflight before tool execution', () => {
    const prompt = buildSystemPrompt({ basePrompt: 'Base' })

    expect(prompt).toContain('## Tool Execution')
    expect(prompt).toContain('prerequisites named by a Skill as requirements, not proof that they are installed')
    expect(prompt).toContain('perform a lightweight availability check')
    expect(prompt).toContain('use code_exec, including for one-line snippets')
    expect(prompt).toContain('Do not probe Node or Python with terminal_exec first')
    expect(prompt).toContain('Use terminal_exec for CLI commands')
    expect(prompt).toContain('do not retry the operation through another tool or language runtime')
    expect(prompt).toContain('prefer a compatible installed or built-in alternative')
  })
})
