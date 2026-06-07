import { describe, expect, it } from 'vitest'
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  providerEndpointUrl,
  responsesUrl,
} from '../../packages/server/src/services/agent-runner/endpoint-resolver'
import { parseSseFrame, readSseFrames, readSseFrameTexts, sseEvent } from '../../packages/server/src/services/agent-runner/sse'
import { AgentTargetRegistry, type AgentTargetInput } from '../../packages/server/src/services/agent-runner/target-registry'
import { teeAsyncIterable } from '../../packages/server/src/services/agent-runner/stream-tee'
import { CodingAgentRunManager, sanitizeCodingAgentTerminalOutput } from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'
import { mapCodingAgentResponseEvent } from '../../packages/server/src/services/agent-runner/coding-agent-event-mapper'
import { applyResponseStreamEvent } from '../../packages/server/src/services/hermes/run-chat/response-stream'

describe('agent runner endpoint resolver', () => {
  it('adds v1 for provider hosts without an API root path', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(responsesUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/responses')
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('does not duplicate existing OpenAI-compatible API roots', () => {
    expect(chatCompletionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(chatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(chatCompletionsUrl('https://api.z.ai/api/paas/v4')).toBe('https://api.z.ai/api/paas/v4/chat/completions')
    expect(responsesUrl('https://api.apikey.fun/v1/')).toBe('https://api.apikey.fun/v1/responses')
  })

  it('does not duplicate existing endpoint paths', () => {
    expect(chatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(responsesUrl('https://api.example.com/v1/responses')).toBe('https://api.example.com/v1/responses')
    expect(anthropicMessagesUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/messages')
  })

  it('handles Anthropic-compatible roots', () => {
    expect(anthropicMessagesUrl('https://api.apikey.fun')).toBe('https://api.apikey.fun/v1/messages')
    expect(anthropicMessagesUrl('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(providerEndpointUrl('anthropic_messages', 'https://api.example.com/v1')).toBe('https://api.example.com/v1/messages')
  })
})

describe('agent runner SSE utilities', () => {
  it('parses event and multi-line data fields', () => {
    expect(parseSseFrame('event: response.output_text.delta\ndata: {"delta":"a"}\ndata: {"delta":"b"}')).toEqual({
      event: 'response.output_text.delta',
      data: '{"delta":"a"}\n{"delta":"b"}',
    })
  })

  it('splits LF and CRLF SSE frame boundaries', () => {
    expect(readSseFrameTexts('data: one\n\ndata: two\r\n\r\ndata: three')).toEqual({
      frames: ['data: one', 'data: two'],
      rest: 'data: three',
    })
  })

  it('reads chunked SSE streams with CRLF boundaries', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: first\r\ndata: {"a":'))
        controller.enqueue(encoder.encode('1}\r\n\r\ndata: {"b":2}\n\n'))
        controller.close()
      },
    })

    const frames = []
    for await (const frame of readSseFrames(stream)) frames.push(frame)

    expect(frames).toEqual([
      { event: 'first', data: '{"a":1}' },
      { data: '{"b":2}' },
    ])
  })

  it('serializes named SSE events', () => {
    expect(sseEvent('response.completed', { ok: true })).toBe('event: response.completed\ndata: {"ok":true}\n\n')
  })
})

describe('agent runner target registry', () => {
  it('reuses route credentials for the same normalized target', () => {
    const registry = new AgentTargetRegistry<AgentTargetInput>(
      input => [input.provider, input.model, input.apiMode, input.baseUrl],
    )

    const first = registry.register({
      provider: ' deepseek ',
      model: ' deepseek-chat ',
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-first',
    })
    const second = registry.register({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-second',
    })

    expect(second.routeKey).toBe(first.routeKey)
    expect(second.token).toBe(first.token)
    expect(second.apiKey).toBe('sk-second')
    expect(registry.find(first.routeKey)?.apiKey).toBe('sk-second')
  })

  it('separates route credentials by API mode and upstream URL', () => {
    const registry = new AgentTargetRegistry<AgentTargetInput>(
      input => [input.provider, input.model, input.apiMode, input.baseUrl],
    )

    const chat = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-chat',
      apiMode: 'chat_completions',
    })
    const responses = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-responses',
      apiMode: 'codex_responses',
    })
    const secondUrl = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-two.example.com/v1',
      apiKey: 'sk-second-url',
      apiMode: 'chat_completions',
    })

    expect(chat.routeKey).not.toBe(responses.routeKey)
    expect(chat.token).not.toBe(responses.token)
    expect(chat.routeKey).not.toBe(secondUrl.routeKey)
    expect(chat.token).not.toBe(secondUrl.token)
  })
})

