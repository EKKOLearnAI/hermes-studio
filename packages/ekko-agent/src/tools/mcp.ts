import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentTool, AgentToolContentPart, AgentToolContext, AgentToolProvider, AgentToolResult } from './types'

interface McpServerConfig {
  command?: unknown
  args?: unknown
  env?: unknown
  enabled?: unknown
}

interface JsonRpcResponse {
  id?: number
  result?: any
  error?: { message?: string }
}

const DEFAULT_MCP_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeServerConfig(value: unknown): McpServerConfig | null {
  if (!isRecord(value)) return null
  if (value.enabled === false) return null
  if (typeof value.command !== 'string' || !value.command.trim()) return null
  return value
}

function normalizeArgs(args: unknown): string[] {
  return Array.isArray(args) ? args.map(arg => String(arg)) : []
}

function normalizeEnv(env: unknown): NodeJS.ProcessEnv {
  if (!isRecord(env)) return process.env
  const normalized: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value != null) normalized[key] = String(value)
  }
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
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private stdout = ''
  private stderr = ''
  private initialized: Promise<void> | null = null
  private readonly pending = new Map<number, { resolve: (response: JsonRpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  constructor(readonly fingerprint: string, private readonly server: McpServerConfig) {}

  async listTools(timeoutMs: number): Promise<any[]> {
    await this.ensureInitialized(timeoutMs)
    const response = await this.request('tools/list', {}, timeoutMs)
    if (response.error) throw new Error(response.error.message || 'MCP tools/list failed')
    return Array.isArray(response.result?.tools) ? response.result.tools : []
  }

  async callTool(name: string, input: Record<string, unknown>, timeoutMs: number): Promise<AgentToolResult> {
    await this.ensureInitialized(timeoutMs)
    const response = await this.request('tools/call', { name, arguments: input }, timeoutMs)
    if (response.error) {
      return { ok: false, content: response.error.message || 'MCP tools/call failed', error: response.error.message || 'MCP tools/call failed' }
    }
    const result = response.result
    const content = responseContentToText(result)
    return {
      ok: result?.isError !== true,
      content,
      contentParts: responseContentParts(result),
      data: responseDataWithoutImagePayloads(result),
      error: result?.isError === true ? content : undefined,
    }
  }

  dispose(): void {
    this.child?.kill()
    this.reset(new Error('MCP client session closed'))
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child
    const command = String(this.server.command)
    const child = spawn(command, normalizeArgs(this.server.args), {
      env: normalizeEnv(this.server.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.stdout = ''
    this.stderr = ''
    child.stdout.on('data', chunk => this.consumeStdout(String(chunk)))
    child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000) })
    child.on('error', error => this.reset(error))
    child.on('exit', code => this.reset(new Error(`MCP server exited: ${command}${code == null ? '' : ` code=${code}`}${this.stderr ? ` stderr=${this.stderr.trim()}` : ''}`)))
    child.unref()
    ;(child.stdin as NodeJS.WritableStream & { unref?: () => void }).unref?.()
    ;(child.stdout as NodeJS.ReadableStream & { unref?: () => void }).unref?.()
    ;(child.stderr as NodeJS.ReadableStream & { unref?: () => void }).unref?.()
    return child
  }

  private async ensureInitialized(timeoutMs: number): Promise<void> {
    this.start()
    if (!this.initialized) {
      this.initialized = this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ekko-agent', version: '0.1.0' },
      }, timeoutMs).then(response => {
        if (response.error) throw new Error(response.error.message || 'MCP initialize failed')
        this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
      }).catch(error => {
        this.initialized = null
        throw error
      })
    }
    await this.initialized
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<JsonRpcResponse> {
    const child = this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP server timed out after ${timeoutMs}ms: ${String(this.server.command)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(error)
      })
    })
  }

  private consumeStdout(chunk: string): void {
    this.stdout += chunk
    let newline = this.stdout.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline).trim()
      this.stdout = this.stdout.slice(newline + 1)
      if (line) {
        try {
          const response = JSON.parse(line) as JsonRpcResponse
          if (typeof response.id === 'number') {
            const entry = this.pending.get(response.id)
            if (entry) {
              clearTimeout(entry.timer)
              this.pending.delete(response.id)
              entry.resolve(response)
            }
          }
        } catch {
          // Ignore non-JSON log lines from MCP servers.
        }
      }
      newline = this.stdout.indexOf('\n')
    }
  }

  private reset(error: Error): void {
    const child = this.child
    this.child = null
    this.initialized = null
    if (child && !child.killed) child.kill()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

class McpTool implements AgentTool {
  readonly definition: AgentTool['definition']

  constructor(
    private readonly serverName: string,
    private readonly remoteName: string,
    tool: any,
    private readonly session: McpClientSession,
  ) {
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
        const fingerprint = JSON.stringify({ command: server.command, args: normalizeArgs(server.args), env: server.env })
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
            tools.push(new McpTool(serverName, String(tool.name), tool, session))
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
