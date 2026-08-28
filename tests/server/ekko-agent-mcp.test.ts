import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupEkkoAgent, type EkkoAgentSetup } from '../../packages/ekko-agent/src'

const configMock = vi.hoisted(() => ({
  port: 8648,
  appHome: '/Users/test/.hermes-web-ui',
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: configMock,
}))

describe('Ekko MCP server context', () => {
  let baseDirectory = ''
  let setup: EkkoAgentSetup

  beforeEach(() => {
    delete process.env.HERMES_DESKTOP
    delete process.env.HERMES_AGENT_NODE
    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_MCP_BIN
    configMock.port = 8648
    configMock.appHome = '/Users/test/.hermes-web-ui'
    baseDirectory = mkdtempSync(join(tmpdir(), 'ekko-mcp-context-'))
    setup = setupEkkoAgent({ baseDirectory, profiles: ['work'], env: { NODE_ENV: 'test' } })
  })

  afterEach(() => {
    setup.close()
    rmSync(baseDirectory, { recursive: true, force: true })
  })

  it('builds managed MCP servers for the current Web UI port and profile', async () => {
    const { buildManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')

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
    expect(servers['hermes-studio-browser']).toMatchObject({
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'browser'],
      env: { HERMES_WEB_UI_PROFILE: 'work', HERMES_MCP_TOOLSET: 'browser' },
    })
    expect(servers['hermes-studio-devices']).toMatchObject({
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'devices'],
      env: { HERMES_WEB_UI_PROFILE: 'work', HERMES_MCP_TOOLSET: 'devices' },
    })
    expect(servers['hermes-studio-use']).toMatchObject({
      args: [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'use'],
      env: { HERMES_WEB_UI_PROFILE: 'work', HERMES_MCP_TOOLSET: 'use' },
    })
  })

  it('injects managed servers into config and merges caller-provided overrides', async () => {
    const {
      injectManagedEkkoMcpServers,
      resolveEkkoMcpServers,
    } = await import('../../packages/server/src/modules/ekko/services/mcp')

    const injection = injectManagedEkkoMcpServers(setup)
    expect(injection.targets).toEqual(expect.arrayContaining([
      { profile: 'default', status: 'injected' },
      { profile: 'work', status: 'injected' },
    ]))
    expect(setup.config.getMcpServer('hermes-studio-browser', 'work')).toMatchObject({
      enabled: true,
      env: { HERMES_WEB_UI_PROFILE: 'work' },
    })

    const servers = resolveEkkoMcpServers('default', {
      'hermes-studio-api': { command: 'custom-api' },
      custom: { command: 'custom-mcp' },
    }, setup)

    expect(servers?.['hermes-studio-api']).toEqual({ command: 'custom-api' })
    expect(servers?.custom).toEqual({ command: 'custom-mcp' })
    expect(servers?.['hermes-studio-browser']).toBeDefined()
    expect(servers?.['hermes-studio-devices']).toBeDefined()
    expect(servers?.['hermes-studio-use']).toBeDefined()
  })

  it('preserves a disabled managed server while refreshing its injected definition', async () => {
    const {
      injectManagedEkkoMcpServers,
      setEkkoMcpServerEnabled,
    } = await import('../../packages/server/src/modules/ekko/services/mcp')

    injectManagedEkkoMcpServers(setup)
    await setEkkoMcpServerEnabled('work', 'hermes-studio-api', false, setup)
    configMock.port = 8748
    const reinjection = injectManagedEkkoMcpServers(setup)

    expect(reinjection.targets).toContainEqual({ profile: 'work', status: 'updated' })
    expect(setup.config.getMcpServer('hermes-studio-api', 'work')).toMatchObject({
      enabled: false,
      env: { HERMES_WEB_UI_URL: 'http://127.0.0.1:8748' },
    })
  })

  it('keeps the browser toolset available for the Electron desktop runtime', async () => {
    process.env.HERMES_DESKTOP = 'true'
    const { buildManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')
    const browser = buildManagedEkkoMcpServers('default')['hermes-studio-browser'] as any
    expect(browser.args).toEqual([join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'browser'])
    expect(browser.env.HERMES_MCP_TOOLSET).toBe('browser')
  })

  it('does not inject managed servers when autoinject is disabled or transient', async () => {
    const {
      injectManagedEkkoMcpServers,
      resolveEkkoMcpServers,
    } = await import('../../packages/server/src/modules/ekko/services/mcp')

    process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT = '1'
    expect(injectManagedEkkoMcpServers(setup).targets).toEqual([])
    expect(resolveEkkoMcpServers('default', undefined, setup)).toBeUndefined()
    expect(resolveEkkoMcpServers('default', { custom: { command: 'custom-mcp' } }, setup)).toEqual({
      custom: { command: 'custom-mcp' },
    })

    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    configMock.appHome = '/private/tmp/wui-preview-home'
    expect(injectManagedEkkoMcpServers(setup).targets).toEqual([])
    expect(resolveEkkoMcpServers('default', undefined, setup)).toBeUndefined()

    process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT = '1'
    injectManagedEkkoMcpServers(setup)
    expect(resolveEkkoMcpServers('default', undefined, setup)?.['hermes-studio-api']).toBeDefined()
  })
})
