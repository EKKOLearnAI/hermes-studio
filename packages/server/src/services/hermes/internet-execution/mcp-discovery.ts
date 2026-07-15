import { readFileSync } from 'fs'
import { join } from 'path'
import YAML from 'js-yaml'
import { getBridgeClient } from '../mcp'
import { getProfileDir, listProfileNamesFromDisk } from '../hermes-profile'
import type { McpActionResponse, McpToolsListResponse } from '../mcp-types'
import {
  BILIBILI_INSPECT_CAPABILITY,
  BILIBILI_PROVIDER,
  BILIBILI_SEARCH_CAPABILITY,
  isBilibiliReadOnlyToolName,
} from './fabric-contracts'

const MAX_CONFIG_BYTES = 128 * 1024
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/
const BINDING_KEYS = new Set(['mcp_server', 'search_tool', 'inspect_tool'])

export const DEFAULT_BILIBILI_MCP_SERVER = 'bilibili'
export const DEFAULT_BILIBILI_SEARCH_TOOL = 'search_videos'
export const DEFAULT_BILIBILI_INSPECT_TOOL = 'get_video_info'

export type BilibiliCapabilityId =
  | typeof BILIBILI_SEARCH_CAPABILITY
  | typeof BILIBILI_INSPECT_CAPABILITY

export interface BilibiliMcpBinding {
  profile: string
  provider: typeof BILIBILI_PROVIDER
  server: string
  tools: Record<BilibiliCapabilityId, string>
}

export type BilibiliMcpHealthStatus = 'healthy' | 'degraded' | 'unavailable'

export interface BilibiliMcpCapabilityHealth {
  capabilityId: BilibiliCapabilityId
  tool: string
  available: boolean
  errorCode: 'MCP_TOOL_MISSING' | null
}

export interface BilibiliMcpDiscovery {
  profile: string
  provider: typeof BILIBILI_PROVIDER
  server: string
  status: BilibiliMcpHealthStatus
  errorCode:
    | 'MCP_DISCOVERY_UNAVAILABLE'
    | 'MCP_DISCOVERY_INVALID'
    | 'MCP_SERVER_MISSING'
    | 'MCP_SERVER_AMBIGUOUS'
    | 'MCP_TOOLS_INCOMPLETE'
    | null
  capabilities: Record<BilibiliCapabilityId, BilibiliMcpCapabilityHealth>
}

export class BilibiliMcpConfigurationError extends Error {
  constructor(readonly code: 'MCP_PROFILE_INVALID' | 'MCP_CONFIG_INVALID' | 'MCP_BINDING_UNSAFE') {
    super(code)
    this.name = 'BilibiliMcpConfigurationError'
  }
}

type DiscoverTools = (server: string, profile: string) => Promise<McpActionResponse>

export function resolveBilibiliMcpBinding(profile: string): BilibiliMcpBinding {
  assertKnownProfile(profile)
  const config = readBoundedConfig(join(getProfileDir(profile), 'config.yaml'))
  const internet = own(config, 'internet_execution')
  if (internet !== undefined && !plainObject(internet)) invalidConfig()
  const bilibili = plainObject(internet) ? own(internet, 'bilibili') : undefined
  if (bilibili !== undefined && !plainObject(bilibili)) invalidConfig()
  if (plainObject(bilibili) && Object.keys(bilibili).some(key => !BINDING_KEYS.has(key))) invalidConfig()

  const server = configuredName(bilibili, 'mcp_server', DEFAULT_BILIBILI_MCP_SERVER, SERVER_NAME)
  const searchTool = configuredName(bilibili, 'search_tool', DEFAULT_BILIBILI_SEARCH_TOOL, TOOL_NAME)
  const inspectTool = configuredName(bilibili, 'inspect_tool', DEFAULT_BILIBILI_INSPECT_TOOL, TOOL_NAME)
  if (!isBilibiliReadOnlyToolName(BILIBILI_SEARCH_CAPABILITY, searchTool)
    || !isBilibiliReadOnlyToolName(BILIBILI_INSPECT_CAPABILITY, inspectTool)) {
    throw new BilibiliMcpConfigurationError('MCP_BINDING_UNSAFE')
  }
  return {
    profile,
    provider: BILIBILI_PROVIDER,
    server,
    tools: {
      [BILIBILI_SEARCH_CAPABILITY]: searchTool,
      [BILIBILI_INSPECT_CAPABILITY]: inspectTool,
    },
  }
}

