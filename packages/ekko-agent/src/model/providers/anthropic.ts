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
import { isPlainRecord, parseJson, postJson, postStream, providerUrl, readServerSentEvents, requestHeaders } from '../http'

interface AnthropicPayload {
  model: string
  system?: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: Array<AnthropicContentBlock>
  }>
  max_tokens: number
  temperature?: number
  tools?: Array<{
    name: string
    description?: string
    input_schema?: Record<string, unknown>
  }>
  tool_choice?: { type: 'auto' | 'none' | 'any' }
  stream?: boolean
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicResponse {
  id?: string
  model?: string
  content?: AnthropicContentBlock[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
  stop_reason?: string
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: false,
  jsonMode: false,
  systemPrompt: true,
}

export class AnthropicMessagesModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'anthropic-messages'
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
    const response = await postJson<AnthropicResponse>(
      this.config,
      this.fetchImpl,
      anthropicUrl(this.config),
      toAnthropicMessagesPayload(this.config, { ...request, stream: false }),
      anthropicHeaders(this.config),
    )
    return normalizeAnthropicResponse(response)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      anthropicUrl(this.config),
      toAnthropicMessagesPayload(this.config, { ...request, stream: true }),
      anthropicHeaders(this.config),
    )

    const toolCallBlocks = new Map<number, { id: string; name: string; argumentsText: string }>()
    let finishReason: string | undefined

    for await (const event of readServerSentEvents(response)) {
      const chunk = parseJson<Record<string, unknown>>(event)
      if (!chunk) continue

      if (chunk.type === 'content_block_start' && isPlainRecord(chunk.content_block)) {
        const index = typeof chunk.index === 'number' ? chunk.index : 0
        const block = chunk.content_block
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolCallBlocks.set(index, { id: block.id, name: block.name, argumentsText: '' })
        }
      }

      if (chunk.type === 'content_block_delta' && isPlainRecord(chunk.delta)) {
        if (chunk.delta.type === 'text_delta' && typeof chunk.delta.text === 'string') {
          yield { type: 'text-delta', text: chunk.delta.text }
        }
        if (chunk.delta.type === 'input_json_delta' && typeof chunk.delta.partial_json === 'string') {
          const index = typeof chunk.index === 'number' ? chunk.index : 0
          const current = toolCallBlocks.get(index)
          if (current) current.argumentsText += chunk.delta.partial_json
        }
      }

      if (chunk.type === 'message_delta' && isPlainRecord(chunk.delta) && typeof chunk.delta.stop_reason === 'string') {
        finishReason = chunk.delta.stop_reason
      }

      if (chunk.type === 'message_stop') {
        for (const toolCall of toolCallBlocks.values()) {
          yield { type: 'tool-call', toolCall: normalizeToolCall(toolCall.id, toolCall.name, toolCall.argumentsText) }
        }
        yield { type: 'done', response: { finishReason } }
        return
      }
    }
  }
}

export function toAnthropicMessagesPayload(config: ModelProviderConfig, request: ModelRequest): AnthropicPayload {
  return {
    model: request.model ?? config.defaultModel,
    system: request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n') || undefined,
    messages: request.messages.filter(message => message.role !== 'system').map(toAnthropicMessage),
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature,
    tools: request.tools?.map(toAnthropicTool),
    tool_choice: request.toolChoice ? { type: request.toolChoice === 'required' ? 'any' : request.toolChoice } : undefined,
    stream: request.stream,
  }
}

export function normalizeAnthropicResponse(response: AnthropicResponse): ModelResponse {
  return {
    id: response.id,
    model: response.model,
    content: response.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '',
    toolCalls: response.content?.filter(block => block.type === 'tool_use').map(block => ({
      id: block.id,
      name: block.name,
      arguments: block.input,
      rawArguments: JSON.stringify(block.input),
    })),
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: response.stop_reason,
    raw: response,
  }
}

function toAnthropicMessage(message: AgentMessage): AnthropicPayload['messages'][number] {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls?.map(toolCall => ({
          type: 'tool_use' as const,
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        })) ?? []),
      ],
    }
  }

  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }],
    }
  }

  return { role: 'user', content: [{ type: 'text', text: message.content }] }
}

function toAnthropicTool(tool: AgentToolDefinition): NonNullable<AnthropicPayload['tools']>[number] {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
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

function normalizeUsage(usage: NonNullable<AnthropicResponse['usage']>): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  }
}

function anthropicUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.anthropic.com/v1', config.endpointPath ?? 'messages')
}

function anthropicHeaders(config: ModelProviderConfig): HeadersInit {
  const headers = requestHeaders(config, { 'anthropic-version': '2023-06-01' }) as Record<string, string>
  delete headers.authorization
  if (config.apiKey) headers['x-api-key'] = config.apiKey
  return headers
}
