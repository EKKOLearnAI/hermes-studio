import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProxyMessages, claudeProxyModels, registerClaudeCodeProxyTarget } from '../../packages/server/src/services/claude-code-proxy'
import { codexProxyModels, codexProxyResponses, registerCodexProxyTarget } from '../../packages/server/src/services/codex-proxy'
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

  it('launches Codex with the global config when requested', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      mode: 'global',
      profile: 'default',
    })

    expect(result).toMatchObject({
      agentId: 'codex',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      rootDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      workspaceDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'codex',
      args: [],
      env: {},
      shellCommand: `cd ${join(home, 'coding-agent', 'workspace', 'default', 'global')} && codex`,
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

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain('requires_openai_auth = false')
    expect(config).toContain(`model_catalog_json = "${join(result.rootDir, 'codex-model-catalog.json')}"`)

    const catalog = JSON.parse(readFileSync(join(result.rootDir, 'codex-model-catalog.json'), 'utf-8'))
    expect(catalog.models.some((entry: any) => entry.slug === 'openai/gpt-oss-20b:free')).toBe(true)
    expect(catalog.models[0]).toHaveProperty('base_instructions')
    expect(catalog.models[0]).toHaveProperty('model_messages')
  })

  it('points Codex Chat Completions providers at the local Responses proxy', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain(`base_url = "http://127.0.0.1:8648/api/codex-proxy/`)
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('requires_openai_auth = false')
    expect(config).toMatch(/experimental_bearer_token = "hwui_[^"]+"/)
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'deepseek', 'codex'))

    const catalog = JSON.parse(readFileSync(join(result.rootDir, 'codex-model-catalog.json'), 'utf-8'))
    const deepseekModel = catalog.models.find((entry: any) => entry.slug === 'deepseek-v4-pro')
    expect(deepseekModel).toMatchObject({
      display_name: 'Deepseek V4 Pro',
    })
    expect(deepseekModel.context_window).toBeGreaterThan(0)
    expect(deepseekModel.max_context_window).toBe(deepseekModel.context_window)
    expect(deepseekModel.model_messages.instructions_template).toContain('{{ base_instructions }}')
  })

  it('points Codex Anthropic Messages providers at the local Responses proxy', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain(`base_url = "http://127.0.0.1:8648/api/codex-proxy/`)
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('requires_openai_auth = false')
    expect(config).toMatch(/experimental_bearer_token = "hwui_[^"]+"/)
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'anthropic-compatible', 'codex'))
  })

  it('adapts Codex Responses requests to OpenAI Chat Completions', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl_test',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'ok' },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      max_output_tokens: 16,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'be terse' }] },
      ],
    })

    await codexProxyResponses(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-upstream' }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      model: 'deepseek-v4-pro',
      max_tokens: 16,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'be terse' },
      ],
    })
    expect(ctx.body.output[0].content[0].text).toBe('ok')
    expect(ctx.body.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 })
  })

  it('adapts Codex Responses requests to Anthropic Messages', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'repo' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      instructions: 'be terse',
      max_output_tokens: 64,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call_output', call_id: 'call_0', output: 'done' },
      ],
      tools: [{
        type: 'function',
        name: 'search',
        description: 'Search files',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    })

    await codexProxyResponses(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-upstream',
        'x-api-key': 'sk-upstream',
        'anthropic-version': '2023-06-01',
      }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      model: 'claude-sonnet-4-6',
      system: 'be terse',
      max_tokens: 64,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'done' }] },
      ],
      tools: [{
        name: 'search',
        description: 'Search files',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    })
    expect(ctx.body.output[0].content[0].text).toBe('ok')
    expect(ctx.body.output[1]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'search',
      arguments: '{"query":"repo"}',
    })
    expect(ctx.body.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
  })

  it('streams Codex proxy text as complete Responses message events', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"p"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ong"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    })

    await codexProxyResponses(ctx)

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(sse).toContain('event: response.output_item.added')
    expect(sse).toContain('event: response.content_part.added')
    expect(sse).toContain('"delta":"p"')
    expect(sse).toContain('"delta":"ong"')
    expect(sse).toContain('event: response.output_text.done')
    expect(sse).toContain('"text":"pong"')
    expect(sse).toContain('event: response.output_item.done')
    expect(sse).toContain('"output":[{"type":"message"')
  })

  it('streams Codex proxy Anthropic text as Responses message events', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","usage":{"input_tokens":3,"output_tokens":0}}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}\n\n'))
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    })

    await codexProxyResponses(ctx)

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
    }))
    expect(sse).toContain('event: response.output_item.added')
    expect(sse).toContain('"delta":"he"')
    expect(sse).toContain('"delta":"llo"')
    expect(sse).toContain('event: response.output_text.done')
    expect(sse).toContain('"text":"hello"')
    expect(sse).toContain('event: response.completed')
  })

  it('exposes Codex proxy models with route-token authentication', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const ctx = makeProxyContext(routeKey, token, {})

    await codexProxyModels(ctx)

    expect(ctx.body).toMatchObject({
      object: 'list',
      data: [{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }],
    })
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

  it('keeps Claude proxy routes separate for the same model with different protocols', () => {
    const chat = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-chat',
      apiMode: 'chat_completions',
    })
    const anthropic = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-anthropic',
      apiMode: 'anthropic_messages',
    })

    expect(chat.routeKey).not.toBe(anthropic.routeKey)
    expect(chat.token).not.toBe(anthropic.token)
  })

  it('keeps Codex proxy routes separate for the same model with different upstream URLs', () => {
    const first = registerCodexProxyTarget({
      profile: 'default',
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-one',
      apiMode: 'chat_completions',
    })
    const second = registerCodexProxyTarget({
      profile: 'default',
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-two.example.com/v1',
      apiKey: 'sk-two',
      apiMode: 'chat_completions',
    })

    expect(first.routeKey).not.toBe(second.routeKey)
    expect(first.token).not.toBe(second.token)
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
