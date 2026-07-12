import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicMessagesModelClient,
  ModelProviderError,
  ModelProviderRegistry,
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
    })
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
})
