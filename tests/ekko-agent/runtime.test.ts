import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  DEFAULT_AGENT_MAX_STEPS,
  buildSystemPrompt,
} from '../../packages/ekko-agent/src/index'
import type {
  AgentTool,
  AgentToolProvider,
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
    expect(events).toEqual(['run.started', 'model.started', 'model.message', 'run.completed'])
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
    })

    expect(requests[0].messages[0].content).toContain('Base prompt.')
    expect(requests[0].messages[0].content).toContain('Use tools carefully.')
    expect(requests[0].messages[0].content).toContain('Review for correctness.')
    expect(requests[0].messages[0].content).toContain('User system.')
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

  it('buildSystemPrompt can be used directly', () => {
    expect(buildSystemPrompt({
      basePrompt: 'Base',
      tools: [{ name: 'read_file' }],
    })).toContain('- read_file')
  })
})
