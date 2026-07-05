import type { AgentToolDefinition } from '../model/types'

export interface AgentToolContext {
  cwd?: string
  workspaceRoot?: string
  sessionId?: string
  browserSessionId?: string
  mcpServers?: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface AgentToolResult {
  ok: boolean
  content: string
  data?: unknown
  error?: string
}

export interface AgentTool<TInput extends Record<string, unknown> = Record<string, unknown>> {
  definition: AgentToolDefinition
  execute(input: TInput, context?: AgentToolContext): Promise<AgentToolResult>
}

export interface AgentToolProvider {
  id: string
  listTools(context?: AgentToolContext): Promise<AgentTool[]>
}

export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'AgentToolError'
  }
}
