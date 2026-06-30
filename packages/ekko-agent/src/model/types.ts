export type ModelRequestStyle =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-contents'
  | 'prompt-completion'
  | 'custom-runtime'

export type ModelProviderType =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'custom'

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AgentMessage {
  role: AgentMessageRole
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
}

export interface AgentToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments?: string
}

export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface ModelRequest {
  model?: string
  messages: AgentMessage[]
  temperature?: number
  maxTokens?: number
  tools?: AgentToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required'
  stream?: boolean
  metadata?: Record<string, unknown>
}

export interface ModelResponse {
  id?: string
  model?: string
  content: string
  toolCalls?: AgentToolCall[]
  usage?: ModelUsage
  finishReason?: string
  raw?: unknown
}

export type ModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCall: AgentToolCall }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done'; response?: Partial<ModelResponse> }
  | { type: 'error'; error: string }

export interface ModelCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  jsonMode: boolean
  systemPrompt: boolean
  maxInputTokens?: number
}

export interface ModelProviderConfig {
  id: string
  type: ModelProviderType
  requestStyle?: ModelRequestStyle
  apiKey?: string
  baseUrl?: string
  endpointPath?: string
  defaultModel: string
  headers?: Record<string, string>
  timeoutMs?: number
  capabilities?: Partial<ModelCapabilities>
}

export interface ModelClient {
  provider: string
  requestStyle: ModelRequestStyle
  capabilities: ModelCapabilities
  create(request: ModelRequest): Promise<ModelResponse>
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ModelClientOptions {
  fetch?: FetchLike
}
