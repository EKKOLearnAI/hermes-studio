import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  getCodingAgentManagedMcpServerConfigs,
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
  type CodingAgentId,
  type CodingAgentConfigScope,
} from './index'
import {
  getDisabledManagedMcpServers,
  setManagedMcpServerEnabled,
} from './mcp-overrides'

const CODING_AGENT_IDS = new Set(['claude-code', 'codex', 'pi', 'grok'])
const STUDIO_MANAGED_NAMES = new Set([
  'hermes-studio-api',
  'hermes-studio-browser',
  'hermes-studio-devices',
  'hermes-studio-use',
])
const MANAGED_ENV_KEY = 'HERMES_WEB_UI_MANAGED_MCP'

export interface CodingAgentMcpServer {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  connected: boolean
  tools: number
  tools_registered: number
  tool_names: string[]
  tool_names_registered: string[]
  tool_details: Array<{ name: string; description?: string }>
  error?: string | null
  raw_config: Record<string, any>
  managed: boolean
}

export interface CodingAgentMcpList {
  ok: true
  servers: CodingAgentMcpServer[]
  total_tools: number
}

function assertAgentId(id: string): void {
  if (!CODING_AGENT_IDS.has(id)) {
    const error = new Error('Unsupported coding agent')
    ;(error as any).status = 404
    throw error
  }
}

function configKey(id: string): string {
  return id === 'codex' ? 'config' : 'mcp'
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isManaged(name: string, config: Record<string, any>): boolean {
  return STUDIO_MANAGED_NAMES.has(name)
    || (isRecord(config.env) && String(config.env[MANAGED_ENV_KEY] || '') === '1')
}

function normalizeTransport(config: Record<string, any>): 'stdio' | 'http' | 'sse' {
  const value = String(config.transport || config.type || '').toLowerCase()
  if (value === 'sse') return 'sse'
  if (value === 'http' || value === 'streamable_http' || value === 'streamablehttp' || config.url) return 'http'
  return 'stdio'
}

function normalizeConfig(value: unknown): Record<string, any> {
  if (!isRecord(value)) return {}
  const config = { ...value }
  if (config.type === 'streamableHttp') config.type = 'http'
  return config
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function parseJsonDocument(content: string): { root: Record<string, any>; servers: Map<string, Record<string, any>> } {
  let root: Record<string, any> = {}
  try {
    const parsed = JSON.parse(content || '{}')
    if (isRecord(parsed)) root = parsed
  } catch {
    const error = new Error('Cannot manage MCP servers while the configuration contains invalid JSON')
    ;(error as any).status = 400
    throw error
  }
  const source = isRecord(root.mcpServers) ? root.mcpServers : {}
  return {
    root,
    servers: new Map(Object.entries(source).map(([name, value]) => [name, normalizeConfig(value)])),
  }
}

function tomlServerHeader(line: string): { name: string; subtable: string } | null {
  const match = line.match(/^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([^\].]+))(?:\.([^\]]+))?\]\s*$/)
  if (!match) return null
  let name = match[1] || match[2] || ''
  if (match[1]) {
    try { name = JSON.parse(`"${match[1]}"`) } catch {}
  }
  return { name, subtable: String(match[3] || '') }
}

