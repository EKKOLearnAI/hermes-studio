import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRunGateway, ProviderApiError } from '../../packages/server/src/services/agent-runner/gateway'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent run gateway', () => {
  it('posts JSON requests with bearer auth and custom headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new AgentRunGateway().completeJson({
      url: 'https://api.example.com/v1/messages',
      apiKey: 'sk-test',
      headers: { 'x-api-key': 'sk-test' },
      body: { model: 'm' },
    })

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-test',
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test',
      }),
      body: '{"model":"m"}',
    }))
  })

  it('throws structured provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'bad key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })))

    await expect(new AgentRunGateway().completeJson({
      url: 'https://api.example.com/v1/messages',
      apiKey: 'sk-test',
      body: {},
    })).rejects.toMatchObject({
      name: 'ProviderApiError',
      status: 401,
      providerError: { error: { message: 'bad key' } },
      message: 'bad key',
    } satisfies Partial<ProviderApiError>)
  })

  it('returns provider byte streams', async () => {
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('chunk'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))

    const stream = await new AgentRunGateway().streamBytes({
      url: 'https://api.example.com/v1/responses',
      apiKey: 'sk-test',
      body: { stream: true },
    })

    const chunks: string[] = []
    for await (const chunk of stream) chunks.push(new TextDecoder().decode(chunk))
    expect(chunks).toEqual(['chunk'])
  })

  it('rejects JSON error bodies returned with HTTP 200 for stream requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 500,
      msg: '404 NOT_FOUND',
      success: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(new AgentRunGateway().streamBytes({
      url: 'https://api.example.com/v1/messages',
      apiKey: 'sk-test',
      body: { stream: true },
    })).rejects.toMatchObject({
      name: 'ProviderApiError',
      status: 200,
      providerError: { code: 500, msg: '404 NOT_FOUND', success: false },
    } satisfies Partial<ProviderApiError>)
  })
})
