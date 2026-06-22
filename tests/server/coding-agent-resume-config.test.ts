import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const updateSessionMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const safeReadFileMock = vi.fn()
const startRunMock = vi.fn()

vi.doMock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}))

vi.doMock('../../packages/server/src/services/config-helpers', () => ({
  PROVIDER_ENV_MAP: {
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' },
  },
  readConfigYamlForProfile: readConfigYamlForProfileMock,
  safeReadFile: safeReadFileMock,
}))

vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-profile/${profile}`,
}))

vi.doMock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: {
    start: startRunMock,
  },
}))

const homes: string[] = []

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-resume-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  return home
}

describe('coding agent resumed session config', () => {
  beforeEach(() => {
    vi.resetModules()
    getSessionMock.mockReset()
    updateSessionMock.mockReset()
    readConfigYamlForProfileMock.mockReset()
    safeReadFileMock.mockReset()
    startRunMock.mockReset()
    startRunMock.mockReturnValue({ runId: 'agent-session-1', pid: 0 })
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('rebuilds Claude scoped proxy credentials from stored provider config after restart', async () => {
    const home = makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom:corp-claude',
      model: 'claude-sonnet-test',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'corp-claude',
        base_url: 'https://provider.example/anthropic',
        api_key: 'sk-upstream',
        model: 'claude-sonnet-test',
        api_mode: 'anthropic_messages',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    await startCodingAgentRun('claude-code', { sessionId: 'session-1' })

    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'agent-session-1',
      provider: 'custom:corp-claude',
      model: 'claude-sonnet-test',
      sessionId: 'session-1',
    }))
    const launch = startRunMock.mock.calls[0][0]
    expect(launch.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(launch.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
    const settings = JSON.parse(readFileSync(join(home, 'coding-agent', 'model', 'default', 'custom_corp-claude', 'claude-code', 'settings.json'), 'utf-8'))
    expect(settings.env.ANTHROPIC_API_KEY).toBe(launch.env.ANTHROPIC_API_KEY)
  })

  it('recovers legacy sanitized custom provider keys from existing sessions', async () => {
    const home = makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom_glm-coding-plan',
      model: 'glm-5-turbo',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'glm-coding-plan',
        base_url: 'https://api.z.ai/api/anthropic',
        api_key: 'sk-glm',
        model: 'glm-5-turbo',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    const result = await startCodingAgentRun('claude-code', { sessionId: 'session-1' })

    expect(result.provider).toBe('custom:glm-coding-plan')
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      provider: 'custom:glm-coding-plan',
      agent_native_session_id: expect.any(String),
    }))
    const launch = startRunMock.mock.calls[0][0]
    expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
    expect(Buffer.from(launch.env.ANTHROPIC_BASE_URL.split('/').pop() || '', 'base64url').toString('utf8')).toContain('anthropic_messages')
    const settings = JSON.parse(readFileSync(join(home, 'coding-agent', 'model', 'default', 'custom_glm-coding-plan', 'claude-code', 'settings.json'), 'utf-8'))
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
  })

  it('preserves the stored workspace when a coding agent session switches provider and model', async () => {
    const home = makeHome()
    const originalWorkspace = join(home, 'coding-agent', 'workspace', 'default', 'openrouter')
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'old-native-thread',
      provider: 'openrouter',
      model: 'old-model',
      workspace: originalWorkspace,
    })

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    await startCodingAgentRun('codex', {
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      apiMode: 'chat_completions',
    })

    const launch = startRunMock.mock.calls[0][0]
    expect(launch.workspaceDir).toBe(originalWorkspace)
    expect(launch.agentNativeSessionId).toBe('')
    expect(launch.nativeResume).toBe(false)
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      agent_native_session_id: '',
      workspace: originalWorkspace,
    }))
  })

  it('ignores a stale builtin base URL when the requested provider changed', async () => {
    const home = makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_session_id: 'agent-session-1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('DEEPSEEK_API_KEY=sk-deepseek\n')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    await startCodingAgentRun('codex', {
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'sk-xiaomi',
      apiMode: 'chat_completions',
    })

    const config = readFileSync(join(home, 'coding-agent', 'model', 'default', 'deepseek', 'codex', 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const routeParts = Buffer.from(routeKey, 'base64url').toString('utf8').split('\0')
    expect(routeParts).toEqual(expect.arrayContaining([
      'deepseek',
      'deepseek-v4-pro',
      'chat_completions',
      'https://api.deepseek.com',
    ]))
    expect(routeParts).not.toContain('https://api.xiaomimimo.com/v1')
  })

  it('resumes Claude with a stored native session id after service restart', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: '11111111-1111-4111-8111-111111111111',
      provider: 'custom:corp-claude',
      model: 'claude-sonnet-test',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'corp-claude',
        base_url: 'https://provider.example/anthropic',
        api_key: 'sk-upstream',
        model: 'claude-sonnet-test',
        api_mode: 'anthropic_messages',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    await startCodingAgentRun('claude-code', { sessionId: 'session-1' })

    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentNativeSessionId: '11111111-1111-4111-8111-111111111111',
      nativeResume: true,
    }))
  })

  it('does not resume a stored scoped Codex native session when launching global mode', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_mode: 'scoped',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'codex-scoped-thread',
      provider: 'custom:glm-coding-plan',
      model: 'glm-5-turbo',
    })
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    const result = await startCodingAgentRun('codex', { sessionId: 'session-1', mode: 'global' })

    expect(result).toEqual(expect.objectContaining({
      mode: 'global',
      provider: 'global',
      model: '',
    }))
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'agent-session-1',
      agentNativeSessionId: '',
      nativeResume: false,
      provider: 'global',
      model: '',
      env: {},
      args: [],
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      agent_mode: 'global',
      agent_native_session_id: '',
      provider: 'global',
      model: '',
    }))
  })

  it('rejects OAuth/subscription providers for scoped coding-agent launches', async () => {
    makeHome()
    getSessionMock.mockReturnValue(null)
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    await expect(startCodingAgentRun('codex', {
      sessionId: 'session-1',
      mode: 'scoped',
      profile: 'default',
      provider: 'copilot',
      model: 'gpt-5.5',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'oauth-token',
      apiMode: 'codex_responses',
    })).rejects.toThrow('does not support OAuth/subscription providers')
    expect(startRunMock).not.toHaveBeenCalled()
  })

  it('fails clearly instead of launching Claude without scoped credentials', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom:missing',
      model: 'claude-sonnet-test',
    })
    readConfigYamlForProfileMock.mockResolvedValue({ custom_providers: [] })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    await expect(startCodingAgentRun('claude-code', { sessionId: 'session-1' }))
      .rejects.toThrow('Coding agent provider credentials are missing')
    expect(startRunMock).not.toHaveBeenCalled()
  })

  it('resolves custom-provider credentials from key_env on continuation', async () => {
    const home = makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom:sensenova',
      model: 'deepseek-v4-flash',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'sensenova',
        base_url: 'https://api.sensenova.cn/v1',
        key_env: 'SENSENOVA_API_KEY',
        model: 'deepseek-v4-flash',
      }],
    })
    safeReadFileMock.mockResolvedValue('SENSENOVA_API_KEY=sk-from-env\n')

    const { startCodingAgentRun } = await import('../../packages/server/src/services/coding-agents')
    await expect(startCodingAgentRun('claude-code', { sessionId: 'session-1' })).resolves.toEqual(
      expect.objectContaining({
        provider: 'custom:sensenova',
      }),
    )
    expect(startRunMock).toHaveBeenCalled()
    expect(home).toBeTruthy()
  })
})
