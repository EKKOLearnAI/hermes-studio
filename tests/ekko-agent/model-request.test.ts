import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  AnthropicMessagesModelClient,
  ModelProviderError,
  ModelProviderRegistry,
  authorizedModelProviderPreset,
  createModelClient,
  toAnthropicMessagesPayload,
  toGeminiContentsPayload,
  normalizeOpenAIChatResponse,
  resolveModelProviderConfigs,
  toOpenAIResponsesPayload,
  toOpenAIChatPayload,
  toPromptCompletionPayload,
} from '../../packages/ekko-agent/src/index'
import type { ModelProviderConfig } from '../../packages/ekko-agent/src/index'

const providerConfig: ModelProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
}

describe('ekko-agent model requests', () => {
  it('completes a Codex Responses tool loop when terminal output arrays are empty', async () => {
    const encoder = new TextEncoder()
    let call = 0
    const requestBodies: Array<Record<string, any>> = []
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      call += 1
      const frames = call === 1
        ? [
            'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_weather","name":"weather","arguments":"{\\"city\\":\\"Xiamen\\"}"}}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","output":[]}}\n\n',
          ]
        : [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Sunny"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_final","status":"completed","output":[]}}\n\n',
          ]
      return new Response(new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame))
          controller.close()
        },
      }), { status: 200 })
    })
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      async execute(input) {
        return { ok: true, content: `${input.city}: 30C` }
      },
    })
    const client = createModelClient({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: 'gpt-5.6-terra',
    }, { fetch: fetchMock })
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const result = await runtime.run({ messages: ['Check Xiamen weather'] })

    expect(result.output.content).toBe('Sunny')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBodies[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_weather',
        name: 'weather',
      }),
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: 'Xiamen: 30C',
      },
    ]))
    expect(requestBodies.every(body => body.stream === true)).toBe(true)
  })

  it('defines first-class request presets for authorized providers', () => {
    expect(authorizedModelProviderPreset('nous')).toMatchObject({
      id: 'nous',
      baseUrl: 'https://inference-api.nousresearch.com/v1',
      requestStyle: 'openai-chat',
    })
    expect(authorizedModelProviderPreset('openai-codex')).toMatchObject({
      id: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      requestStyle: 'openai-responses',
    })
    expect(authorizedModelProviderPreset('xai-oauth')).toMatchObject({
      id: 'xai-oauth',
      baseUrl: 'https://api.x.ai/v1',
      requestStyle: 'openai-responses',
    })
    expect(authorizedModelProviderPreset('qwen-oauth')).toMatchObject({
      id: 'qwen-oauth',
      baseUrl: 'https://portal.qwen.ai/v1',
      requestStyle: 'openai-chat',
    })
  })

  it.each([
    {
      provider: 'nous',
      url: 'https://inference-api.nousresearch.com/v1/chat/completions',
      response: { choices: [{ message: { content: 'Nous' }, finish_reason: 'stop' }] },
      expectedContent: 'Nous',
    },
    {
      provider: 'xai-oauth',
      url: 'https://api.x.ai/v1/responses',
      response: { output_text: 'xAI', status: 'completed' },
      expectedContent: 'xAI',
    },
  ])('sends $provider access tokens to its default endpoint', async ({
    provider,
    url,
    response,
    expectedContent,
  }) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response)))
    const resolved = resolveModelProviderConfigs({
      provider,
      apiKey: 'oauth-access-token',
      model: 'test-model',
    })
    const client = createModelClient(resolved.providerConfig, { fetch: fetchMock })

    const result = await client.create({ messages: [{ role: 'user', content: 'Hello' }] })

    expect(result.content).toBe(expectedContent)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(url)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer oauth-access-token',
    })
  })

  it('sends Codex OAuth identity headers to the ChatGPT Responses endpoint', async () => {
    const tokenPayload = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
    })).toString('base64url')
    const accessToken = `header.${tokenPayload}.signature`
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Codex"}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_codex","status":"completed","output":[]}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    const resolved = resolveModelProviderConfigs({
      provider: 'openai-codex',
      apiKey: accessToken,
      model: 'gpt-5-codex',
    })

    const result = await createModelClient(resolved.providerConfig, { fetch: fetchMock }).create({
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { session_id: 'session-1', profile: 'default' },
      maxTokens: 1024,
      temperature: 0.2,
    })

    expect(result.content).toBe('Codex')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'codex_cli_rs/0.0.0 (Ekko Agent)',
      originator: 'codex_cli_rs',
      'ChatGPT-Account-ID': 'account-123',
    })
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).toMatchObject({ store: false, stream: true })
    expect(requestBody).not.toHaveProperty('metadata')
    expect(requestBody).not.toHaveProperty('max_output_tokens')
    expect(requestBody).not.toHaveProperty('temperature')
  })

  it('keeps Codex streamed text when the terminal response output is empty', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.6-terra","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    const client = createModelClient({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: 'gpt-5.6-terra',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'Hello' }],
    })) events.push(event)

    expect(events).toContainEqual({ type: 'text-delta', text: 'OK' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      response: expect.objectContaining({ content: 'OK', finishReason: 'completed' }),
    }))
  })

  it('keeps non-Codex Responses create requests non-streaming', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output_text: 'xAI',
      status: 'completed',
    })))
    const client = createModelClient({
      id: 'xai-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.5',
    }, { fetch: fetchMock })

    const response = await client.create({ messages: [{ role: 'user', content: 'Hello' }] })
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))

    expect(response.content).toBe('xAI')
    expect(requestBody.stream).toBe(false)
  })

  it('emits Responses function calls from output item events', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[]}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    const client = createModelClient({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      defaultModel: 'gpt-5.6-terra',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({ messages: [{ role: 'user', content: 'Read it' }] })) {
      events.push(event)
    }

    expect(events).toContainEqual({
      type: 'tool-call',
      toolCall: {
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'README.md' },
        rawArguments: '{"path":"README.md"}',
      },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      response: expect.objectContaining({
        toolCalls: [expect.objectContaining({ id: 'call_1', name: 'read_file' })],
      }),
    }))
  })

  it('omits unsupported metadata from xAI OAuth Responses requests', async () => {
    const payload = toOpenAIResponsesPayload({
      id: 'xai-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      defaultModel: 'grok-4.5',
    }, {
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { session_id: 'session-1', profile: 'default' },
      context: { responseId: 'response-from-first-turn' },
    })

    expect(payload).not.toHaveProperty('metadata')
    expect(payload.previous_response_id).toBeUndefined()
  })

  it('sends Qwen OAuth identity headers to the Portal Chat Completions endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Qwen' }, finish_reason: 'stop' }],
    })))
    const resolved = resolveModelProviderConfigs({
      provider: 'qwen-oauth',
      apiKey: 'qwen-access-token',
      model: 'qwen3-coder-plus',
    })

    const result = await createModelClient(resolved.providerConfig, { fetch: fetchMock }).create({
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(result.content).toBe('Qwen')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://portal.qwen.ai/v1/chat/completions')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer qwen-access-token',
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-AuthType': 'qwen-oauth',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      }],
      vl_high_resolution_images: true,
    })
  })

  it('resolves provider configs from explicit api mode with inferred fallback', () => {
    const resolved = resolveModelProviderConfigs({
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'secret',
      model: 'glm-5.2',
      apiMode: 'codex_responses',
    })

    expect(resolved.providerConfig).toMatchObject({
      id: 'glm',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'secret',
      defaultModel: 'glm-5.2',
    })
    expect(resolved.fallbackProviderConfig).toMatchObject({
      requestStyle: 'openai-chat',
      defaultModel: 'glm-5.2',
    })
  })

  it('infers anthropic provider configs from anthropic URLs', () => {
    const resolved = resolveModelProviderConfigs({
      provider: 'custom',
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'glm-5.2',
    })

    expect(resolved.providerConfig).toMatchObject({
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
    })
    expect(resolved.fallbackProviderConfig).toBeUndefined()
  })

  it('converts internal requests to OpenAI-compatible chat payloads', () => {
    const payload = toOpenAIChatPayload(providerConfig, {
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'List files.' },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
      temperature: 0.2,
      maxTokens: 1024,
    })

    expect(payload).toMatchObject({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'List files.' },
      ],
      temperature: 0.2,
      max_tokens: 1024,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
          },
        },
      ],
    })
  })

  it('normalizes OpenAI-compatible responses into the internal shape', () => {
    const response = normalizeOpenAIChatResponse('deepseek', {
      id: 'chatcmpl_1',
      model: 'deepseek-chat',
      choices: [
        {
          message: {
            content: 'Done.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 7 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })

    expect(response).toMatchObject({
      id: 'chatcmpl_1',
      model: 'deepseek-chat',
      content: 'Done.',
      finishReason: 'tool_calls',
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 7,
        reasoningTokens: 2,
      },
      toolCalls: [
        {
          id: 'call_1',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
    })
  })

  it('creates OpenAI-compatible clients through the registry', () => {
    const registry = new ModelProviderRegistry()
    registry.register(providerConfig)

    const client = registry.create('deepseek', {
      fetch: vi.fn(),
    })

    expect(client.provider).toBe('deepseek')
    expect(client.requestStyle).toBe('openai-chat')
    expect(client.capabilities.tools).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  it('creates clients for every supported request style', () => {
    expect(createModelClient({
      id: 'openai-responses',
      type: 'openai',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-4.1',
    }).requestStyle).toBe('openai-responses')

    expect(createModelClient({
      id: 'claude',
      type: 'anthropic',
      defaultModel: 'claude-sonnet',
    }).requestStyle).toBe('anthropic-messages')

    expect(createModelClient({
      id: 'gemini',
      type: 'gemini',
      defaultModel: 'gemini-2.5-pro',
    }).requestStyle).toBe('gemini-contents')

    expect(createModelClient({
      id: 'legacy',
      type: 'custom',
      requestStyle: 'prompt-completion',
      defaultModel: 'legacy-text',
    }).requestStyle).toBe('prompt-completion')

    expect(createModelClient({
      id: 'runtime',
      type: 'custom',
      defaultModel: 'runtime-agent',
    }).requestStyle).toBe('custom-runtime')
  })

  it('converts internal requests to OpenAI Responses payloads', () => {
    const payload = toOpenAIResponsesPayload({
      id: 'openai',
      type: 'openai',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-4.1',
    }, {
      messages: [
        { role: 'system', content: 'Be direct.' },
        { role: 'user', content: 'Search docs.' },
      ],
      tools: [{ name: 'search', parameters: { type: 'object' } }],
      maxTokens: 500,
      context: { responseId: 'resp_previous' },
    })

    expect(payload).toMatchObject({
      model: 'gpt-4.1',
      instructions: 'Be direct.',
      input: [{ role: 'user', content: 'Search docs.' }],
      max_output_tokens: 500,
      previous_response_id: 'resp_previous',
      tools: [{ type: 'function', name: 'search' }],
      store: false,
    })
  })

  it('replays Responses tool calls and results with native input item types', () => {
    const payload = toOpenAIResponsesPayload({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-5.6-terra',
    }, {
      messages: [
        { role: 'user', content: 'Check the weather.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call_weather',
            name: 'web_search',
            arguments: { query: 'Xiamen weather today' },
            rawArguments: '{"query":"Xiamen weather today"}',
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call_weather',
          name: 'web_search',
          content: 'Sunny, 30°C',
        },
      ],
    })

    expect(payload.input).toEqual([
      { role: 'user', content: 'Check the weather.' },
      {
        type: 'function_call',
        call_id: 'call_weather',
        name: 'web_search',
        arguments: '{"query":"Xiamen weather today"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: 'Sunny, 30°C',
      },
    ])
  })

  it('converts internal requests to Anthropic Messages payloads', () => {
    const payload = toAnthropicMessagesPayload({
      id: 'claude',
      type: 'anthropic',
      defaultModel: 'claude-sonnet',
    }, {
      messages: [
        { role: 'system', content: 'Use short answers.' },
        { role: 'user', content: 'Hello.' },
      ],
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
    })

    expect(payload).toMatchObject({
      model: 'claude-sonnet',
      system: 'Use short answers.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
      max_tokens: 4096,
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    })
  })

  it('calls Anthropic-compatible /anthropic bases through /v1/messages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
    }), { status: 200 }))
    const client = new AnthropicMessagesModelClient({
      id: 'custom:glm-anthropic',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'test-key',
      defaultModel: 'glm-5.2',
    }, { fetch: fetchMock })

    const response = await client.create({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.content).toBe('OK')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'x-api-key': 'test-key',
    })
  })

  it('merges Anthropic streaming input, output, and cache usage', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0,"cache_read_input_tokens":80,"cache_creation_input_tokens":5}}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n'))
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n'))
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const client = new AnthropicMessagesModelClient({
      id: 'anthropic',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) events.push(event)

    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 7,
        totalTokens: 107,
        cacheReadTokens: 80,
        cacheWriteTokens: 5,
        reasoningTokens: undefined,
      },
    })
  })

  it('throws Anthropic-compatible JSON error bodies even when HTTP status is 200', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 500,
      msg: '404 NOT_FOUND',
      success: false,
    }), { status: 200 }))
    const client = new AnthropicMessagesModelClient({
      id: 'custom:glm-anthropic',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic/messages',
      apiKey: 'test-key',
      defaultModel: 'glm-5.2',
    }, { fetch: fetchMock })

    await expect(client.create({
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({
      message: '404 NOT_FOUND',
      provider: 'custom:glm-anthropic',
    })
  })

  it('converts internal requests to Gemini Contents payloads', () => {
    const payload = toGeminiContentsPayload({
      id: 'gemini',
      type: 'gemini',
      defaultModel: 'gemini-2.5-pro',
    }, {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello.' },
      ],
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
      temperature: 0.1,
    })

    expect(payload).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello.' }] }],
      generationConfig: { temperature: 0.1 },
      tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    })
  })

  it('converts internal requests to prompt completion payloads', () => {
    const payload = toPromptCompletionPayload({
      id: 'legacy',
      type: 'custom',
      requestStyle: 'prompt-completion',
      defaultModel: 'legacy-text',
    }, {
      messages: [
        { role: 'system', content: 'Instruction.' },
        { role: 'user', content: 'Question.' },
      ],
      maxTokens: 100,
    })

    expect(payload).toEqual({
      model: 'legacy-text',
      prompt: 'SYSTEM: Instruction.\n\nUSER: Question.',
      max_tokens: 100,
      stream: undefined,
      temperature: undefined,
    })
  })

  it('sends requests with provider headers and normalizes the response', async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'chatcmpl_2',
      model: 'deepseek-chat',
      choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }],
    })))

    const client = createModelClient(providerConfig, { fetch: fetchMock })
    const response = await client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(response.content).toBe('Hello.')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
        }),
        body: expect.stringContaining('"model":"deepseek-chat"'),
      }),
    )
  })

  it('throws normalized provider errors for failing HTTP responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: 'rate limited',
      },
    }), { status: 429 }))

    const client = createModelClient(providerConfig, { fetch: fetchMock })

    await expect(client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({
      name: 'ModelProviderError',
      provider: 'deepseek',
      statusCode: 429,
      retryable: true,
      message: 'rate limited',
    } satisfies Partial<ModelProviderError>)
  })

  it('surfaces string provider error bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: '400',
      error: 'Argument not supported: metadata',
    }), { status: 400 }))

    const client = createModelClient(providerConfig, { fetch: fetchMock })
    await expect(client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({
      message: 'Argument not supported: metadata',
      statusCode: 400,
    })
  })

  it('surfaces Codex detail error bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      detail: 'Unsupported parameter: max_output_tokens',
    }), { status: 400 }))

    const client = createModelClient(providerConfig, { fetch: fetchMock })
    await expect(client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({
      message: 'Unsupported parameter: max_output_tokens',
      statusCode: 400,
    })
  })

})
