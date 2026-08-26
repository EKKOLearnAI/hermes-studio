import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexProxyResponses, registerCodexProxyTarget } from '../../packages/server/src/services/coding-agents/codex/proxy'

function proxyContext(routeKey: string, token: string, headers: Record<string, string>): any {
  return {
    params: { key: routeKey },
    request: { body: { model: 'ignored-by-proxy', input: 'hello', stream: false } },
    get(name: string) {
      if (name.toLowerCase() === 'authorization') return `Bearer ${token}`
      return headers[name.toLowerCase()] || ''
    },
    set: vi.fn(),
    status: 200,
    body: undefined,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Codex proxy request identity', () => {
  it('forwards only the Codex identity allowlist and retains Provider API-key authentication', async () => {
    const target = registerCodexProxyTarget({
      profile: 'identity-test',
      provider: 'custom:relay',
      model: 'gpt-5-codex',
      baseUrl: 'https://relay.example',
      apiKey: 'relay-key',
      apiMode: 'codex_responses',
      preserveCodexIdentity: true,
      agentId: 'codex',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'resp_test', object: 'response', output: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await codexProxyResponses(proxyContext(target.routeKey, target.token, {
      'user-agent': 'codex_cli_rs/0.1.0',
      originator: 'codex_cli_rs',
      'openai-beta': 'responses=experimental',
      'x-openai-client-user-agent': '{"application":"codex"}',
      'x-stainless-lang': 'rust',
      'x-stainless-package-version': '0.1.0',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'tokio',
      'x-stainless-runtime-version': '1.0.0',
      cookie: 'must-not-forward',
      'x-untrusted-header': 'must-not-forward',
    }))

    expect(fetchMock).toHaveBeenCalledWith('https://relay.example/v1/responses', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer relay-key',
        'User-Agent': 'codex_cli_rs/0.1.0',
        Originator: 'codex_cli_rs',
        'OpenAI-Beta': 'responses=experimental',
        'X-Stainless-Lang': 'rust',
        'X-Stainless-Runtime-Version': '1.0.0',
      }),
    }))
    const sentHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(sentHeaders.Authorization).toBe('Bearer relay-key')
    expect(sentHeaders.cookie).toBeUndefined()
    expect(sentHeaders['x-untrusted-header']).toBeUndefined()
  })

  it('keeps Codex identity metadata opt-in', async () => {
    const target = registerCodexProxyTarget({
      profile: 'identity-disabled-test',
      provider: 'custom:relay',
      model: 'gpt-5-codex',
      baseUrl: 'https://relay.example',
      apiKey: 'relay-key',
      apiMode: 'codex_responses',
      agentId: 'codex',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'resp_test', object: 'response', output: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await codexProxyResponses(proxyContext(target.routeKey, target.token, {
      'user-agent': 'codex_cli_rs/0.1.0',
      originator: 'codex_cli_rs',
      'openai-beta': 'responses=experimental',
    }))

    const sentHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(sentHeaders['User-Agent']).toBeUndefined()
    expect(sentHeaders.Originator).toBeUndefined()
    expect(sentHeaders['OpenAI-Beta']).toBeUndefined()
  })

  it('uses a separate proxy route for Codex and Pi', () => {
    const common = {
      profile: 'identity-isolation-test',
      provider: 'custom:relay',
      model: 'gpt-5-codex',
      baseUrl: 'https://relay.example',
      apiKey: 'relay-key',
      apiMode: 'codex_responses' as const,
      agentSessionId: 'shared-agent-session',
      chatSessionId: 'shared-chat-session',
    }
    const codex = registerCodexProxyTarget({ ...common, agentId: 'codex', preserveCodexIdentity: true })
    const pi = registerCodexProxyTarget({ ...common, agentId: 'pi' })

    expect(codex.routeKey).not.toBe(pi.routeKey)
    expect(codex.token).not.toBe(pi.token)
  })
})
