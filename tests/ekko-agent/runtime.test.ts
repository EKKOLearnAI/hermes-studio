import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
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

    expect(result.output.reasoning).toBe('thinking path')
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
    const runtime = new AgentRuntime({ modelClient: client, tools, toolDelayMs: 0 })

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
      const result = await new AgentRuntime({ modelClient: client, tools, toolDelayMs: 0 })
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
    const runtime = new AgentRuntime({ modelClient: client, toolDelayMs: 0 })

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
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry(), maxSteps: 2, toolDelayMs: 0 })

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
      toolDelayMs: 0,
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

  it('builds a system prompt from runtime, skills, tools, and user system messages', async () => {
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
    expect(requests[0].messages[0].content).toContain('Review for correctness.')
    expect(requests[0].messages[0].content).toContain('User system.')
    expect(requests[0].messages[0].content).toContain('## Runtime Context\nprovider: test\nmodel: test-model')
    expect(requests[0].messages.filter(message => message.role === 'system')).toHaveLength(1)
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
})
