import type { ChatMessage } from '../../../lib/context-compressor'

/**
 * Content block types for Anthropic-compatible message format
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string }
  | { type: 'file'; name: string; path: string; media_type?: string }

export interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
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
  profile: string
  source?: ChatRunSource
  originSocketId?: string
  goalContinuation?: boolean
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
  queue: QueuedRun[]
  responseRun?: ResponseRunState
  source?: ChatRunSource
  bridgePendingAssistantContent?: string
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
}

export interface ResponseRunState {
  runMarker?: string
  responseId?: string
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
}

export type ChatRunSource = 'api_server' | 'cli'

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