describe('agent runner stream tee', () => {
  it('allows two consumers to receive the same chunks', async () => {
    async function* source() {
      yield 'a'
      yield 'b'
    }
    const [left, right] = teeAsyncIterable(source())
    const collect = async (iterable: AsyncIterable<string>) => {
      const values: string[] = []
      for await (const value of iterable) values.push(value)
      return values
    }

    await expect(Promise.all([collect(left), collect(right)])).resolves.toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ])
  })
})

describe('coding agent terminal output sanitizer', () => {
  it('strips terminal control codes and redacts provider credentials', () => {
    const output = sanitizeCodingAgentTerminalOutput(
      '\u001b[31mError\u001b[0m\r\nAuthorization: Bearer sk-test-secret-token\napi_key = sk-proj-secret-token',
    )

    expect(output).toContain('Error\nAuthorization: Bearer [redacted]')
    expect(output).toContain('api_key = [redacted-api-key]')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('sk-test-secret-token')
    expect(output).not.toContain('sk-proj-secret-token')
  })
})

describe('coding agent run state', () => {
  it('updates the shared chat session state during streaming', () => {
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.created',
      data: { response: { id: 'resp-1', status: 'in_progress' } },
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.output_text.delta',
      data: { delta: 'hello' },
    })

    expect(state).toEqual(expect.objectContaining({
      isWorking: true,
      source: 'coding_agent',
      profile: 'default',
      runId: 'agent-session-1',
    }))
    expect(state.messages).toEqual([
      expect.objectContaining({
        session_id: 'chat-session-1',
        role: 'assistant',
        content: 'hello',
      }),
    ])
    expect(emitted.map(event => event.event)).toContain('message.delta')
    manager.shutdown()
  })
})

describe('coding agent chat event mapper', () => {
  it('does not surface raw provider stream events as chat agent events', () => {
    const mapped = mapCodingAgentResponseEvent({
      type: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'hello' },
    })

    expect(mapped).toEqual([])
  })

  it('maps reasoning deltas to chat reasoning deltas', () => {
    expect(mapCodingAgentResponseEvent({
      type: 'response.reasoning.delta',
      data: { type: 'response.reasoning.delta', delta: 'thinking' },
    })).toEqual([{
      event: 'reasoning.delta',
      payload: expect.objectContaining({
        event: 'reasoning.delta',
        delta: 'thinking',
      }),
    }])
  })
})

describe('response stream tool detail events', () => {
  it('emits updated tool.started payloads as function-call arguments stream in', () => {
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    const started = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
      item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '' },
    })
    const withCommand = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.function_call_arguments.delta', {
      item_id: 'call-1',
      delta: '{"command":"pwd"',
    })
    const withFinalArgs = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.function_call_arguments.delta', {
      item_id: 'call-1',
      delta: '}',
    })

    expect(started).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        tool_call_id: 'call-1',
        tool: 'Bash',
      }),
    }))
    expect(withCommand).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        arguments: '{"command":"pwd"',
      }),
    }))
    expect(withFinalArgs).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        arguments: '{"command":"pwd"}',
      }),
    }))
  })
})

describe('Claude Code stream-json mapping', () => {
  it('maps top-level tool_result messages to tool.completed', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).ensureDbSession = () => {}
    const run = {
      id: 'agent-session-1',
      launch: {
        agentSessionId: 'agent-session-1',
        agentId: 'claude-code',
        profile: 'default',
        provider: 'test',
        model: 'claude-test',
        sessionId: 'chat-session-1',
        command: 'claude',
        args: [],
        shellCommand: 'claude',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      printResponseId: 'resp_1',
      printMessageId: 'msg_resp_1',
      printToolBlocks: new Map(),
    }
    ;(manager as any).runs.set(run.id, run)

    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
      },
    }))
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp/project' }],
      },
    }))

    expect(emitted.map(event => event.event)).toContain('tool.started')
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'tool.completed',
      payload: expect.objectContaining({
        tool_call_id: 'toolu_1',
        output: '/tmp/project',
      }),
    }))
  })
})
