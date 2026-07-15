import type {
  AgentMessage,
  AgentToolCall,
  AgentToolDefinition,
  FetchLike,
  ModelCapabilities,
  ModelClient,
  ModelClientOptions,
  ModelEvent,
  ModelProviderConfig,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from '../types'
import { isPlainRecord, parseJson, postJson, postStream, providerUrl, readServerSentEvents } from '../http'
import { collectModelEvents } from '../messages'

interface OpenAIResponsesPayload {
  model: string
  instructions?: string
  input: OpenAIResponseInputItem[]
  temperature?: number
  max_output_tokens?: number
  tools?: Array<{
    type: 'function'
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }>
  tool_choice?: 'auto' | 'none' | 'required'
  stream?: boolean
  metadata?: Record<string, unknown>
  previous_response_id?: string
  store: false
}

type OpenAIResponseInputItem =
  | {
      role: 'user' | 'assistant' | 'developer'
      content: string
    }
  | {
      type: 'function_call'
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

interface OpenAIResponsesResponse {
  id?: string
  model?: string
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
    summary?: Array<{ type?: string; text?: string }>
    name?: string
    call_id?: string
    arguments?: string
  }>
  reasoning?: string
  reasoning_text?: string
  reasoning_summary?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
  status?: string
  error?: {
    message?: string
  }
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: false,
  jsonMode: true,
  systemPrompt: true,
}

export class OpenAIResponsesModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'openai-responses'
  readonly capabilities: ModelCapabilities

  private readonly config: ModelProviderConfig
  private readonly fetchImpl: FetchLike

  constructor(config: ModelProviderConfig, options: ModelClientOptions = {}) {
    this.config = config
    this.provider = config.id
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.capabilities = { ...capabilities, ...config.capabilities }
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    if (this.config.id === 'openai-codex') {
      const output = await collectModelEvents(this.stream({ ...request, stream: true }))
      return output.message
    }
    const response = await postJson<OpenAIResponsesResponse>(
      this.config,
      this.fetchImpl,
      responsesUrl(this.config),
      toOpenAIResponsesPayload(this.config, { ...request, stream: false }),
      undefined,
      request.signal,
    )
    return normalizeOpenAIResponsesResponse(response)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      responsesUrl(this.config),
      toOpenAIResponsesPayload(this.config, { ...request, stream: true }),
      undefined,
      request.signal,
    )

    let streamedText = ''
    let streamedReasoning = ''
    const collectedOutputItems: NonNullable<OpenAIResponsesResponse['output']> = []
    for await (const event of readServerSentEvents(response)) {
      if (event === '[DONE]') {
        yield { type: 'done' }
        return
      }
      const chunk = parseJson<Record<string, unknown>>(event)
      if (!chunk) continue

      if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
        streamedText += chunk.delta
        yield { type: 'text-delta', text: chunk.delta }
      }
      if (
        (chunk.type === 'response.reasoning.delta' ||
          chunk.type === 'response.reasoning_text.delta' ||
          chunk.type === 'response.reasoning_summary_text.delta') &&
        typeof chunk.delta === 'string'
      ) {
        streamedReasoning += chunk.delta
        yield { type: 'reasoning-delta', text: chunk.delta }
      }
      if (chunk.type === 'response.output_item.done' && isPlainRecord(chunk.item)) {
        const item = chunk.item
        collectedOutputItems.push(item as NonNullable<OpenAIResponsesResponse['output']>[number])
        if (item.type === 'function_call' && typeof item.name === 'string') {
          const id = typeof item.call_id === 'string'
            ? item.call_id
            : typeof item.id === 'string'
              ? item.id
              : ''
          const argumentsText = typeof item.arguments === 'string' ? item.arguments : '{}'
          if (id) yield { type: 'tool-call', toolCall: normalizeToolCall(id, item.name, argumentsText) }
        }
      }
      if (chunk.type === 'error') {
        const message = isPlainRecord(chunk.error) && typeof chunk.error.message === 'string'
          ? chunk.error.message
          : typeof chunk.message === 'string'
            ? chunk.message
            : 'Model provider stream failed.'
        yield { type: 'error', error: message }
        return
      }
      if (chunk.type === 'response.completed' && isPlainRecord(chunk.response)) {
        const terminal = chunk.response as OpenAIResponsesResponse
        const output = collectedOutputItems.length > 0
          ? collectedOutputItems
          : terminal.output?.length
            ? terminal.output
            : streamedText
              ? [{
                  type: 'message',
                  content: [{ type: 'output_text', text: streamedText }],
                }]
              : []
        const normalized = normalizeOpenAIResponsesResponse({ ...terminal, output })
        if (!normalized.content && streamedText) normalized.content = streamedText
        if (!normalized.reasoning && streamedReasoning) normalized.reasoning = streamedReasoning
        yield { type: 'done', response: normalized }
        return
      }
    }
  }
}

