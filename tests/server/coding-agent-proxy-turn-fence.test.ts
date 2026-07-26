import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudeProxyMessages,
  registerClaudeCodeProxyTarget,
} from '../../packages/server/src/services/agent-runner/proxies/claude-code-proxy'
import {
  codexProxyResponses,
  registerCodexProxyTarget,
} from '../../packages/server/src/services/agent-runner/proxies/codex-proxy'
import { codingAgentRunManager } from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'

function proxyContext(routeKey: string, token: string, body: any): any {
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function responsesStream(): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_old","status":"in_progress"}}\n\n'))
      controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"late old output"}\n\n'))
      controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_old","status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n'))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function consume(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // Consuming the client branch also drives the observer branch.
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Coding Agent proxy request turn fencing', () => {
  it('captures the Claude run identity before waiting for upstream response headers', async () => {
    const agentSessionId = 'claude-proxy-delayed-headers'
    const target = registerClaudeCodeProxyTarget({
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'provider-key',
      apiMode: 'codex_responses',
      agentSessionId,
    })
    let eventToken = 'turn-old'
    let incarnationToken = 'inc-old'
    vi.spyOn(codingAgentRunManager, 'eventTokenForAgentSession').mockImplementation(() => eventToken)
    vi.spyOn(codingAgentRunManager, 'incarnationTokenForAgentSession').mockImplementation(() => incarnationToken)
    const handleResponse = vi.spyOn(codingAgentRunManager, 'handleResponseEvent').mockImplementation(() => {})
    vi.spyOn(codingAgentRunManager, 'handleProxyUsageEvent').mockImplementation(() => {})
    const upstream = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => upstream.promise))

    const ctx = proxyContext(target.routeKey, target.token, { stream: true, input: 'ping' })
    const pending = claudeProxyMessages(ctx)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    eventToken = 'turn-new'
    incarnationToken = 'inc-new'
    upstream.resolve(responsesStream())
    await pending
    await consume(ctx.body)

    expect(handleResponse).toHaveBeenCalled()
    for (const call of handleResponse.mock.calls) {
      expect(call[2]).toBe('turn-old')
      expect(call[3]).toBe('inc-old')
    }
  })

  it('captures the Codex run identity before waiting for upstream response headers', async () => {
    const agentSessionId = 'codex-proxy-delayed-headers'
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'provider-key',
      apiMode: 'codex_responses',
      agentSessionId,
    })
    let eventToken = 'turn-old'
    let incarnationToken = 'inc-old'
    vi.spyOn(codingAgentRunManager, 'eventTokenForAgentSession').mockImplementation(() => eventToken)
    vi.spyOn(codingAgentRunManager, 'incarnationTokenForAgentSession').mockImplementation(() => incarnationToken)
    const handleResponse = vi.spyOn(codingAgentRunManager, 'handleResponseEvent').mockImplementation(() => {})
    vi.spyOn(codingAgentRunManager, 'handleProxyUsageEvent').mockImplementation(() => {})
    const upstream = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => upstream.promise))

    const ctx = proxyContext(target.routeKey, target.token, { stream: true, input: 'ping' })
    const pending = codexProxyResponses(ctx)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    eventToken = 'turn-new'
    incarnationToken = 'inc-new'
    upstream.resolve(responsesStream())
    await pending
    await consume(ctx.body)

    expect(handleResponse).toHaveBeenCalled()
    for (const call of handleResponse.mock.calls) {
      expect(call[2]).toBe('turn-old')
      expect(call[3]).toBe('inc-old')
    }
  })
})
