import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'

import {
  claudeProxyMessages,
  registerClaudeCodeProxyTarget,
} from '../../packages/server/src/services/agent-runner/proxies/claude-code-proxy'

function makeProxyContext(routeKey: string, token: string, body: any): any {
  return {
    params: { key: routeKey },
    request: { body },
    responseHeaders: {} as Record<string, string>,
    get(name: string) {
      if (name.toLowerCase() === 'authorization') return `Bearer ${token}`
      return ''
    },
    set(name: string, value: string) {
      this.responseHeaders[name] = value
    },
  }
}

function encryptedContentError(options: { code?: string | null; message?: string; status?: number } = {}) {
  const {
    code = 'invalid_encrypted_content',
    message = 'Encrypted content could not be decrypted or parsed.',
    status = 400,
  } = options
  return new Response(JSON.stringify({
    error: {
      message,
      ...(code ? { code } : {}),
      type: 'invalid_request_error',
    },
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function eventStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function successfulEventStreamResponse(text = 'continued'): Response {
  return eventStreamResponse([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_retry","type":"message","role":"assistant","model":"review-model","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ])
}

function encryptedContentEventStreamResponse(): Response {
  return eventStreamResponse([
    ': keep-alive\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: er',
    'ror\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_',
    'encrypted_content","message":"Encrypted content could not be decrypted or parsed."}}\n\n',
  ])
}

function continuationBody(stream = false): any {
  return {
    model: 'client-alias',
    stream,
    max_tokens: 64,
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'inspect the repository' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'opaque-signature' },
          { type: 'redacted_thinking', data: 'opaque-redacted-payload' },
          { type: 'text', text: 'I will read the file.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' }],
      },
    ],
  }
}

