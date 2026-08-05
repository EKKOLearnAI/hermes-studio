import type { AgentToolDefinition } from '../model/types'

export type AgentToolApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export interface AgentToolApprovalRequest {
  approvalId: string
  toolName: string
  key: string
  command: string
  description: string
  choices: AgentToolApprovalChoice[]
  allowPermanent: boolean
  timeoutMs: number
}

export type AgentToolApprovalRequester = (
  request: AgentToolApprovalRequest,
) => Promise<AgentToolApprovalChoice>

export interface AgentToolAuthorizationDecision {
  approved: boolean
  scope: 'safe' | 'once' | 'session' | 'always' | 'denied'
  key?: string
  description?: string
  error?: string
}

export type AgentToolAuthorizer = (
  toolName: string,
  input: Record<string, unknown>,
  context?: AgentToolContext,
) => Promise<AgentToolAuthorizationDecision>

export interface AgentToolContext {
  runId?: string
  cwd?: string
  workspaceRoot?: string
  workspaceId?: string
  userId?: string
  sessionId?: string
  profileId?: string
  sourceMessageIds?: string[]
  browserSessionId?: string
  mcpServers?: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
  requestToolApproval?: AgentToolApprovalRequester
  skillMutationSource?: 'foreground' | 'background-review'
  delegationDepth?: number
  delegateTask?: AgentTaskDelegate
}

export type AgentTaskMode = 'foreground' | 'background'

export interface AgentTaskRequest {
  goal: string
  context?: string
  mode: AgentTaskMode
}

export type AgentTaskDelegate = (request: AgentTaskRequest) => Promise<AgentToolResult>

export interface AgentToolResult {
  ok: boolean
  content: string
  contentParts?: AgentToolContentPart[]
  data?: unknown
  error?: string
}

export type AgentToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

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
