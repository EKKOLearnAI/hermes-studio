import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../config'

const MANAGED_ENV_KEY = 'HERMES_WEB_UI_MANAGED_MCP'
const MANAGED_SERVERS = [
  { name: 'hermes-studio-api', toolset: 'api' },
  { name: 'hermes-studio-devices', toolset: 'devices' },
  { name: 'hermes-studio-use', toolset: 'use' },
] as const

export type EkkoMcpServers = Record<string, unknown>

function isEnabledEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function allowTransientAutoinject(): boolean {
  return isEnabledEnv(process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT)
}

function normalizedPathPrefix(pathname: string): string {
  return pathname.replace(/\/+$/, '') + '/'
}

function isTransientAppHome(appHome: string): boolean {
  const normalized = normalizedPathPrefix(appHome)
  const transientRoots = [tmpdir(), '/tmp', '/private/tmp']
    .filter(Boolean)
    .map(root => normalizedPathPrefix(root))
  return transientRoots.some(root => normalized.startsWith(root))
}

function shouldIncludeManagedMcpServers(): boolean {
  if (isEnabledEnv(process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT)) return false
  return !isTransientAppHome(config.appHome) || allowTransientAutoinject()
}

function candidateBundledMcpScripts(): string[] {
  return [
    process.env.HERMES_WEB_UI_MCP_BIN,
    join(process.cwd(), 'bin/hermes-studio-mcp.mjs'),
    join(__dirname, '../../bin/hermes-studio-mcp.mjs'),
    join(__dirname, '../../../../../bin/hermes-studio-mcp.mjs'),
    join(process.cwd(), 'bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../../../../bin/hermes-web-ui-mcp.mjs'),
  ].filter((value): value is string => !!value)
}

function bundledMcpScriptPath(): string | null {
  return candidateBundledMcpScripts().find(candidate => existsSync(candidate)) || null
}

function runtimeNodePath(): string | null {
  const node = process.env.HERMES_AGENT_NODE?.trim()
  return node || null
}

function managedCommandConfig(toolset: string): Record<string, unknown> {
  const bundledScript = bundledMcpScriptPath()
  if (bundledScript) {
    return { command: runtimeNodePath() || process.execPath, args: [bundledScript, toolset] }
  }

  if (isDesktopRuntime()) {
    return { command: 'hermes-studio-mcp', args: [toolset] }
  }

  return { command: 'hermes-studio-mcp', args: [toolset] }
}

function managedMcpServerConfig(profile: string, serverName: string, toolset: string): Record<string, unknown> {
  return {
    ...managedCommandConfig(toolset),
    env: {
      HERMES_WEB_UI_URL: `http://127.0.0.1:${config.port}`,
      HERMES_WEB_UI_HOME: config.appHome,
      HERMES_WEBUI_STATE_DIR: config.appHome,
      HERMES_WEB_UI_PROFILE: profile,
      HERMES_MCP_SERVER_NAME: serverName,
      HERMES_MCP_TOOLSET: toolset,
      [MANAGED_ENV_KEY]: '1',
    },
    enabled: true,
  }
}

export function buildManagedEkkoMcpServers(profile: string): EkkoMcpServers {
  if (!shouldIncludeManagedMcpServers()) return {}

  return Object.fromEntries(
    MANAGED_SERVERS.map(server => [
      server.name,
      managedMcpServerConfig(profile, server.name, server.toolset),
    ]),
  )
}

export function resolveEkkoMcpServers(profile: string, provided?: EkkoMcpServers): EkkoMcpServers | undefined {
  const managed = buildManagedEkkoMcpServers(profile)
  const merged = {
    ...managed,
    ...(provided || {}),
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}