function splitTomlDocument(content: string): { other: string; blocks: Map<string, string> } {
  const other: string[] = []
  const blocks = new Map<string, string[]>()
  let currentServer = ''
  for (const line of content.split(/\r?\n/)) {
    const header = tomlServerHeader(line)
    if (header) {
      currentServer = header.name
      const lines = blocks.get(currentServer) || []
      lines.push(line)
      blocks.set(currentServer, lines)
      continue
    }
    if (/^\s*\[/.test(line)) currentServer = ''
    if (currentServer) {
      blocks.get(currentServer)!.push(line)
    } else {
      other.push(line)
    }
  }
  return {
    other: other.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    blocks: new Map([...blocks].map(([name, lines]) => [name, lines.join('\n').trim()])),
  }
}

function splitTomlItems(value: string): string[] {
  const items: string[] = []
  let current = ''
  let quote = ''
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      current += char
      if (char === quote && value[index - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      items.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) items.push(current.trim())
  return items
}

function parseTomlValue(raw: string): any {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  if (value.startsWith('\'') && value.endsWith('\'')) return value.slice(1, -1)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitTomlItems(value.slice(1, -1)).map(parseTomlValue)
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const result: Record<string, any> = {}
    for (const item of splitTomlItems(value.slice(1, -1))) {
      const equals = item.indexOf('=')
      if (equals < 0) continue
      const key = item.slice(0, equals).trim().replace(/^["']|["']$/g, '')
      result[key] = parseTomlValue(item.slice(equals + 1))
    }
    return result
  }
  return value
}

function parseTomlServer(name: string, block: string): Record<string, any> {
  const config: Record<string, any> = {}
  let subtable = ''
  for (const line of block.split(/\r?\n/)) {
    const header = tomlServerHeader(line)
    if (header) {
      subtable = header.name === name ? header.subtable : ''
      continue
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$/)
    if (!match) continue
    const key = match[1]
    const value = parseTomlValue(match[2])
    if (subtable) {
      const targetKey = subtable === 'http_headers' ? 'headers' : subtable
      if (!isRecord(config[targetKey])) config[targetKey] = {}
      config[targetKey][key] = value
    } else {
      config[key] = value
    }
  }
  if (config.http_headers && !config.headers) config.headers = config.http_headers
  delete config.http_headers
  return config
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value)
}

function serializeTomlValue(value: unknown): string | null {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    const items = value.map(serializeTomlValue)
    return items.every(item => item != null) ? `[${items.join(', ')}]` : null
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => {
        const serialized = serializeTomlValue(item)
        return serialized == null ? null : `${tomlKey(key)} = ${serialized}`
      })
      .filter((entry): entry is string => Boolean(entry))
    return `{ ${entries.join(', ')} }`
  }
  return null
}

function serializeTomlServer(name: string, input: Record<string, any>): string {
  const config = normalizeConfig(input)
  const lines = [`[mcp_servers.${tomlKey(name)}]`]
  const nestedKeys = new Set(['env', 'headers', 'http_headers', 'tools'])
  for (const [key, value] of Object.entries(config)) {
    if (nestedKeys.has(key) || value == null) continue
    const serialized = serializeTomlValue(value)
    if (serialized != null) lines.push(`${key} = ${serialized}`)
  }
  if (isRecord(config.env) && Object.keys(config.env).length) {
    const value = serializeTomlValue(config.env)
    if (value) lines.push(`env = ${value}`)
  }
  const headers = isRecord(config.headers) ? config.headers : isRecord(config.http_headers) ? config.http_headers : null
  if (headers && Object.keys(headers).length) {
    lines.push('', `[mcp_servers.${tomlKey(name)}.http_headers]`)
    for (const [key, value] of Object.entries(headers)) {
      const serialized = serializeTomlValue(value)
      if (serialized != null) lines.push(`${tomlKey(key)} = ${serialized}`)
    }
  }
  return lines.join('\n')
}

async function readServers(id: string, scope: CodingAgentConfigScope): Promise<{
  content: string
  servers: Map<string, Record<string, any>>
}> {
  assertAgentId(id)
  const file = await readCodingAgentConfigFile(id, configKey(id), scope)
  let servers: Map<string, Record<string, any>>
  if (id === 'claude-code' || id === 'pi') {
    servers = parseJsonDocument(file.content).servers
  } else {
    const document = splitTomlDocument(file.content)
    servers = new Map([...document.blocks].map(([name, block]) => [name, parseTomlServer(name, block)]))
  }

  const managed = getCodingAgentManagedMcpServerConfigs(id as CodingAgentId, scope.profile)
  const disabledManaged = getDisabledManagedMcpServers(id, scope.profile || 'default')
  for (const [name, config] of Object.entries(managed)) {
    servers.set(name, normalizeConfig({
      ...config,
      ...(disabledManaged.has(name) ? { enabled: false } : {}),
    }))
  }
  return {
    content: file.content,
    servers,
  }
}

async function writeServer(
  id: string,
  originalContent: string,
  name: string,
  config: Record<string, any> | null,
  scope: CodingAgentConfigScope,
): Promise<void> {
  if (id === 'claude-code' || id === 'pi') {
    const { root } = parseJsonDocument(originalContent)
    const persistedServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {}
    for (const managedName of STUDIO_MANAGED_NAMES) delete persistedServers[managedName]
    if (config) persistedServers[name] = config
    else delete persistedServers[name]
    root.mcpServers = persistedServers
    await writeCodingAgentConfigFile(id, configKey(id), `${JSON.stringify(root, null, 2)}\n`, scope)
    return
  }
  const { other, blocks } = splitTomlDocument(originalContent)
  for (const managedName of STUDIO_MANAGED_NAMES) blocks.delete(managedName)
  if (config) blocks.set(name, serializeTomlServer(name, config))
  else blocks.delete(name)
  const mcp = [...blocks.values()].join('\n\n')
  const content = [other, mcp].filter(Boolean).join('\n\n').concat('\n')
  await writeCodingAgentConfigFile(id, configKey(id), content, scope)
}

