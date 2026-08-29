import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { AgentTool, AgentToolContentPart, AgentToolContext, AgentToolProvider, AgentToolResult } from './types'

interface StdioMcpServerConfig {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  supportsParallelToolCalls: boolean
}

interface StreamableHttpMcpServerConfig {
  type: 'streamable_http'
  url: string
  headers: Record<string, string>
  supportsParallelToolCalls: boolean
}

type McpServerConfig = StdioMcpServerConfig | StreamableHttpMcpServerConfig
type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport

const DEFAULT_MCP_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeServerConfig(value: unknown): McpServerConfig | null {
  if (!isRecord(value) || value.enabled === false) return null
  const supportsParallelToolCalls = value.supports_parallel_tool_calls === true
  const configuredType = typeof value.type === 'string' ? value.type.trim().toLowerCase() : ''
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  const rawUrl = typeof value.url === 'string' ? value.url.trim() : ''
  const isHttp = configuredType === 'streamable_http' || (!configuredType && !command && !!rawUrl)

  if (isHttp) {
    try {
      const url = new URL(rawUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      return {
        type: 'streamable_http',
        url: url.toString(),
        headers: normalizeStringRecord(value.headers),
        supportsParallelToolCalls,
      }
    } catch {
      return null
    }
  }

  if (configuredType && configuredType !== 'stdio') return null
  if (!command) return null
  return {
    type: 'stdio',
    command,
    args: Array.isArray(value.args) ? value.args.map(arg => String(arg)) : [],
    env: normalizeProcessEnv(value.env),
    supportsParallelToolCalls,
  }
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function normalizeProcessEnv(value: unknown): Record<string, string> {
  const normalized = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  for (const [key, item] of Object.entries(normalizeStringRecord(value))) normalized[key] = item
  return normalized
}

function responseContentToText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content
    .map((item: any) => {
      if (item?.type === 'text') return String(item.text ?? '')
      if (item?.type === 'image') return `[Image: ${String(item.mimeType || 'image/png')}]`
      return JSON.stringify(item)
    })
    .filter(Boolean)
    .join('\n')
  return text || JSON.stringify(result ?? {})
}

function responseContentParts(result: any): AgentToolContentPart[] | undefined {
  if (!Array.isArray(result?.content)) return undefined
  const parts: AgentToolContentPart[] = []
  for (const item of result.content) {
    if (item?.type === 'text') parts.push({ type: 'text', text: String(item.text ?? '') })
    if (item?.type === 'image' && typeof item.data === 'string' && /^image\/(?:png|jpeg|webp|gif)$/i.test(String(item.mimeType || ''))) {
      parts.push({ type: 'image', data: item.data, mimeType: String(item.mimeType).toLowerCase() })
    }
  }
  return parts.some(part => part.type === 'image') ? parts : undefined
}

function responseDataWithoutImagePayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(responseDataWithoutImagePayloads)
  if (!isRecord(value)) return value
  if (value.type === 'image' && typeof value.data === 'string') {
    return {
      ...value,
      data: `[image payload forwarded separately: ${String(value.mimeType || 'image/png')}]`,
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, responseDataWithoutImagePayloads(child)]))
}

class McpClientSession {
  private client: Client | null = null
  private transport: McpClientTransport | null = null
  private initialized: Promise<void> | null = null

  constructor(readonly fingerprint: string, private readonly server: McpServerConfig) {}

  async listTools(timeoutMs: number): Promise<any[]> {
    const client = await this.ensureConnected(timeoutMs)
    const result = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: 'refresh' })
    return result.tools
  }

  async callTool(name: string, input: Record<string, unknown>, timeoutMs: number): Promise<AgentToolResult> {
    try {
      const client = await this.ensureConnected(timeoutMs)
      const result = await client.callTool({ name, arguments: input }, { timeout: timeoutMs })
      const content = responseContentToText(result)
      return {
        ok: result.isError !== true,
        content,
        contentParts: responseContentParts(result),
        data: responseDataWithoutImagePayloads(result),
        error: result.isError === true ? content : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, error: message }
    }
  }

  dispose(): void {
    const client = this.client
    const transport = this.transport
    this.client = null
    this.transport = null
    this.initialized = null
    if (!client) return
    void (async () => {
      try {
        if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession()
      } catch {
        // Session termination is optional and some servers return 405.
      } finally {
        await client.close().catch(() => undefined)
      }
    })()
  }

  private async ensureConnected(timeoutMs: number): Promise<Client> {
    if (!this.client) {
      const client = new Client({ name: 'ekko-agent', version: '0.1.0' })
      const transport = this.server.type === 'streamable_http'
        ? new StreamableHTTPClientTransport(new URL(this.server.url), {
            requestInit: Object.keys(this.server.headers).length
              ? { headers: this.server.headers }
              : undefined,
          })
        : new StdioClientTransport({
            command: this.server.command,
            args: this.server.args,
            env: this.server.env,
            stderr: 'ignore',
          })
      this.client = client
      this.transport = transport
      this.initialized = client.connect(transport, { timeout: timeoutMs }).catch(async error => {
        if (this.client === client) {
          this.client = null
          this.transport = null
          this.initialized = null
        }
        await client.close().catch(() => undefined)
        throw error
      })
    }
    await this.initialized
    return this.client!
  }
}

class McpTool implements AgentTool {
  readonly definition: AgentTool['definition']
  readonly concurrency: AgentTool['concurrency']

  constructor(
    serverName: string,
    private readonly remoteName: string,
    tool: any,
    private readonly session: McpClientSession,
    supportsParallelToolCalls: boolean,
  ) {
    this.concurrency = supportsParallelToolCalls ? 'parallel' : 'serial'
    this.definition = {
      name: String(tool.name || remoteName),
      description: String(tool.description || `MCP tool ${remoteName} from ${serverName}`),
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    }
  }

  async execute(input: Record<string, unknown>, context: AgentToolContext = {}): Promise<AgentToolResult> {
    return await this.session.callTool(this.remoteName, input, context.timeoutMs || DEFAULT_MCP_TIMEOUT_MS)
  }
}

export function createMcpToolProvider(): AgentToolProvider {
  const sessions = new Map<string, McpClientSession>()
  return {
    id: 'mcp',
    async listTools(context?: AgentToolContext): Promise<AgentTool[]> {
      const timeoutMs = context?.timeoutMs || DEFAULT_MCP_TIMEOUT_MS
      const tools: AgentTool[] = []
      const usedNames = new Set<string>()
      const configuredServerNames = new Set<string>()

      for (const [serverName, rawConfig] of Object.entries(context?.mcpServers || {})) {
        const server = normalizeServerConfig(rawConfig)
        if (!server) continue
        configuredServerNames.add(serverName)
        const fingerprint = JSON.stringify(server)
        let session = sessions.get(serverName)
        if (!session || session.fingerprint !== fingerprint) {
          session?.dispose()
          session = new McpClientSession(fingerprint, server)
          sessions.set(serverName, session)
        }

        try {
          for (const tool of await session.listTools(timeoutMs)) {
            if (!tool?.name || usedNames.has(String(tool.name))) continue
            usedNames.add(String(tool.name))
            tools.push(new McpTool(
              serverName,
              String(tool.name),
              tool,
              session,
              server.supportsParallelToolCalls,
            ))
          }
        } catch {
          // A broken MCP server should not prevent the rest of the agent run.
        }
      }

      for (const [serverName, session] of sessions) {
        if (configuredServerNames.has(serverName)) continue
        session.dispose()
        sessions.delete(serverName)
      }

      return tools
    },
  }
}
