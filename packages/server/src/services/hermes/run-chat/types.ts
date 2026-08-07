import type { ChatMessage } from '../../../lib/context-compressor'

/**
 * Content block types for Anthropic-compatible message format
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string; context?: string }
  | { type: 'file'; name: string; path: string; media_type?: string; context?: string }

export interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  display_role?: string | null
  display_content?: string | null
  runMarker?: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

export interface QueuedRun {
  queue_id: string
  input: string | ContentBlock[]
  displayInput?: string | ContentBlock[] | null
  displayRole?: 'user' | 'command'
  storageMessage?: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  instructions?: string
  groupSystemPrompt?: string
  groupRoomId?: string
  groupAgentId?: string
  workflowId?: string
  workflowNodeId?: string
  profile: string
  workspace?: string | null
  source?: ChatRunSource
  sessionSource?: 'global_agent' | 'workflow' | 'group_chat'
  codingAgentId?: ChatCodingAgentId
  agentId?: ChatCodingAgentId
  mode?: 'scoped' | 'global'
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: string
  api_mode?: string
  mcpServers?: Record<string, unknown>
  mcp_servers?: Record<string, unknown>
  oneShotModel?: boolean
  commandPassthrough?: boolean
  originSocketId?: string
  goalContinuation?: boolean
  reasoningEffort?: string
  backgroundDelegationId?: string
  backgroundClaimId?: string
  autonomous?: boolean
}

export interface BackgroundDelegationState {
  delegationId: string
  status: 'running' | 'delivering' | 'completed' | 'failed' | 'interrupted'
  profile?: string
  updatedAt: number
  toolCallId?: string
  messageId?: number | string
  dispatchPayload?: Record<string, unknown>
}

export interface SessionState {
  messages: SessionMessage[]
  messageTotal?: number
  messageLoadedCount?: number
  messagePageLimit?: number
  hasMoreBefore?: boolean
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  abortController?: AbortController
  runId?: string
  activeRunMarker?: string
  profile?: string
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  bridgeContext?: BridgeContextState
  isAborting?: boolean
  /** [preempt patch] 幂等保护:同一轮 abort 的 markAbortCompleted 只执行一次。
   *  handleAbort 与 bridge terminal chunk 的 markAbortCompleted 会并发触发,
   *  不加保护会把刚启动的下一条 run 的 activeRunMarker/runId 清掉。 */
  abortFinalized?: boolean
  queue: QueuedRun[]
  responseRun?: ResponseRunState
  source?: ChatRunSource
  webhookAgent?: 'bridge' | 'ekko' | 'claude-code' | 'codex'
  webhookRoomId?: string
  webhookWorkflowId?: string
  webhookWorkflowNodeId?: string
  bridgePendingAssistantContent?: string
  bridgeAssistantMessageId?: string
  bridgePendingReasoningContent?: string
  bridgePendingToolCallMarkup?: string
  bridgeOutput?: string
  bridgeToolCounter?: number
  bridgePendingTools?: Array<{
    id: string
    name: string
    arguments: string
    startedAt: number
  }>
  bridgeCompressionResults?: Record<string, BridgeCompressionResult>
  backgroundTasks?: Record<string, Record<string, unknown>>
  backgroundDelegations?: Record<string, BackgroundDelegationState>
}

export interface ResponseRunState {
  runMarker?: string
  responseId?: string
  reasoningMessageId?: number | string
  pendingReasoning?: string
  toolBoundaryReasoning?: string
  toolReasoning?: Map<string, string>
  insertedKeys: Set<string>
  toolCalls: Map<string, any>
}

export interface BridgeContextState {
  fixedContextTokens?: number
  systemPromptTokens?: number
  toolTokens?: number
  systemPromptChars?: number
  toolCount?: number
  toolNames?: string[]
  profile?: string
  model?: string
  provider?: string
  workspace?: string
}

export type ChatRunSource = 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat'
export type ChatCodingAgentId = 'claude-code' | 'codex' | 'ekko-agent'

export interface BridgeCompressionResult {
  messages: ChatMessage[]
  beforeMessages: number
  resultMessages: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean
  llmCompressed: boolean
  summaryTokens: number
  verbatimCount: number
  compressedStartIndex: number
}