export function toOpenAIResponsesPayload(config: ModelProviderConfig, request: ModelRequest): OpenAIResponsesPayload {
  const systemMessages = request.messages.filter(message => message.role === 'system')
  const supportsMetadata = config.id !== 'xai-oauth' && config.id !== 'openai-codex'
  const supportsPreviousResponse = config.id !== 'xai-oauth' && config.id !== 'openai-codex'
  const supportsSamplingControls = config.id !== 'openai-codex'
  return {
    model: request.model ?? config.defaultModel,
    instructions: systemMessages.map(message => message.content).join('\n\n') || undefined,
    input: request.messages
      .filter(message => message.role !== 'system')
      .flatMap(toOpenAIResponseInput),
    ...(supportsSamplingControls && request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(supportsSamplingControls && request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
    tools: request.tools?.map(toOpenAIResponseTool),
    tool_choice: request.toolChoice,
    stream: request.stream,
    ...(supportsMetadata && request.metadata ? { metadata: request.metadata } : {}),
    previous_response_id: supportsPreviousResponse
      ? openAIResponsesContext(request.context)?.responseId
      : undefined,
    store: false,
  }
}

export function normalizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): ModelResponse {
  const normalizedToolCalls = response.output
    ?.filter(item => item.type === 'function_call' && item.name && item.call_id)
    .map(item => normalizeToolCall(item.call_id ?? '', item.name ?? '', item.arguments ?? '{}'))
  const toolCalls = normalizedToolCalls?.length ? normalizedToolCalls : undefined

  return {
    id: response.id,
    model: response.model,
    content: response.output_text ?? response.output?.flatMap(item => item.content ?? []).map(part => part.text ?? '').join('') ?? '',
    reasoning: normalizeReasoning(response),
    toolCalls,
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: response.status,
    context: response.id ? { responseId: response.id } : undefined,
    raw: response,
  }
}

function openAIResponsesContext(context: unknown): { responseId?: string } | undefined {
  if (!context || typeof context !== 'object') return undefined
  const responseId = (context as { responseId?: unknown }).responseId
  return typeof responseId === 'string' && responseId ? { responseId } : undefined
}

function normalizeReasoning(response: OpenAIResponsesResponse): string | undefined {
  if (typeof response.reasoning === 'string' && response.reasoning) return response.reasoning
  if (typeof response.reasoning_text === 'string' && response.reasoning_text) return response.reasoning_text
  if (typeof response.reasoning_summary === 'string' && response.reasoning_summary) return response.reasoning_summary

  const reasoning = response.output
    ?.filter(item => item.type === 'reasoning')
    .flatMap(item => [...(item.content ?? []), ...(item.summary ?? [])])
    .map(part => part.text ?? '')
    .join('')
  return reasoning || undefined
}

function toOpenAIResponseInput(message: AgentMessage): OpenAIResponseInputItem[] {
  if (message.role === 'tool') {
    if (!message.toolCallId) return []
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    }]
  }
  if (message.role === 'assistant') {
    const items: OpenAIResponseInputItem[] = []
    if (message.content) items.push({ role: 'assistant', content: message.content })
    for (const toolCall of message.toolCalls ?? []) {
      items.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.rawArguments || JSON.stringify(toolCall.arguments),
      })
    }
    return items
  }
  return [{ role: 'user', content: message.content }]
}

function toOpenAIResponseTool(tool: AgentToolDefinition): NonNullable<OpenAIResponsesPayload['tools']>[number] {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

function normalizeToolCall(id: string, name: string, argumentsText: string): AgentToolCall {
  const parsedArguments = parseJson<unknown>(argumentsText)
  return {
    id,
    name,
    arguments: isPlainRecord(parsedArguments) ? parsedArguments : {},
    rawArguments: argumentsText,
  }
}

function normalizeUsage(usage: NonNullable<OpenAIResponsesResponse['usage']>): ModelUsage {
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0
  const inputTokens = usage.input_tokens ?? 0
  return {
    inputTokens: Math.max(0, inputTokens - cacheReadTokens),
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  }
}

function responsesUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.openai.com/v1', config.endpointPath ?? 'responses')
}
