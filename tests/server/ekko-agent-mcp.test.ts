import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const configMock = vi.hoisted(() => ({
  port: 8648,
  appHome: '/Users/test/.hermes-web-ui',
}))

vi.mock('../../packages/server/src/config', () => ({
  config: configMock,
}))

describe('Ekko MCP server context', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.HERMES_DESKTOP
    delete process.env.HERMES_AGENT_NODE
    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_MCP_BIN
    configMock.port = 8648
    configMock.appHome = '/Users/test/.hermes-web-ui'
  })

  it('builds managed MCP servers for the current Web UI port and profile', async () => {
    const { buildManagedEkkoMcpServers } = await import('../../packages/server/src/services/ekko-agent/mcp')

    const servers = buildManagedEkkoMcpServers('work')

    expect(servers['hermes-studio-api']).toEqual({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'api'],
      env: {
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_HOME: '/Users/test/.hermes-web-ui',
        HERMES_WEBUI_STATE_DIR: '/Users/test/.hermes-web-ui',
        HERMES_WEB_UI_PROFILE: 'work',
        HERMES_MCP_SERVER_NAME: 'hermes-studio-api',
        HERMES_MCP_TOOLSET: 'api',
        HERMES_WEB_UI_MANAGED_MCP: '1',
      },
      enabled: true,
    })
    expect(servers['hermes-studio-devices']).toMatchObject({
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'devices'],
      env: {
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_PROFILE: 'work',
        HERMES_MCP_TOOLSET: 'devices',
      },
    })
    expect(servers['hermes-studio-use']).toMatchObject({
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'use'],
      env: {
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_PROFILE: 'work',
        HERMES_MCP_TOOLSET: 'use',
      },
    })
  })

  it('merges caller-provided MCP servers and lets explicit entries override managed defaults', async () => {
    const { resolveEkkoMcpServers } = await import('../../packages/server/src/services/ekko-agent/mcp')

    const servers = resolveEkkoMcpServers('default', {
      'hermes-studio-api': { command: 'custom-api' },
      custom: { command: 'custom-mcp' },
    })

    expect(servers?.['hermes-studio-api']).toEqual({ command: 'custom-api' })
    expect(servers?.custom).toEqual({ command: 'custom-mcp' })
    expect(servers?.['hermes-studio-devices']).toBeDefined()
    expect(servers?.['hermes-studio-use']).toBeDefined()
  })

  it('does not add managed MCP servers when startup autoinject is disabled or skipped', async () => {
    process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT = '1'
    let mod = await import('../../packages/server/src/services/ekko-agent/mcp')

    expect(mod.resolveEkkoMcpServers('default')).toBeUndefined()
    expect(mod.resolveEkkoMcpServers('default', { custom: { command: 'custom-mcp' } })).toEqual({
      custom: { command: 'custom-mcp' },
    })

    vi.resetModules()
    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    configMock.appHome = '/private/tmp/wui-preview-home'
    mod = await import('../../packages/server/src/services/ekko-agent/mcp')

    expect(mod.resolveEkkoMcpServers('default')).toBeUndefined()

    vi.resetModules()
    process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT = '1'
    mod = await import('../../packages/server/src/services/ekko-agent/mcp')

    expect(mod.resolveEkkoMcpServers('default')?.['hermes-studio-api']).toBeDefined()
  })
})