export async function listCodingAgentMcpServers(
  id: string,
  scope: CodingAgentConfigScope = {},
): Promise<CodingAgentMcpList> {
  const { servers } = await readServers(id, scope)
  const normalized = [...servers].map(([name, config]) => {
    return {
      name,
      transport: normalizeTransport(config),
      connected: false,
      tools: 0,
      tools_registered: 0,
      tool_names: [],
      tool_names_registered: [],
      tool_details: [],
      error: null,
      raw_config: config,
      managed: isManaged(name, config),
    } satisfies CodingAgentMcpServer
  })
  return {
    ok: true,
    servers: normalized.sort((left, right) => left.name.localeCompare(right.name)),
    total_tools: normalized.reduce((total, server) => total + server.tools_registered, 0),
  }
}

export async function upsertCodingAgentMcpServer(
  id: string,
  name: string,
  config: Record<string, any>,
  scope: CodingAgentConfigScope = {},
): Promise<{ ok: true; name: string }> {
  const normalizedName = name.trim()
  if (!normalizedName || normalizedName.length > 128 || /[/\\\x00-\x1f]/.test(normalizedName)) {
    const error = new Error('Valid server name is required')
    ;(error as any).status = 400
    throw error
  }
  if (STUDIO_MANAGED_NAMES.has(normalizedName)) {
    setManagedMcpServerEnabled(
      id,
      scope.profile || 'default',
      normalizedName,
      config.enabled !== false,
    )
    return { ok: true, name: normalizedName }
  }
  if (!isRecord(config) || (!String(config.command || '').trim() && !String(config.url || '').trim())) {
    const error = new Error('MCP server requires command or url')
    ;(error as any).status = 400
    throw error
  }
  const current = await readServers(id, scope)
  await writeServer(id, current.content, normalizedName, normalizeConfig(config), scope)
  return { ok: true, name: normalizedName }
}

export async function removeCodingAgentMcpServer(
  id: string,
  name: string,
  scope: CodingAgentConfigScope = {},
): Promise<{ ok: true }> {
  if (STUDIO_MANAGED_NAMES.has(name)) {
    setManagedMcpServerEnabled(id, scope.profile || 'default', name, false)
    return { ok: true }
  }
  const current = await readServers(id, scope)
  await writeServer(id, current.content, name, null, scope)
  return { ok: true }
}

export async function testCodingAgentMcpServer(
  id: string,
  name: string,
  scope: CodingAgentConfigScope = {},
): Promise<{
  ok: boolean
  tools?: string[]
  tool_details?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
  error?: string
}> {
  assertAgentId(id)
  const current = await readServers(id, scope)
  const config = current.servers.get(name)
  if (!config) return { ok: false, error: `MCP server not found: ${name}` }
  if (config.enabled === false) return { ok: false, error: 'Enable the MCP server before testing it' }

  const transportType = normalizeTransport(config)
  const client = new Client({ name: 'hermes-studio-coding-agent-mcp-test', version: '1.0.0' })
  try {
    const transport = transportType === 'sse'
      ? new SSEClientTransport(new URL(String(config.url || '')), {
          requestInit: { headers: stringRecord(config.headers) },
        })
      : transportType === 'http'
        ? new StreamableHTTPClientTransport(new URL(String(config.url || '')), {
            requestInit: { headers: stringRecord(config.headers) },
          })
        : new StdioClientTransport({
            command: String(config.command || ''),
            args: Array.isArray(config.args) ? config.args.map(String) : [],
            env: {
              ...Object.fromEntries(
                Object.entries(process.env)
                  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
              ),
              ...stringRecord(config.env),
            },
            stderr: 'ignore',
          })
    await client.connect(transport, { timeout: 5_000 })
    const result = await client.listTools(undefined, { timeout: 5_000, cacheMode: 'refresh' })
    const toolDetails = result.tools.map(tool => ({
      name: String(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
      input_schema: isRecord(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    }))
    return {
      ok: true,
      tools: toolDetails.map(tool => tool.name),
      tool_details: toolDetails,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await client.close().catch(() => undefined)
  }
}
