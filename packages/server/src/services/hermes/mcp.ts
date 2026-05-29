import { AgentBridgeClient } from './agent-bridge/client'

let bridgeClient: AgentBridgeClient | null = null

export function getBridgeClient(): AgentBridgeClient {
  if (!bridgeClient) {
    bridgeClient = new AgentBridgeClient()
  }
  return bridgeClient
}

/**
 * Wrapper type for bridge MCP responses.
 */
export interface McpServerEntry {
  name: string
  transport: string
  connected: boolean
  tools: number
  tools_registered: number
  tool_names: string[]
  tool_names_registered: string[]
  error?: string | null
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  tools_config?: { include?: string[]; exclude?: string[] }
  prompts?: boolean
  resources?: boolean
  enabled?: boolean
}

export interface McpActionResponse {
  ok: boolean
  error?: string
  name?: string
  servers?: McpServerEntry[]
  total_tools?: number
  tools?: string[]
  message?: string
  results?: Array<{ server: string; tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> }>
}

/**
 * Send an MCP action to the AgentBridge using typed client methods.
 */
export async function bridgeMcpAction(
  action: string,
  payload: Record<string, unknown> = {},
  profile?: string
): Promise<McpActionResponse> {
  const client = getBridgeClient()
  let raw: McpActionResponse

  switch (action) {
    case 'mcp_list':
      raw = await client.mcpList(profile)
      break
    case 'mcp_server_add': {
      const addName = String(payload.name || '')
      const addConfig = payload.config as Record<string, unknown> | undefined
      if (!addName || !addConfig) throw new Error('name and config are required')
      raw = await client.mcpAdd(addName, addConfig, profile)
      break
    }
    case 'mcp_server_update': {
      const updName = String(payload.name || '')
      const updConfig = payload.config as Record<string, unknown> | undefined
      if (!updName || !updConfig) throw new Error('name and config are required')
      raw = await client.mcpUpdate(updName, updConfig, profile)
      break
    }
    case 'mcp_server_remove': {
      const rmName = String(payload.name || '')
      if (!rmName) throw new Error('name is required')
      raw = await client.mcpRemove(rmName, profile)
      break
    }
    case 'mcp_server_test': {
      const testName = String(payload.name || '')
      if (!testName) throw new Error('name is required')
      raw = await client.mcpTest(testName, profile)
      break
    }
    case 'mcp_tools_list':
      raw = await client.mcpTools(payload.server as string | undefined, profile)
      break
    case 'mcp_reload':
      raw = await client.mcpReload(payload.server as string | undefined, profile)
      break
    default:
      throw new Error(`Unknown MCP action: ${action}`)
  }

  return raw
}
