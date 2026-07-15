import { AgentBridgeClient } from './agent-bridge/client'
import type { McpActionResponse, McpToolCallResponse } from './mcp-types'

export type { McpServerEntry, McpActionResponse } from './mcp-types'

let bridgeClient: AgentBridgeClient | null = null

/** Bounded health-loop discovery metadata. Execution remains behind HTTP auth and Action Fabric approval. */
export const HEALTH_LOOP_MCP_CAPABILITIES = Object.freeze([
  { kind: 'read', method: 'GET', path: '/api/hermes/health-loop/overview' },
  { kind: 'read', method: 'GET', path: '/api/hermes/health-loop/connectors' },
  { kind: 'read', method: 'GET', path: '/api/hermes/health-loop/interventions' },
  { kind: 'read', method: 'GET', path: '/api/hermes/health-loop/settings' },
  { kind: 'action', method: 'POST', path: '/api/hermes/health-loop/connectors/{id}/sync', authorization: 'super_admin', approval: 'action_fabric' },
  { kind: 'action', method: 'POST', path: '/api/hermes/health-loop/artifacts/{id}/analyze', authorization: 'super_admin', approval: 'action_fabric' },
] as const)

export function getBridgeClient(): AgentBridgeClient {
  if (!bridgeClient) {
    bridgeClient = new AgentBridgeClient()
  }
  return bridgeClient
}

/** Server-internal MCP execution boundary. This is intentionally absent from bridgeMcpAction and HTTP controllers. */
export function callProfileMcpTool(input: {
  profile: string
  server: string
  tool: string
  arguments: Record<string, unknown>
  timeoutMs?: number
}): Promise<McpToolCallResponse> {
  return getBridgeClient().mcpToolCall(
    input.server, input.tool, input.arguments, input.profile, input.timeoutMs,
  )
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
      raw = await client.mcpTools(payload.server as string | undefined, profile, payload.raw as boolean | undefined)
      break
    case 'mcp_reload':
      raw = await client.mcpReload(payload.server as string | undefined, profile)
      break
    default:
      throw new Error(`Unknown MCP action: ${action}`)
  }

  return raw
}
