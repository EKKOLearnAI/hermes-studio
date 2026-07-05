import { spawn } from 'node:child_process'
import type { AgentTool, AgentToolContext, AgentToolProvider, AgentToolResult } from './types'

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
      return JSON.stringify(item)
    })
    .filter(Boolean)
    .join('\n')
  return text || JSON.stringify(result ?? {})
}

async function runMcpExchange(server: McpServerConfig, messages: Array<Record<string, unknown>>, timeoutMs: number): Promise<JsonRpcResponse[]> {
  const command = String(server.command)
  const child = spawn(command, normalizeArgs(server.args), {
    env: normalizeEnv(server.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  const responses: JsonRpcResponse[] = []
  let settled = false

  return await new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(responses)
    }

    const timer = setTimeout(() => {
      finish(new Error(`MCP server timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)

    child.on('error', finish)
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (line) {
          try {
            responses.push(JSON.parse(line))
          } catch {
            // Ignore non-JSON log lines from MCP servers.
          }
        }
        newline = stdout.indexOf('\n')
      }
      if (responses.length >= messages.length) finish()
    })
    child.on('exit', code => {
      if (responses.length >= messages.length) finish()
      else finish(new Error(`MCP server exited before responding: ${command}${code == null ? '' : ` code=${code}`}${stderr ? ` stderr=${stderr.trim()}` : ''}`))
    })

    for (const message of messages) {
      child.stdin?.write(`${JSON.stringify(message)}\n`)
    }
  })
}

async function listMcpTools(server: McpServerConfig, timeoutMs: number): Promise<any[]> {
  const responses = await runMcpExchange(server, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ekko-agent', version: '0.1.0' },
      },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], timeoutMs)
  const response = responses.find(item => item.id === 2)
  if (response?.error) throw new Error(response.error.message || 'MCP tools/list failed')
  return Array.isArray(response?.result?.tools) ? response.result.tools : []
}

async function callMcpTool(server: McpServerConfig, name: string, input: Record<string, unknown>, timeoutMs: number): Promise<AgentToolResult> {
  const responses = await runMcpExchange(server, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ekko-agent', version: '0.1.0' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: input },
    },
  ], timeoutMs)
  const response = responses.find(item => item.id === 2)
  if (response?.error) {
    return { ok: false, content: response.error.message || 'MCP tools/call failed', error: response.error.message || 'MCP tools/call failed' }
  }
  const result = response?.result
  const content = responseContentToText(result)
  return {
    ok: result?.isError !== true,
    content,
    data: result,
    error: result?.isError === true ? content : undefined,
  }
}

class McpTool implements AgentTool {
  readonly definition: AgentTool['definition']

  constructor(
    private readonly serverName: string,
    private readonly remoteName: string,
    tool: any,
  ) {
    this.definition = {
      name: String(tool.name || remoteName),
      description: String(tool.description || `MCP tool ${remoteName} from ${serverName}`),
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    }
  }

  async execute(input: Record<string, unknown>, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const server = normalizeServerConfig(context.mcpServers?.[this.serverName])
    if (!server) {
      return {
        ok: false,
        content: `MCP server is not configured: ${this.serverName}`,
        error: `MCP server is not configured: ${this.serverName}`,
      }
    }
    return await callMcpTool(server, this.remoteName, input, context.timeoutMs || DEFAULT_MCP_TIMEOUT_MS)
  }
}

export function createMcpToolProvider(): AgentToolProvider {
  return {
    id: 'mcp',
    async listTools(context?: AgentToolContext): Promise<AgentTool[]> {
      if (!context?.mcpServers) return []
      const timeoutMs = context.timeoutMs || DEFAULT_MCP_TIMEOUT_MS
      const tools: AgentTool[] = []
      const usedNames = new Set<string>()

      for (const [serverName, rawConfig] of Object.entries(context.mcpServers)) {
        const server = normalizeServerConfig(rawConfig)
        if (!server) continue

        try {
          for (const tool of await listMcpTools(server, timeoutMs)) {
            if (!tool?.name || usedNames.has(String(tool.name))) continue
            usedNames.add(String(tool.name))
            tools.push(new McpTool(serverName, String(tool.name), tool))
          }
        } catch {
          // A broken MCP server should not prevent the rest of the agent run.
        }
      }

      return tools
    },
  }
}
