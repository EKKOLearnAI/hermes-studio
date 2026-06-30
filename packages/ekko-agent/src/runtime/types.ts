import type { AgentMessage, ModelClient, ModelRequest } from '../model/types'
import type { AgentMessageInput, AgentOutputMessage } from '../model/messages'
import type { AgentSkill } from '../skills/types'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentToolContext, AgentToolResult } from '../tools/types'
import type { AgentRuntimeEvent } from './events'

export interface AgentRuntimeOptions {
  modelClient: ModelClient
  tools?: AgentToolRegistry
  skills?: AgentSkill[]
  systemPrompt?: string
  runtimeInstructions?: string[]
  maxSteps?: number
  toolContext?: AgentToolContext
  modelDefaults?: Omit<ModelRequest, 'messages' | 'tools' | 'stream'>
}

export interface AgentRuntimeRunInput {
  messages: AgentMessageInput[]
  systemPrompt?: string
  skills?: AgentSkill[]
  maxSteps?: number
  toolContext?: AgentToolContext
  model?: string
  temperature?: number
  maxTokens?: number
  metadata?: Record<string, unknown>
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
}
