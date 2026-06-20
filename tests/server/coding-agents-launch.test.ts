import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeProxyMessages, claudeProxyModels, registerClaudeCodeProxyTarget } from '../../packages/server/src/services/agent-runner/proxies/claude-code-proxy'
import { codexProxyModels, codexProxyResponses, registerCodexProxyTarget } from '../../packages/server/src/services/agent-runner/proxies/codex-proxy'
import { prepareCodingAgentLaunch } from '../../packages/server/src/services/coding-agents'

const homes: string[] = []

function mockProcessUid(uid: number) {
  vi.spyOn(process, 'getuid').mockReturnValue(uid)
  vi.spyOn(process, 'geteuid').mockReturnValue(uid)
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-launch-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = join(home, 'global-home')
  return home
}

beforeEach(() => {
  mockProcessUid(1000)
})

afterEach(() => {
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  vi.restoreAllMocks()
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
      args: [
        '--append-system-prompt-file',
        join(home, 'global-home', '.claude', 'hermes-rules.md'),
        '--dangerously-skip-permissions',
      ],
      env: {},
      shellCommand: `cd ${join(home, 'coding-agent', 'workspace', 'default', 'global')} && claude --append-system-prompt-file ${join(home, 'global-home', '.claude', 'hermes-rules.md')} --dangerously-skip-permissions`,
      files: [{
        key: 'prompt',
        path: '~/.claude/hermes-rules.md',
        absolutePath: join(home, 'global-home', '.claude', 'hermes-rules.md'),
      }],
    })
    const prompt = readFileSync(join(home, 'global-home', '.claude', 'hermes-rules.md'), 'utf-8')
    expect(prompt).toContain('<!-- BEGIN HERMES WEB UI PROMPT -->')
    expect(prompt).toContain('# 输出格式规范')
  })

  it('uses Claude Code auto permission mode instead of dangerous bypass when running as root', async () => {
    mockProcessUid(0)
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      mode: 'global',
      profile: 'default',
    })

    expect(result).toMatchObject({
      agentId: 'claude-code',
      mode: 'global',
      rootDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'claude',
      args: [
        '--append-system-prompt-file',
        join(home, 'global-home', '.claude', 'hermes-rules.md'),
        '--permission-mode',
        'auto',
      ],
      shellCommand: `cd ${join(home, 'coding-agent', 'workspace', 'default', 'global')} && claude --append-system-prompt-file ${join(home, 'global-home', '.claude', 'hermes-rules.md')} --permission-mode auto`,
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

  it('preserves existing global Claude Code prompt files while updating the Hermes block', async () => {
    const home = makeHome()
    const claudePromptPath = join(home, 'global-home', '.claude', 'hermes-rules.md')
    mkdirSync(dirname(claudePromptPath), { recursive: true })
    writeFileSync(claudePromptPath, 'Existing Claude notes\n')

    await prepareCodingAgentLaunch('claude-code', { mode: 'global', profile: 'default' })
    await prepareCodingAgentLaunch('claude-code', { mode: 'global', profile: 'default' })

    const claudePrompt = readFileSync(claudePromptPath, 'utf-8')
    expect(claudePrompt).toContain('Existing Claude notes')
    expect(claudePrompt.match(/BEGIN HERMES WEB UI PROMPT/g)).toHaveLength(1)
  })

  it('uses a selected workspace directory when launching a coding agent', async () => {
    const home = makeHome()
    const workspace = join(home, 'selected workspace')

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      workspace,
    })

    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex'))
    expect(result.workspaceDir).toBe(workspace)
    expect(result.shellCommand).toContain(workspace)
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
      '--append-system-prompt-file',
      join(result.rootDir, 'hermes-rules.md'),
      '--dangerously-skip-permissions',
    ])
    expect(result.shellCommand).toContain(`cd ${join(home, 'coding-agent', 'workspace', 'default', 'openrouter')} &&`)
    expect(result.shellCommand).toContain(join(result.rootDir, 'launch.sh'))
    expect(result.shellCommand).not.toContain('ANTHROPIC_API_KEY')
    expect(result.shellCommand).not.toContain('hwui_')
    expect(result.shellCommand).not.toContain('--model')
    const launcher = readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8')
    expect(launcher).toContain('exec claude --settings')
    expect(launcher).toContain('--dangerously-skip-permissions')
    expect(launcher).not.toContain('--model')

    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.model).toBe('cognitivecomputations/dolphin-mistral-24b-venice-edition:free')
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(settings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
    expect(settings.env).toMatchObject({
      ANTHROPIC_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
    })
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toBe('claude-sonnet-4-6')

    const mcp = JSON.parse(readFileSync(join(result.rootDir, 'mcp.json'), 'utf-8'))
    expect(mcp.mcpServers['hermes-studio-api']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'api'],
      env: {
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_HOME: home,
        HERMES_WEBUI_STATE_DIR: home,
        HERMES_WEB_UI_PROFILE: 'default',
        HERMES_MCP_SERVER_NAME: 'hermes-studio-api',
        HERMES_MCP_TOOLSET: 'api',
        HERMES_WEB_UI_MANAGED_MCP: '1',
      },
    })
    expect(mcp.mcpServers['hermes-studio-devices']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'devices'],
      env: {
        HERMES_MCP_SERVER_NAME: 'hermes-studio-devices',
        HERMES_MCP_TOOLSET: 'devices',
      },
    })
    expect(mcp.mcpServers['hermes-studio-use']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'use'],
      env: {
        HERMES_MCP_SERVER_NAME: 'hermes-studio-use',
        HERMES_MCP_TOOLSET: 'use',
      },
    })

    const prompt = readFileSync(join(result.rootDir, 'hermes-rules.md'), 'utf-8')
    expect(prompt).toContain('# 输出格式规范')
    expect(prompt).toContain('当你的回复中包含图片、视频或文件引用时')
  })

  it('cleans legacy Hermes MCP entries from scoped Claude and Codex configs', async () => {
    const home = makeHome()
    const claudeRoot = join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code')
    const claudeMcpPath = join(claudeRoot, 'mcp.json')
    mkdirSync(dirname(claudeMcpPath), { recursive: true })
    writeFileSync(claudeMcpPath, `${JSON.stringify({
      mcpServers: {
        'hermes-studio': {
          command: 'hermes-web-ui-mcp',
          env: { HERMES_WEB_UI_MANAGED_MCP: '1' },
        },
        'hermes-web-ui-mcp': {
          command: 'hermes-web-ui-mcp',
          env: { HERMES_WEB_UI_MANAGED_MCP: '1' },
        },
        custom: {
          command: 'custom-mcp',
        },
      },
    }, null, 2)}\n`)

    const claude = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })
    const claudeMcp = JSON.parse(readFileSync(join(claude.rootDir, 'mcp.json'), 'utf-8'))
    expect(claudeMcp.mcpServers['hermes-studio']).toBeUndefined()
    expect(claudeMcp.mcpServers['hermes-web-ui-mcp']).toBeUndefined()
    expect(claudeMcp.mcpServers.custom).toEqual({ command: 'custom-mcp' })
    expect(claudeMcp.mcpServers['hermes-studio-api']).toBeDefined()
    expect(claudeMcp.mcpServers['hermes-studio-devices']).toBeDefined()
    expect(claudeMcp.mcpServers['hermes-studio-use']).toBeDefined()

    const codexRoot = join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex')
    const codexConfigPath = join(codexRoot, 'config.toml')
    mkdirSync(dirname(codexConfigPath), { recursive: true })
    writeFileSync(codexConfigPath, [
      '[mcp_servers.hermes-studio]',
      'command = "hermes-web-ui-mcp"',
      '[mcp_servers.hermes-web-ui-mcp]',
      'command = "hermes-web-ui-mcp"',
      '',
    ].join('\n'))

    const codex = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })
    const codexConfig = readFileSync(join(codex.rootDir, 'config.toml'), 'utf-8')
    expect(codexConfig).not.toContain('[mcp_servers.hermes-studio]')
    expect(codexConfig).not.toContain('[mcp_servers.hermes-web-ui-mcp]')
    expect(codexConfig).toContain('[mcp_servers.hermes-studio-api]')
    expect(codexConfig).toContain('[mcp_servers.hermes-studio-devices]')
    expect(codexConfig).toContain('[mcp_servers.hermes-studio-use]')
  })

  it('isolates Claude Code settings for hidden chat runs only', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      isolateSettings: true,
    })

    expect(result.args).toEqual([
      '--settings',
      join(result.rootDir, 'settings.json'),
      '--setting-sources',
      'local',
      '--mcp-config',
      join(result.rootDir, 'mcp.json'),
      '--append-system-prompt-file',
      join(result.rootDir, 'hermes-rules.md'),
      '--dangerously-skip-permissions',
    ])
    expect(result.shellCommand).not.toContain('--setting-sources local')
    const launcher = readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8')
    expect(launcher).toContain('--setting-sources local')
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code'))
  })

  it('uses Claude Code auto permission mode for scoped root launches', async () => {
    mockProcessUid(0)
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      isolateSettings: true,
    })

    expect(result.args).toEqual([
      '--settings',
      join(result.rootDir, 'settings.json'),
      '--setting-sources',
      'local',
      '--mcp-config',
      join(result.rootDir, 'mcp.json'),
      '--append-system-prompt-file',
      join(result.rootDir, 'hermes-rules.md'),
      '--permission-mode',
      'auto',
    ])
    const launcher = readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8')
    expect(launcher).toContain('--permission-mode auto')
    expect(launcher).not.toContain('--dangerously-skip-permissions')
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code'))
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
    expect(settings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
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
    expect(config).toContain('model_reasoning_summary = "auto"')
    expect(config).toContain('developer_instructions = """')
    expect(config).toContain('Hermes Studio MCP usage')
    expect(config).toContain('# 输出格式规范')
    expect(config).toContain('[mcp_servers.hermes-studio-api]')
    expect(config).toContain('[mcp_servers.hermes-studio-devices]')
    expect(config).toContain('[mcp_servers.hermes-studio-use]')
    expect(config).toContain(`command = "${process.execPath}"`)
    expect(config).toContain(`args = ["${join(process.cwd(), 'bin/hermes-studio-mcp.mjs')}", "api"]`)
    expect(config).toContain(`args = ["${join(process.cwd(), 'bin/hermes-studio-mcp.mjs')}", "devices"]`)
    expect(config).toContain(`args = ["${join(process.cwd(), 'bin/hermes-studio-mcp.mjs')}", "use"]`)
    expect(config).toContain(`env = { HERMES_WEB_UI_URL = "http://127.0.0.1:8648", HERMES_WEB_UI_HOME = "${home}"`)
    expect(config).toContain('HERMES_WEBUI_STATE_DIR = "')
    expect(config).toContain('HERMES_WEB_UI_PROFILE = "default"')
    expect(config).toContain('HERMES_MCP_SERVER_NAME = "hermes-studio-api"')
    expect(config).toContain('HERMES_MCP_SERVER_NAME = "hermes-studio-devices"')
    expect(config).toContain('HERMES_MCP_SERVER_NAME = "hermes-studio-use"')
    expect(config).toContain('HERMES_MCP_TOOLSET = "api"')
    expect(config).toContain('HERMES_MCP_TOOLSET = "devices"')
    expect(config).toContain('HERMES_MCP_TOOLSET = "use"')
    expect(config).toContain('HERMES_WEB_UI_MANAGED_MCP = "1"')

    expect(result.files.some(file => file.key === 'agents')).toBe(false)

    const catalog = JSON.parse(readFileSync(join(result.rootDir, 'codex-model-catalog.json'), 'utf-8'))
    expect(catalog.models.some((entry: any) => entry.slug === 'openai/gpt-oss-20b:free')).toBe(true)
    expect(catalog.models[0]).toHaveProperty('base_instructions')
    expect(catalog.models[0]).toHaveProperty('model_messages')
    expect(catalog.models[0]).toHaveProperty('default_reasoning_summary', 'auto')
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

  it('points Codex Responses providers at the local Responses proxy for stream capture', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openai-api',
      model: 'gpt-5.5',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
      sessionId: 'chat-session-1',
      agentSessionId: 'agent-session-1',
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain(`base_url = "http://127.0.0.1:8648/api/codex-proxy/`)
    expect(config).toMatch(/experimental_bearer_token = "hwui_[^"]+"/)
    expect(config).not.toContain('base_url = "https://api.openai.com/v1"')
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openai-api', 'codex'))
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

  it('keeps proxy routes separate for different hidden agent sessions', () => {
    const first = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-one',
      apiMode: 'chat_completions',
      agentSessionId: 'agent-one',
      chatSessionId: 'chat-one',
    })
    const second = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-two',
      apiMode: 'chat_completions',
      agentSessionId: 'agent-two',
      chatSessionId: 'chat-two',
    })

    expect(first.routeKey).not.toBe(second.routeKey)
    expect(first.token).not.toBe(second.token)
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
