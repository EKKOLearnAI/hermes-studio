import type {
  AgentMessage,
  AgentMessageContentPart,
  AgentMessageRole,
  AgentReasoning,
  AgentReasoningFormat,
  AgentReasoningNative,
  AgentToolCall,
  ModelEvent,
  ModelResponse,
  ModelUsage,
} from './types'

export type AgentMessageInput =
  | string
  | AgentMessage
  | AgentMessageLike

interface AgentMessageLike {
  role?: AgentMessageRole
  content?: unknown
  reasoning?: unknown
  reasoning_content?: unknown
  reasoning_details?: unknown
  text?: unknown
  name?: string
  toolCallId?: string
  tool_call_id?: string
  toolCalls?: AgentToolCall[]
  tool_calls?: AgentToolCall[]
  contentParts?: AgentMessageContentPart[]
}

export interface AgentOutputMessage extends AgentMessage {
  role: 'assistant'
  id?: string
  model?: string
  usage?: ModelUsage
  finishReason?: string
  context?: unknown
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
    reasoning: normalizeAgentReasoning(
      message.reasoning ?? message.reasoning_content,
      message.reasoning_details,
    ),
    name: message.name,
    toolCallId: message.toolCallId ?? message.tool_call_id,
    toolCalls: message.toolCalls ?? message.tool_calls,
    contentParts: message.contentParts,
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

export function createToolResultMessage(toolCallId: string, content: string, name?: string, contentParts?: AgentMessageContentPart[]): AgentMessage {
  return {
    role: 'tool',
    content,
    toolCallId,
    name,
    contentParts,
  }
}

export function modelResponseToAgentMessage(response: ModelResponse): AgentOutputMessage {
  return {
    role: 'assistant',
    id: response.id,
    model: response.model,
    content: response.content,
    reasoning: normalizeAgentReasoning(response.reasoning, undefined, response.usage?.reasoningTokens),
    toolCalls: response.toolCalls,
    usage: response.usage,
    finishReason: response.finishReason,
    context: response.context,
    raw: response.raw,
  }
}

export async function collectModelEvents(events: AsyncIterable<ModelEvent>): Promise<AgentStreamOutput> {
  const collected: ModelEvent[] = []
  let content = ''
  let reasoningText = ''
  const toolCalls: AgentToolCall[] = []
  let usage: ModelUsage | undefined
  let done: Partial<ModelResponse> | undefined

  for await (const event of events) {
    collected.push(event)
    if (event.type === 'text-delta') {
      content += event.text
    } else if (event.type === 'reasoning-delta') {
      reasoningText += event.text
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
      reasoning: mergeAgentReasoning(
        normalizeAgentReasoning(done?.reasoning, undefined, (done?.usage ?? usage)?.reasoningTokens),
        reasoningText,
      ),
      toolCalls: done?.toolCalls ?? (toolCalls.length ? toolCalls : undefined),
      usage: done?.usage ?? usage,
      finishReason: done?.finishReason,
      ...(done?.context !== undefined ? { context: done.context } : {}),
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

export function normalizeAgentReasoning(
  reasoning: unknown,
  details?: unknown,
  estimatedTokens?: number,
): AgentReasoning | undefined {
  const normalizedObject = isAgentReasoning(reasoning) ? reasoning : undefined
  const text = normalizedObject
    ? normalizeReasoningText(normalizedObject.text)
    : normalizeReasoningText(reasoning)
  const storedDetails = normalizeStoredReasoningDetails(details)
  const native = isAgentReasoningNative(normalizedObject?.native)
    ? normalizedObject.native
    : storedDetails.native
  const tokens = normalizeEstimatedTokens(
    normalizedObject?.estimatedTokens ?? storedDetails.estimatedTokens ?? estimatedTokens,
  )
  if (!text && !native && tokens === undefined) return undefined
  return {
    ...(text ? { text } : {}),
    ...(native ? { native } : {}),
    ...(tokens !== undefined ? { estimatedTokens: tokens } : {}),
  }
}

export function agentReasoningText(reasoning: AgentReasoning | string | null | undefined): string {
  if (typeof reasoning === 'string') return reasoning
  return reasoning?.text ?? ''
}

export function agentReasoningEstimatedTokens(reasoning: AgentReasoning | undefined): number | undefined {
  return normalizeEstimatedTokens(reasoning?.estimatedTokens)
}

export function serializeAgentReasoningDetails(reasoning: AgentReasoning | undefined): string | null {
  if (!reasoning?.native && reasoning?.estimatedTokens === undefined) return null
  return JSON.stringify({
    version: 1,
    ...(reasoning.native ? { native: reasoning.native } : {}),
    ...(reasoning.estimatedTokens !== undefined ? { estimatedTokens: reasoning.estimatedTokens } : {}),
  })
}

function mergeAgentReasoning(reasoning: AgentReasoning | undefined, streamedText: string): AgentReasoning | undefined {
  const text = reasoning?.text ?? (streamedText || undefined)
  if (!text && !reasoning?.native && reasoning?.estimatedTokens === undefined) return undefined
  return {
    ...(reasoning ?? {}),
    ...(text ? { text } : {}),
  }
}

function normalizeReasoningText(reasoning: unknown): string | undefined {
  if (typeof reasoning === 'string') return reasoning || undefined
  if (reasoning === undefined || reasoning === null || isAgentReasoning(reasoning)) return undefined
  return JSON.stringify(reasoning)
}

function normalizeStoredReasoningDetails(details: unknown): {
  native?: AgentReasoningNative
  estimatedTokens?: number
} {
  let parsed = details
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return {}
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return {}
    }
  }
  if (isRecord(parsed) && parsed.version === 1) {
    const estimatedTokens = normalizeEstimatedTokens(parsed.estimatedTokens)
    return {
      ...(isAgentReasoningNative(parsed.native) ? { native: parsed.native } : {}),
      ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    }
  }
  if (isAgentReasoningNative(parsed)) return { native: parsed }
  if (Array.isArray(parsed)) {
    return {
      native: {
        format: inferLegacyReasoningFormat(parsed),
        data: parsed,
      },
    }
  }
  return {}
}

function inferLegacyReasoningFormat(details: unknown[]): AgentReasoningFormat {
  const first = details.find(item => isRecord(item))
  if (isRecord(first) && (first.type === 'thinking' || first.type === 'redacted_thinking')) {
    return 'anthropic-thinking-blocks'
  }
  return 'openai-reasoning-details'
}

function isAgentReasoning(value: unknown): value is AgentReasoning {
  return isRecord(value) && (
    'text' in value ||
    'native' in value ||
    'estimatedTokens' in value
  )
}

function isAgentReasoningNative(value: unknown): value is AgentReasoningNative {
  return isRecord(value) &&
    typeof value.format === 'string' &&
    [
      'openai-reasoning-details',
      'openai-responses-items',
      'anthropic-thinking-blocks',
      'gemini-content-parts',
    ].includes(value.format) &&
    'data' in value
}

function normalizeEstimatedTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
