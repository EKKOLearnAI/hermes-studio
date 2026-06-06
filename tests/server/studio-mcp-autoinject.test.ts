import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateConfigYamlForProfileMock = vi.fn()
const listProfileNamesFromDiskMock = vi.fn()

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  updateConfigYamlForProfile: updateConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  listProfileNamesFromDisk: listProfileNamesFromDiskMock,
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    port: 8648,
    appHome: '/tmp/hermes-web-ui-home',
  },
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('studio MCP autoinject', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete process.env.HERMES_DESKTOP
    delete process.env.AUTH_TOKEN
    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    listProfileNamesFromDiskMock.mockReturnValue(['default', 'work'])
    updateConfigYamlForProfileMock.mockImplementation(async (_profile: string, updater: any) => {
      const updated = await updater({})
      return updated.result
    })
  })

  it('injects bundled MCP server into every profile without bridge calls', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets.map(target => target.profile)).toEqual(['default', 'work'])
    expect(updateConfigYamlForProfileMock).toHaveBeenCalledTimes(2)
    const injectedDefault = await updateConfigYamlForProfileMock.mock.calls[0][1]({})
    expect(injectedDefault.data.mcp_servers['hermes-studio']).toEqual({
      command: 'hermes-web-ui-mcp',
      env: {
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_HOME: '/tmp/hermes-web-ui-home',
        HERMES_WEBUI_STATE_DIR: '/tmp/hermes-web-ui-home',
        HERMES_WEB_UI_MANAGED_MCP: '1',
      },
      enabled: true,
    })
  })

  it('uses the desktop command in desktop runtime', async () => {
    process.env.HERMES_DESKTOP = 'true'
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    const injected = await updateConfigYamlForProfileMock.mock.calls[0][1]({})
    expect(injected.data.mcp_servers['hermes-studio'].command).toBe('hermes-studio-mcp')
  })

  it('removes stale injected tokens from managed server config', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio': {
          command: 'hermes-web-ui-mcp',
          env: {
            HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
            HERMES_WEB_UI_HOME: '/tmp/hermes-web-ui-home',
            HERMES_WEBUI_STATE_DIR: '/tmp/hermes-web-ui-home',
            HERMES_WEB_UI_MANAGED_MCP: '1',
            HERMES_WEB_UI_TOKEN: 'old-token',
          },
          enabled: true,
        },
      },
    })
    expect(updated.result.status).toBe('updated')
    expect(updated.data.mcp_servers['hermes-studio'].env.HERMES_WEB_UI_TOKEN).toBeUndefined()
  })

  it('skips an unmanaged existing server entry', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio': { command: 'custom-command' },
      },
    })
    expect(updated.write).toBe(false)
    expect(updated.result.status).toBe('skipped')
  })
})