export async function discoverBilibiliMcpBinding(
  profile: string,
  discover: DiscoverTools = (server, requestedProfile) => getBridgeClient().mcpTools(
    server, requestedProfile, false, { timeoutMs: 5_000, connectRetryMs: 0 },
  ),
): Promise<BilibiliMcpDiscovery> {
  const binding = resolveBilibiliMcpBinding(profile)
  let raw: McpActionResponse
  try {
    raw = await discover(binding.server, binding.profile)
  } catch {
    return unavailable(binding, 'MCP_DISCOVERY_UNAVAILABLE')
  }
  if (!raw || raw.ok !== true) return unavailable(binding, 'MCP_DISCOVERY_UNAVAILABLE')

  const results = (raw as McpToolsListResponse).results
  if (!Array.isArray(results) || results.length > 64) return unavailable(binding, 'MCP_DISCOVERY_INVALID')
  const matches = results.filter(result => plainObject(result) && own(result, 'server') === binding.server)
  if (matches.length === 0) return unavailable(binding, 'MCP_SERVER_MISSING')
  if (matches.length !== 1) return unavailable(binding, 'MCP_SERVER_AMBIGUOUS')

  const tools = own(matches[0], 'tools')
  if (!Array.isArray(tools) || tools.length > 256) return unavailable(binding, 'MCP_DISCOVERY_INVALID')
  const names = new Set<string>()
  for (const tool of tools) {
    const name = plainObject(tool) ? own(tool, 'name') : undefined
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || names.has(name)) {
      return unavailable(binding, 'MCP_DISCOVERY_INVALID')
    }
    names.add(name)
  }

  const capabilities = capabilityHealth(binding, names)
  const availableCount = Object.values(capabilities).filter(item => item.available).length
  return {
    profile: binding.profile,
    provider: binding.provider,
    server: binding.server,
    status: availableCount === 2 ? 'healthy' : availableCount === 1 ? 'degraded' : 'unavailable',
    errorCode: availableCount === 2 ? null : 'MCP_TOOLS_INCOMPLETE',
    capabilities,
  }
}

function capabilityHealth(binding: BilibiliMcpBinding, names: Set<string>): BilibiliMcpDiscovery['capabilities'] {
  const health = (capabilityId: BilibiliCapabilityId): BilibiliMcpCapabilityHealth => ({
    capabilityId,
    tool: binding.tools[capabilityId],
    available: names.has(binding.tools[capabilityId]),
    errorCode: names.has(binding.tools[capabilityId]) ? null : 'MCP_TOOL_MISSING',
  })
  return {
    [BILIBILI_SEARCH_CAPABILITY]: health(BILIBILI_SEARCH_CAPABILITY),
    [BILIBILI_INSPECT_CAPABILITY]: health(BILIBILI_INSPECT_CAPABILITY),
  }
}

function unavailable(binding: BilibiliMcpBinding, errorCode: NonNullable<BilibiliMcpDiscovery['errorCode']>): BilibiliMcpDiscovery {
  return {
    profile: binding.profile,
    provider: binding.provider,
    server: binding.server,
    status: 'unavailable',
    errorCode,
    capabilities: capabilityHealth(binding, new Set()),
  }
}

function assertKnownProfile(profile: string): void {
  if (typeof profile !== 'string' || profile.trim() !== profile || !PROFILE_NAME.test(profile)
    || !listProfileNamesFromDisk().includes(profile)) {
    throw new BilibiliMcpConfigurationError('MCP_PROFILE_INVALID')
  }
}

function readBoundedConfig(path: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    invalidConfig()
  }
  if (Buffer.byteLength(raw!, 'utf-8') > MAX_CONFIG_BYTES) invalidConfig()
  let parsed: unknown
  try {
    parsed = YAML.load(raw!, { json: true, schema: YAML.JSON_SCHEMA })
  } catch {
    invalidConfig()
  }
  if (parsed === undefined || parsed === null) return {}
  if (!plainObject(parsed)) invalidConfig()
  return parsed as Record<string, unknown>
}

function configuredName(
  section: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
  pattern: RegExp,
): string {
  if (!section || own(section, key) === undefined) return fallback
  const value = own(section, key)
  if (typeof value !== 'string' || value.trim() !== value || !pattern.test(value)) invalidConfig()
  return value as string
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function own(value: unknown, key: string): unknown {
  if (!plainObject(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function invalidConfig(): never {
  throw new BilibiliMcpConfigurationError('MCP_CONFIG_INVALID')
}
