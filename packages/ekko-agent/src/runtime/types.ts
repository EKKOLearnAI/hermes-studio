import type { AgentMessage, ModelClient, ModelRequest, ModelUsage } from '../model/types'
import type { AgentMessageInput, AgentOutputMessage } from '../model/messages'
import type { AgentSkill } from '../skills/types'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentToolContext, AgentToolResult } from '../tools/types'
import type { AgentRuntimeEvent } from './events'
import type { MemoryContext } from '../memory/types'
import type { MemoryService } from '../memory/service'

export interface AgentRuntimeContextEstimate {
  contextTokens: number
  systemPromptTokens: number
  messageTokens: number
  toolTokens: number
  modelContextTokens: number
  messageCount: number
  toolCount: number
  systemPromptChars: number
}

export interface AgentRuntimeOptions {
  modelClient?: ModelClient
  tools?: AgentToolRegistry
  skills?: AgentSkill[]
  systemPrompt?: string
  runtimeInstructions?: string[]
  maxSteps?: number
  maxModelRetries?: number
  maxConsecutiveToolFailures?: number
  toolDelayMs?: number
  toolContext?: AgentToolContext
  modelDefaults?: Omit<ModelRequest, 'messages' | 'tools' | 'stream'>
  contextKey?: string
  memory?: MemoryService
}

export interface AgentRuntimeRunInput {
  messages: AgentMessageInput[]
  signal?: AbortSignal
  systemPrompt?: string
  skills?: AgentSkill[]
  maxSteps?: number
  maxModelRetries?: number
  maxConsecutiveToolFailures?: number
  toolDelayMs?: number
  toolContext?: AgentToolContext
  model?: string
  temperature?: number
  maxTokens?: number
  metadata?: Record<string, unknown>
  modelClient?: ModelClient
  modelDefaults?: Omit<ModelRequest, 'messages' | 'tools' | 'stream'>
  contextKey?: string
  context?: unknown
  memoryEnabled?: boolean
  onMemoryUsage?: (input: {
    purpose: 'ekko-memory-summary'
    usage: ModelUsage
    model?: string
    callIndex: number
  }) => void
  onEvent?: (event: AgentRuntimeEvent) => void
}

export type AgentRuntimeStep =
  | { type: 'model'; step: number; message: AgentOutputMessage }
  | { type: 'tool'; step: number; toolCallId: string; toolName: string; result: AgentToolResult }

export interface AgentRuntimeRunResult {
  runId: string
  messages: AgentMessage[]
  output: AgentOutputMessage
  steps: AgentRuntimeStep[]
  events: AgentRuntimeEvent[]
  context?: unknown
  contextEstimate?: AgentRuntimeContextEstimate
  memoryContext?: MemoryContext
}
