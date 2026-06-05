import { config } from '../../config'
import { updateConfigYamlForProfile } from '../config-helpers'
import { logger } from '../logger'
import { listProfileNamesFromDisk } from './hermes-profile'

const SERVER_NAME = 'hermes-studio'
const MANAGED_ENV_KEY = 'HERMES_WEB_UI_MANAGED_MCP'
const LEGACY_COMMANDS = new Set([
  'hermes-lan-peer-mcp',
  'hermes-devices-mcp',
  'hermes-web-ui-mcp',
  'hermes-studio-mcp',
])

export type BundledMcpInjectionStatus = 'injected' | 'updated' | 'unchanged' | 'skipped'

export interface BundledMcpInjectionTargetResult {
  profile: string
  status: BundledMcpInjectionStatus
  reason?: string
}

export interface BundledMcpInjectionResult {
  serverName: string
  command: string
  targets: BundledMcpInjectionTargetResult[]
}

function isDisabled(): boolean {
  const value = String(process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(value)
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function managedCommand(): string {
  return isDesktopRuntime() ? 'hermes-studio-mcp' : 'hermes-web-ui-mcp'
}

function managedConfig(): Record<string, unknown> {
  const env: Record<string, string> = {
    HERMES_WEB_UI_URL: `http://127.0.0.1:${config.port}`,
    HERMES_WEB_UI_HOME: config.appHome,
    HERMES_WEBUI_STATE_DIR: config.appHome,
    [MANAGED_ENV_KEY]: '1',
  }

  if (process.env.AUTH_TOKEN?.trim()) {
    env.HERMES_WEB_UI_TOKEN = process.env.AUTH_TOKEN.trim()
  }

  return {
    command: managedCommand(),
    env,
    enabled: true,
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isManagedServer(server: unknown): boolean {
  if (!isRecord(server)) return false
  if (isRecord(server.env) && server.env[MANAGED_ENV_KEY] === '1') return true
  return typeof server.command === 'string' && LEGACY_COMMANDS.has(server.command)
}

function sameConfig(existing: Record<string, any>, desired: Record<string, unknown>): boolean {
  const desiredEnv = desired.env as Record<string, string>
  return existing.command === desired.command &&
    existing.enabled !== false &&
    isRecord(existing.env) &&
    existing.env.HERMES_WEB_UI_URL === desiredEnv.HERMES_WEB_UI_URL &&
    existing.env.HERMES_WEB_UI_HOME === desiredEnv.HERMES_WEB_UI_HOME &&
    existing.env.HERMES_WEBUI_STATE_DIR === desiredEnv.HERMES_WEBUI_STATE_DIR &&
    existing.env.HERMES_WEB_UI_TOKEN === desiredEnv.HERMES_WEB_UI_TOKEN &&
    existing.env[MANAGED_ENV_KEY] === desiredEnv[MANAGED_ENV_KEY]
}

async function injectIntoProfile(profile: string, desired: Record<string, unknown>): Promise<BundledMcpInjectionTargetResult> {
  return await updateConfigYamlForProfile(profile, current => {
    const cfg = isRecord(current) ? current : {}
    if (!isRecord(cfg.mcp_servers)) cfg.mcp_servers = {}

    const existing = cfg.mcp_servers[SERVER_NAME]
    if (!existing) {
      cfg.mcp_servers[SERVER_NAME] = desired
      return { data: cfg, result: { profile, status: 'injected' } satisfies BundledMcpInjectionTargetResult }
    }

    if (!isManagedServer(existing)) {
      return {
        data: cfg,
        write: false,
        result: {
          profile,
          status: 'skipped',
          reason: `existing ${SERVER_NAME} MCP server is not managed by Hermes Web UI`,
        } satisfies BundledMcpInjectionTargetResult,
      }
    }

    if (sameConfig(existing, desired)) {
      return {
        data: cfg,
        write: false,
        result: { profile, status: 'unchanged' } satisfies BundledMcpInjectionTargetResult,
      }
    }

    cfg.mcp_servers[SERVER_NAME] = desired
    return { data: cfg, result: { profile, status: 'updated' } satisfies BundledMcpInjectionTargetResult }
  }) as BundledMcpInjectionTargetResult
}

export async function injectBundledMcpServer(): Promise<BundledMcpInjectionResult> {
  const desired = managedConfig()
  const result: BundledMcpInjectionResult = {
    serverName: SERVER_NAME,
    command: String(desired.command),
    targets: [],
  }

  if (isDisabled()) {
    logger.info('[mcp-autoinject] disabled by HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT')
    return result
  }

  for (const profile of listProfileNamesFromDisk()) {
    result.targets.push(await injectIntoProfile(profile, desired))
  }

  const changed = result.targets.filter(target => target.status === 'injected' || target.status === 'updated')
  if (changed.length > 0) {
    logger.info({
      serverName: SERVER_NAME,
      command: desired.command,
      targets: changed,
    }, '[mcp-autoinject] synced bundled MCP server')
  }

  const skipped = result.targets.filter(target => target.status === 'skipped')
  if (skipped.length > 0) {
    logger.warn({ serverName: SERVER_NAME, targets: skipped }, '[mcp-autoinject] skipped unmanaged MCP server entries')
  }

  return result
}