function requestBody(fetchMock: any, index: number): any {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Claude Code custom Anthropic continuation compatibility', () => {
  it('retries a custom provider invalid encrypted-content response without opaque thinking history', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:compat-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentError())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_retry_ok',
        type: 'message',
        role: 'assistant',
        model: 'review-model',
        content: [{ type: 'text', text: 'continued' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const originalBody = continuationBody()
    originalBody.messages.push({ role: 'user', content: 'preserve string content' })
    const originalSnapshot = structuredClone(originalBody)
    const ctx = makeProxyContext(target.routeKey, target.token, originalBody)
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(originalBody).toEqual(originalSnapshot)
    const firstBody = requestBody(fetchMock, 0)
    const retryBody = requestBody(fetchMock, 1)
    expect(firstBody).toEqual({ ...originalSnapshot, model: 'review-model' })
    expect(firstBody.messages[1].content.map((block: any) => block.type)).toEqual([
      'thinking', 'redacted_thinking', 'text', 'tool_use',
    ])
    expect(retryBody).toMatchObject({
      model: 'review-model',
      thinking: { type: 'adaptive' },
    })
    expect(retryBody.messages[1].content).toEqual([
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
    ])
    expect(retryBody.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' },
    ])
    expect(ctx.body.content).toEqual([{ type: 'text', text: 'continued' }])
  })

  it('applies the same one-time compatibility retry to streaming continuations', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:stream-compat-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentError())
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_retry","type":"message","role":"assistant","model":"review-model","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n'))
          controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'))
          controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"continued"}}\n\n'))
          controller.enqueue(encoder.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'))
          controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'))
          controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
          controller.close()
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, continuationBody(true))
    await claudeProxyMessages(ctx)
    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(Buffer.from(chunk).toString('utf8'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retryBody = requestBody(fetchMock, 1)
    expect(retryBody.messages[1].content.map((block: any) => block.type)).toEqual(['text', 'tool_use'])
    expect(chunks.join('')).toContain('continued')
  })

  it('retries when a successful HTTP response carries an encrypted-content SSE error', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:sse-error-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentEventStreamResponse())
      .mockResolvedValueOnce(successfulEventStreamResponse('continued after SSE retry'))
    vi.stubGlobal('fetch', fetchMock)

    const body = continuationBody(true)
    const snapshot = structuredClone(body)
    const ctx = makeProxyContext(target.routeKey, target.token, body)
    await claudeProxyMessages(ctx)
    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(Buffer.from(chunk).toString('utf8'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body).toEqual(snapshot)
    expect(requestBody(fetchMock, 0).messages[1].content.map((block: any) => block.type)).toEqual([
      'thinking', 'redacted_thinking', 'text', 'tool_use',
    ])
    expect(requestBody(fetchMock, 1).messages[1].content.map((block: any) => block.type)).toEqual(['text', 'tool_use'])
    expect(chunks.join('')).toContain('continued after SSE retry')
    expect(chunks.join('')).not.toContain('invalid_encrypted_content')
  })

  it('does not retry again when the SSE compatibility retry also returns the same error', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:sse-retry-once-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentEventStreamResponse())
      .mockResolvedValueOnce(encryptedContentEventStreamResponse())
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, continuationBody(true))
    await claudeProxyMessages(ctx)
    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(Buffer.from(chunk).toString('utf8'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(chunks.join('')).toContain('invalid_encrypted_content')
  })

  it('does not make a third request when an HTTP compatibility retry returns an SSE error', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:http-then-sse-error-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentError())
      .mockResolvedValueOnce(encryptedContentEventStreamResponse())
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, continuationBody(true))
    await claudeProxyMessages(ctx)
    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(Buffer.from(chunk).toString('utf8'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(fetchMock, 1).messages[1].content.map((block: any) => block.type)).toEqual(['text', 'tool_use'])
    expect(chunks.join('')).toContain('invalid_encrypted_content')
  })

  it('retries an exact encrypted-content message when the provider omits the error code', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:message-only-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentError({
        code: null,
        message: 'The encrypted content opaque-value could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_message_retry_ok',
        type: 'message',
        role: 'assistant',
        model: 'review-model',
        content: [{ type: 'text', text: 'continued' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, continuationBody())
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ctx.body.content).toEqual([{ type: 'text', text: 'continued' }])
  })

  it('does not retry a near-match encrypted-content message', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:near-match-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn(async () => encryptedContentError({
      code: null,
      message: 'prefix: Encrypted content could not be decrypted or parsed. Please change the request.',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, continuationBody())
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe(400)
  })

  it('retries at most once and preserves the second provider error', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:retry-once-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentError())
      .mockResolvedValueOnce(encryptedContentError({ message: 'The encrypted content could not be verified.' }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, continuationBody())
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ctx.status).toBe(400)
    expect(ctx.body.error.provider_error.error.message).toBe('The encrypted content could not be verified.')
  })

  it('does not retry when no opaque thinking block can be removed safely', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:no-opaque-history-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const body = continuationBody()
    body.messages[1].content = body.messages[1].content.filter((block: any) => !['thinking', 'redacted_thinking'].includes(block.type))
    const fetchMock = vi.fn(async () => encryptedContentError())
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, body)
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe(400)
  })

  it('retries after dropping a historical message that contains only opaque thinking', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:empty-message-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'provider-key',
      apiMode: 'anthropic_messages',
    })
    const body = continuationBody()
    body.messages[1].content = [{ type: 'thinking', thinking: '', signature: 'opaque-signature' }]
    const snapshot = structuredClone(body)
    const logFile = resolve(tmpdir(), 'hermes-web-ui-test-logs', String(process.pid), 'server.log')
    const logOffset = statSync(logFile).size
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(encryptedContentError())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_empty_history_retry_ok',
        type: 'message',
        role: 'assistant',
        model: 'review-model',
        content: [{ type: 'text', text: 'continued' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, body)
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body).toEqual(snapshot)
    expect(requestBody(fetchMock, 0).messages).toEqual(snapshot.messages)
    expect(requestBody(fetchMock, 1).messages).toEqual([
      snapshot.messages[0],
      snapshot.messages[2],
    ])
    expect(ctx.body.content).toEqual([{ type: 'text', text: 'continued' }])
    const logDelta = readFileSync(logFile).subarray(logOffset).toString('utf8')
    expect(logDelta).toContain('retrying without historical opaque thinking')
    expect(logDelta).toContain('"provider":"custom:empty-message-provider"')
    expect(logDelta).toContain('"status":400')
    expect(logDelta).toContain('"removedBlocks":1')
    expect(logDelta).toContain('"removedMessages":1')
    expect(logDelta).toContain('"retryStarted":true')
    expect(logDelta).not.toContain('opaque-signature')
    expect(logDelta).not.toContain('provider-key')
    expect(logDelta).not.toContain('Encrypted content')
  })

  it('does not retry when removing opaque-only messages would leave no history', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:all-opaque-history-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'provider-key',
      apiMode: 'anthropic_messages',
    })
    const body = continuationBody()
    body.messages = [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', signature: 'opaque-signature' }],
    }]
    const fetchMock = vi.fn(async () => encryptedContentError())
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, body)
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe(400)
  })

  it('does not retry matching messages with a non-400 status or a transport exception', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:status-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const statusFetch = vi.fn(async () => encryptedContentError({ status: 422 }))
    vi.stubGlobal('fetch', statusFetch)
    const statusCtx = makeProxyContext(target.routeKey, target.token, continuationBody())
    await claudeProxyMessages(statusCtx)
    expect(statusFetch).toHaveBeenCalledTimes(1)
    expect(statusCtx.status).toBe(422)

    const transportFetch = vi.fn(async () => { throw new Error('socket closed') })
    vi.stubGlobal('fetch', transportFetch)
    const transportCtx = makeProxyContext(target.routeKey, target.token, continuationBody())
    await claudeProxyMessages(transportCtx)
    expect(transportFetch).toHaveBeenCalledTimes(1)
    expect(transportCtx.status).toBe(502)
  })

  it('does not alter or retry official Anthropic provider failures', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn(async () => encryptedContentError())
    vi.stubGlobal('fetch', fetchMock)

    const body = continuationBody()
    const ctx = makeProxyContext(target.routeKey, target.token, body)
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestBody(fetchMock, 0).messages[1].content).toEqual(body.messages[1].content)
    expect(ctx.status).toBe(400)
    expect(ctx.body.error.provider_error.error.code).toBe('invalid_encrypted_content')
  })

  it('does not retry unrelated custom-provider bad requests', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'custom:strict-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'upstream-key',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'max_tokens is invalid', code: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, continuationBody())
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe(400)
    expect(ctx.body.error.provider_error.error.code).toBe('invalid_request_error')
  })
})
