import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateConfigYamlForProfileMock = vi.fn()
const listProfileNamesFromDiskMock = vi.fn()
const configMock = vi.hoisted(() => ({
  port: 8648,
  appHome: '/Users/test/.hermes-web-ui',
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  updateConfigYamlForProfile: updateConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  listProfileNamesFromDisk: listProfileNamesFromDiskMock,
}))

vi.mock('../../packages/server/src/config', () => ({
  config: configMock,
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
    delete process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT
    configMock.port = 8648
    configMock.appHome = '/Users/test/.hermes-web-ui'
    listProfileNamesFromDiskMock.mockReturnValue(['default', 'work'])
    updateConfigYamlForProfileMock.mockImplementation(async (_profile: string, updater: any) => {
      const updated = await updater({})
      return updated.result
    })
  })

  it('injects bundled MCP server into every profile without relying on a global PATH shim', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets.map(target => target.profile)).toEqual(['default', 'work'])
    expect(updateConfigYamlForProfileMock).toHaveBeenCalledTimes(2)
    const injectedDefault = await updateConfigYamlForProfileMock.mock.calls[0][1]({})
    expect(injectedDefault.data.mcp_servers['hermes-studio-api']).toEqual({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'api'],
      env: {
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_HOME: '/Users/test/.hermes-web-ui',
        HERMES_WEBUI_STATE_DIR: '/Users/test/.hermes-web-ui',
        HERMES_WEB_UI_PROFILE: 'default',
        HERMES_MCP_SERVER_NAME: 'hermes-studio-api',
        HERMES_MCP_TOOLSET: 'api',
        HERMES_WEB_UI_MANAGED_MCP: '1',
      },
      enabled: true,
    })
    expect(injectedDefault.data.mcp_servers['hermes-studio-devices']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'devices'],
      env: {
        HERMES_MCP_SERVER_NAME: 'hermes-studio-devices',
        HERMES_MCP_TOOLSET: 'devices',
      },
      enabled: true,
    })
    expect(injectedDefault.data.mcp_servers['hermes-studio-use']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'use'],
      env: {
        HERMES_MCP_SERVER_NAME: 'hermes-studio-use',
        HERMES_MCP_TOOLSET: 'use',
      },
      enabled: true,
    })
    const injectedWork = await updateConfigYamlForProfileMock.mock.calls[1][1]({})
    expect(injectedWork.data.mcp_servers['hermes-studio-api'].env.HERMES_WEB_UI_PROFILE).toBe('work')
    expect(result.serverNames).toEqual(['hermes-studio-api', 'hermes-studio-devices', 'hermes-studio-use'])
    expect(result.command).toBe(process.execPath)
  })

  it('skips autoinject for transient preview homes by default', async () => {
    configMock.appHome = '/private/tmp/wui-preview-home'
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets).toEqual([])
    expect(updateConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('allows transient preview autoinject when explicitly requested', async () => {
    configMock.appHome = '/private/tmp/wui-preview-home'
    process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT = '1'
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    expect(updateConfigYamlForProfileMock).toHaveBeenCalledTimes(2)
  })

  it('respects a user-disabled managed MCP server entry', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio-api': {
          command: process.execPath,
          args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'api'],
          env: {
            HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
            HERMES_WEB_UI_HOME: '/Users/test/.hermes-web-ui',
            HERMES_WEBUI_STATE_DIR: '/Users/test/.hermes-web-ui',
            HERMES_WEB_UI_PROFILE: 'default',
            HERMES_MCP_SERVER_NAME: 'hermes-studio-api',
            HERMES_MCP_TOOLSET: 'api',
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: false,
        },
      },
    })

    expect(updated.write).toBe(false)
    expect(updated.result).toMatchObject({
      status: 'skipped',
      reason: 'existing hermes-studio-api MCP server is disabled by user',
    })
    expect(updated.data.mcp_servers['hermes-studio-api'].enabled).toBe(false)
  })

  it('cleans a disabled legacy managed MCP server entry before injecting split servers', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio': {
          command: 'hermes-web-ui-mcp',
          env: {
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: false,
        },
      },
    })

    expect(updated.write).not.toBe(false)
    expect(updated.result).toMatchObject({
      status: 'updated',
    })
    expect(updated.data.mcp_servers['hermes-studio']).toBeUndefined()
    expect(updated.data.mcp_servers['hermes-studio-api']).toBeDefined()
    expect(updated.data.mcp_servers['hermes-studio-devices']).toBeDefined()
    expect(updated.data.mcp_servers['hermes-studio-use']).toBeDefined()
  })

  it('updates old managed PATH-only MCP entries to the bundled node script', async () => {
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
            HERMES_WEB_UI_PROFILE: 'default',
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: true,
        },
        'hermes-web-ui-mcp': {
          command: 'hermes-web-ui-mcp',
          env: {
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: true,
        },
      },
    })
    expect(updated.result.status).toBe('updated')
    expect(updated.data.mcp_servers['hermes-studio']).toBeUndefined()
    expect(updated.data.mcp_servers['hermes-web-ui-mcp']).toBeUndefined()
    expect(updated.data.mcp_servers['hermes-studio-api'].command).toBe(process.execPath)
    expect(updated.data.mcp_servers['hermes-studio-api'].args).toEqual([join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'api'])
    expect(updated.data.mcp_servers['hermes-studio-devices'].args).toEqual([join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'devices'])
    expect(updated.data.mcp_servers['hermes-studio-use'].args).toEqual([join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'use'])
  })

  it('prefers bundled script over bare desktop command in desktop runtime', async () => {
    process.env.HERMES_DESKTOP = 'true'
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    const injected = await updateConfigYamlForProfileMock.mock.calls[0][1]({})
    // Even in desktop runtime, the bundled script should take priority
    // so the MCP client receives an absolute path that works regardless of PATH.
    expect(injected.data.mcp_servers['hermes-studio-api'].command).toBe(process.execPath)
    expect(injected.data.mcp_servers['hermes-studio-api'].args).toEqual([
      join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'api',
    ])
    expect(injected.data.mcp_servers['hermes-studio-devices'].args).toEqual([
      join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'devices',
    ])
    expect(injected.data.mcp_servers['hermes-studio-use'].args).toEqual([
      join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'use',
    ])
  })

  it('removes stale injected tokens from managed server config', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/services/hermes/studio-mcp-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio-api': {
          command: 'hermes-web-ui-mcp',
          args: ['api'],
          env: {
            HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
            HERMES_WEB_UI_HOME: '/tmp/hermes-web-ui-home',
            HERMES_WEBUI_STATE_DIR: '/tmp/hermes-web-ui-home',
            HERMES_WEB_UI_PROFILE: 'default',
            HERMES_MCP_SERVER_NAME: 'hermes-studio-api',
            HERMES_MCP_TOOLSET: 'api',
            HERMES_WEB_UI_MANAGED_MCP: '1',
            HERMES_WEB_UI_TOKEN: 'old-token',
          },
          enabled: true,
        },
      },
    })
    expect(updated.result.status).toBe('updated')
    expect(updated.data.mcp_servers['hermes-studio-api'].env.HERMES_WEB_UI_TOKEN).toBeUndefined()
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
