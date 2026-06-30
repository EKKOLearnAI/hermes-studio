import type { AgentMessage, AgentMessageRole, AgentToolCall, ModelEvent, ModelResponse, ModelUsage } from './types'

export type AgentMessageInput =
  | string
  | AgentMessage
  | AgentMessageLike

interface AgentMessageLike {
  role?: AgentMessageRole
  content?: unknown
  text?: unknown
  name?: string
  toolCallId?: string
  tool_call_id?: string
  toolCalls?: AgentToolCall[]
  tool_calls?: AgentToolCall[]
}

export interface AgentOutputMessage extends AgentMessage {
  role: 'assistant'
  id?: string
  model?: string
  usage?: ModelUsage
  finishReason?: string
  raw?: unknown
}

export interface AgentStreamOutput {
  message: AgentOutputMessage
  events: ModelEvent[]
}

export function normalizeAgentMessage(input: AgentMessageInput, fallbackRole: AgentMessageRole = 'user'): AgentMessage {
  if (typeof input === 'string') {
    return {
      role: fallbackRole,
      content: input,
    }
  }

  const message = input as AgentMessageLike
  const role = normalizeRole(message.role, fallbackRole)
  const content = normalizeContent(message.content ?? message.text)
  return {
    role,
    content,
    name: message.name,
    toolCallId: message.toolCallId ?? message.tool_call_id,
    toolCalls: message.toolCalls ?? message.tool_calls,
  }
}

export function normalizeAgentMessages(inputs: AgentMessageInput[], fallbackRole: AgentMessageRole = 'user'): AgentMessage[] {
  return inputs.map(input => normalizeAgentMessage(input, fallbackRole))
}

export function createSystemMessage(content: string): AgentMessage {
  return { role: 'system', content }
}

export function createUserMessage(content: string): AgentMessage {
  return { role: 'user', content }
}

export function createAssistantMessage(content: string, toolCalls?: AgentToolCall[]): AgentMessage {
  return { role: 'assistant', content, toolCalls }
}

export function createToolResultMessage(toolCallId: string, content: string, name?: string): AgentMessage {
  return {
    role: 'tool',
    content,
    toolCallId,
    name,
  }
}

export function modelResponseToAgentMessage(response: ModelResponse): AgentOutputMessage {
  return {
    role: 'assistant',
    id: response.id,
    model: response.model,
    content: response.content,
    toolCalls: response.toolCalls,
    usage: response.usage,
    finishReason: response.finishReason,
    raw: response.raw,
  }
}

export async function collectModelEvents(events: AsyncIterable<ModelEvent>): Promise<AgentStreamOutput> {
  const collected: ModelEvent[] = []
  let content = ''
  const toolCalls: AgentToolCall[] = []
  let usage: ModelUsage | undefined
  let done: Partial<ModelResponse> | undefined

  for await (const event of events) {
    collected.push(event)
    if (event.type === 'text-delta') {
      content += event.text
    } else if (event.type === 'tool-call') {
      toolCalls.push(event.toolCall)
    } else if (event.type === 'usage') {
      usage = event.usage
    } else if (event.type === 'done') {
      done = event.response
    }
  }

  return {
    events: collected,
    message: {
      role: 'assistant',
      id: done?.id,
      model: done?.model,
      content: done?.content ?? content,
      toolCalls: done?.toolCalls ?? (toolCalls.length ? toolCalls : undefined),
      usage: done?.usage ?? usage,
      finishReason: done?.finishReason,
      raw: done?.raw,
    },
  }
}

function normalizeRole(role: AgentMessageRole | undefined, fallbackRole: AgentMessageRole): AgentMessageRole {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
    return role
  }
  return fallbackRole
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}
