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

interface OpenAIResponsesPayload {
  model: string
  instructions?: string
  input: Array<{
    role: 'user' | 'assistant' | 'developer'
    content: string
  }>
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
}

interface OpenAIResponsesResponse {
  id?: string
  model?: string
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
    name?: string
    call_id?: string
    arguments?: string
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
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
    const response = await postJson<OpenAIResponsesResponse>(
      this.config,
      this.fetchImpl,
      responsesUrl(this.config),
      toOpenAIResponsesPayload(this.config, { ...request, stream: false }),
    )
    return normalizeOpenAIResponsesResponse(response)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      responsesUrl(this.config),
      toOpenAIResponsesPayload(this.config, { ...request, stream: true }),
    )

    for await (const event of readServerSentEvents(response)) {
      if (event === '[DONE]') {
        yield { type: 'done' }
        return
      }
      const chunk = parseJson<Record<string, unknown>>(event)
      if (!chunk) continue

      if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
        yield { type: 'text-delta', text: chunk.delta }
      }
      if (chunk.type === 'response.completed' && isPlainRecord(chunk.response)) {
        yield { type: 'done', response: normalizeOpenAIResponsesResponse(chunk.response as OpenAIResponsesResponse) }
      }
    }
  }
}

export function toOpenAIResponsesPayload(config: ModelProviderConfig, request: ModelRequest): OpenAIResponsesPayload {
  const systemMessages = request.messages.filter(message => message.role === 'system')
  return {
    model: request.model ?? config.defaultModel,
    instructions: systemMessages.map(message => message.content).join('\n\n') || undefined,
    input: request.messages.filter(message => message.role !== 'system').map(toOpenAIResponseInput),
    temperature: request.temperature,
    max_output_tokens: request.maxTokens,
    tools: request.tools?.map(toOpenAIResponseTool),
    tool_choice: request.toolChoice,
    stream: request.stream,
    metadata: request.metadata,
  }
}

export function normalizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): ModelResponse {
  const toolCalls = response.output
    ?.filter(item => item.type === 'function_call' && item.name && item.call_id)
    .map(item => normalizeToolCall(item.call_id ?? '', item.name ?? '', item.arguments ?? '{}'))

  return {
    id: response.id,
    model: response.model,
    content: response.output_text ?? response.output?.flatMap(item => item.content ?? []).map(part => part.text ?? '').join('') ?? '',
    toolCalls,
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: response.status,
    raw: response,
  }
}

function toOpenAIResponseInput(message: AgentMessage): OpenAIResponsesPayload['input'][number] {
  if (message.role === 'assistant') return { role: 'assistant', content: message.content }
  return { role: 'user', content: message.content }
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
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  }
}

function responsesUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.openai.com/v1', config.endpointPath ?? 'responses')
}
