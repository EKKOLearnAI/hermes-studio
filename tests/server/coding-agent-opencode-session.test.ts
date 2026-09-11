import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProxyMessages, registerClaudeCodeProxyTarget } from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'
import { codexProxyResponses, registerCodexProxyTarget } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'

afterEach(() => vi.unstubAllGlobals())

describe.each(['claude-code', 'codex', 'pi', 'grok', 'opencode'])('%s OpenCode provider requests', agentId => {
  it.each(['chat_completions', 'codex_responses', 'anthropic_messages'] as const)(
    'preserves chat affinity across native sessions and streaming with %s', async apiMode => {
      const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (JSON.parse(String(init?.body)).stream) {
          return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        }
        return Response.json({
          id: 'response-1', model: 'test-model', role: 'assistant', type: 'message',
          choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          content: [{ type: 'text', text: 'OK' }], output: [], stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      for (const [index, chatSessionId] of ['chat-a', 'chat-a', 'chat-b'].entries()) {
        const input = {
          profile: 'default', provider: 'opencode-go', model: 'test-model',
          baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'test-key', apiMode,
          agentId, agentSessionId: `native-${index}`, chatSessionId,
        }
        const target = agentId === 'claude-code' ? registerClaudeCodeProxyTarget(input) : registerCodexProxyTarget(input)
        const ctx: any = {
          params: { key: target.routeKey },
          request: { body: {
            model: 'test-model', stream: index === 1,
            input: 'Hello', messages: [{ role: 'user', content: 'Hello' }],
          } },
          get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${target.token}` : '',
          set: vi.fn(),
        }
        if (agentId === 'claude-code') await claudeProxyMessages(ctx)
        else await codexProxyResponses(ctx)
        expect(ctx.status || 200).toBeLessThan(400)
        if (index === 1) for await (const _chunk of ctx.body) { /* drain stream */ }
      }
      expect(fetchMock).toHaveBeenCalledTimes(3)
      const ids = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-opencode-session'))
      expect(ids[0]).toMatch(/^[a-f0-9]{64}$/)
      expect(ids[1]).toBe(ids[0])
      expect(ids[2]).not.toBe(ids[0])
    },
  )
})
