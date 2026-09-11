import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, createModelClient } from '../../packages/ekko-agent/src'
import type { ModelProviderConfig, ModelRequest } from '../../packages/ekko-agent/src'
import { openCodeSessionHeaders } from '../../packages/ekko-agent/src/model/opencode-session'

const baseUrl = 'https://opencode.ai/zen/go/v1'
const config: ModelProviderConfig = {
  id: 'opencode-go', type: 'openai-compatible', baseUrl, defaultModel: 'test-model', apiKey: 'test-key',
}
const request: ModelRequest = { messages: [{ role: 'user', content: 'Hello' }], metadata: { session_id: 'conversation-a' } }
const affinity = (init?: RequestInit) => new Headers(init?.headers).get('x-opencode-session')

describe('OpenCode session affinity', () => {
  it('recognizes OpenCode hosts and named proxies without matching unrelated URLs', () => {
    for (const url of [baseUrl, 'https://opencode.ai/zen/v1', 'https://api.opencode.ai/v1']) {
      expect(openCodeSessionHeaders(url, 'conversation-a')['x-opencode-session']).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(openCodeSessionHeaders('https://proxy.example/v1', 'conversation-a', 'custom:opencode-go'))
      .toEqual(openCodeSessionHeaders(baseUrl, 'conversation-a'))
    for (const url of ['https://opencode.ai.evil.example/v1', 'https://example.com/opencode.ai', 'https://notopencode.ai', 'invalid']) {
      expect(openCodeSessionHeaders(url, 'conversation-a')).toEqual({})
    }
    expect(openCodeSessionHeaders(baseUrl)).not.toEqual(openCodeSessionHeaders(baseUrl))
  })

  it.each(['openai-chat', 'openai-responses', 'anthropic-messages'] as const)(
    'keeps concurrent conversations isolated across create and stream with %s', async requestStyle => {
      const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (JSON.parse(String(init?.body)).stream) return new Response('data: [DONE]\n\n')
        return Response.json({ choices: [{ message: { content: 'OK' } }], content: [{ type: 'text', text: 'OK' }], output: [] })
      })
      const client = createModelClient({ ...config, requestStyle }, { fetch: fetchMock })
      await Promise.all([
        client.create(request),
        client.create({ ...request, metadata: { session_id: 'conversation-b' } }),
      ])
      for await (const _event of client.stream({ ...request })) { /* drain */ }
      await client.create({ ...request })
      const ids = fetchMock.mock.calls.map(([, init]) => affinity(init))
      expect(ids[0]).toMatch(/^[a-f0-9]{64}$/)
      expect(ids[1]).not.toBe(ids[0])
      expect(ids[2]).toBe(ids[0])
      expect(ids[3]).toBe(ids[0])
      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization') ||
        new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-api-key')).toContain('test-key')
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty('metadata.session_id')
    },
  )

  it('keeps runtime turns and retries on the same backend using the context key', async () => {
    let calls = 0
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      if (++calls === 1) return Response.json({ error: { message: 'retry' } }, { status: 503 })
      return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
    })
    const client = createModelClient({ ...config, capabilities: { streaming: false } }, { fetch: fetchMock })
    const runtime = new AgentRuntime({ modelClient: client, maxModelRetries: 1 })
    for (const contextKey of ['session-a', 'session-a', 'session-b']) {
      await runtime.run({ messages: ['Hello'], contextKey })
    }
    const ids = fetchMock.mock.calls.map(([, init]) => affinity(init))
    expect(ids).toHaveLength(4)
    expect(ids[0]).toBe(ids[1])
    expect(ids[1]).toBe(ids[2])
    expect(ids[3]).not.toBe(ids[0])
  })

  it('adds affinity to custom OpenCode URLs and leaves other providers alone', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ choices: [] }))
    for (const url of [baseUrl, 'https://api.example.com/v1']) {
      await createModelClient({ ...config, id: 'my-provider', baseUrl: url }, { fetch: fetchMock }).create(request)
    }
    expect(affinity(fetchMock.mock.calls[0][1])).toBeTruthy()
    expect(affinity(fetchMock.mock.calls[1][1])).toBeNull()
  })

  it('reuses an anonymous request scope when the same request is retried', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ choices: [] }))
    const client = createModelClient(config, { fetch: fetchMock })
    const anonymous = { messages: request.messages }
    await client.create(anonymous)
    await client.create(anonymous)
    await client.create({ messages: request.messages })
    const ids = fetchMock.mock.calls.map(([, init]) => affinity(init))
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })
})
