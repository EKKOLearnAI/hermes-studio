import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProxyMessages, claudeProxyModels, registerClaudeCodeProxyTarget } from '../../packages/server/src/services/claude-code-proxy'
import { prepareCodingAgentLaunch } from '../../packages/server/src/services/coding-agents'

const homes: string[] = []

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-launch-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  return home
}

afterEach(() => {
  delete process.env.HERMES_WEB_UI_HOME
  vi.unstubAllGlobals()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

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

describe('coding agent launch preparation', () => {
  it('launches Claude Code with the global config when requested', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      mode: 'global',
      profile: 'default',
    })

    expect(result).toMatchObject({
      agentId: 'claude-code',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      rootDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      workspaceDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'claude',
      args: [],
      env: {},
      shellCommand: `cd ${join(home, 'coding-agent', 'workspace', 'default', 'global')} && claude`,
      files: [],
    })
  })

  it('launches Claude Code with scoped settings instead of a CLI --model override', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })

    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code'))
    expect(result.workspaceDir).toBe(join(home, 'coding-agent', 'workspace', 'default', 'openrouter'))
    expect(result.args).toEqual([
      '--settings',
      join(result.rootDir, 'settings.json'),
      '--mcp-config',
      join(result.rootDir, 'mcp.json'),
    ])
    expect(result.shellCommand).toContain(`cd ${join(home, 'coding-agent', 'workspace', 'default', 'openrouter')} && claude`)
    expect(result.shellCommand).not.toContain('--model')

    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
    expect(settings.env).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    })
    expect(settings.env).not.toHaveProperty('ANTHROPIC_MODEL')
  })

  it('keeps Claude Code protocol overrides behind the local proxy', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      apiMode: 'anthropic_messages',
    })

    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
  })

  it('keeps Codex model selection on the CLI while isolating CODEX_HOME', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })

    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex'))
    expect(result.workspaceDir).toBe(join(home, 'coding-agent', 'workspace', 'default', 'openrouter'))
    expect(result.args).toEqual(['--model', 'openai/gpt-oss-20b:free'])
    expect(result.env).toEqual({ CODEX_HOME: result.rootDir })
  })

  it('adapts Claude Code streaming requests to the Responses API for codex_responses providers', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'fun-codex',
      model: 'gpt-5.5',
      baseUrl: 'https://api.apikey.fun/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":1}}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    })

    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.apikey.fun/v1/responses', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-upstream' }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
      store: false,
      max_output_tokens: 32,
      input: [{ role: 'user', content: 'hello' }],
    })

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(ctx.responseHeaders['Content-Type']).toContain('text/event-stream')
    expect(sse).toContain('event: message_start')
    expect(sse).toContain('"type":"text_delta","text":"hi"')
    expect(sse).toContain('event: message_stop')
  })

  it('round-trips reasoning_content for DeepSeek-style OpenAI Chat tool calls', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl_test',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          reasoning_content: 'Need to inspect the repository first.',
          content: null,
          tool_calls: [{
            id: 'call_2',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"proxy"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      max_tokens: 32,
      messages: [
        { role: 'user', content: 'check it' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need the current repo files.' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'reasoning_content' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'found one file' },
          ],
        },
      ],
    })

    await claudeProxyMessages(ctx)

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.messages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'Need the current repo files.',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"reasoning_content"}' },
      }],
    })
    expect(ctx.body.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Need to inspect the repository first.',
    })
    expect(ctx.body.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'call_2',
      name: 'search',
      input: { query: 'proxy' },
    })
  })

  it('passes Anthropic Messages providers through the local proxy without exposing upstream credentials', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'fun-claude',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.apikey.fun',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      model: 'ignored-client-model',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    })

    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.apikey.fun/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-upstream',
        'x-api-key': 'sk-upstream',
      }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.model).toBe('claude-sonnet-4-6')
    expect(ctx.body.content[0].text).toBe('hi')
  })

  it('exposes Claude-visible alias models from the local proxy models endpoint', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'openrouter',
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })
    const ctx = makeProxyContext(target.routeKey, target.token, {})

    await claudeProxyModels(ctx)

    const ids = ctx.body.data.map((model: any) => model.id)
    expect(ids).toContain('claude-haiku-4-5')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-opus-4-7')
    expect(ids).toContain('cognitivecomputations/dolphin-mistral-24b-venice-edition:free')
  })
})
