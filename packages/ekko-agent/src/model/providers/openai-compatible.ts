import { ModelProviderError } from '../errors'
import {
  abortSignal,
  isPlainRecord,
  parseJson,
  parseResponseJson,
  parseServerSentEventLine,
  providerHttpError,
  providerUrl,
  requestHeaders,
} from '../http'
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

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

type OpenAIMessageContent = string | Array<{ type?: string; text?: string }> | null | undefined

interface OpenAIChatPayload {
  model: string
  messages: OpenAIChatMessage[]
  temperature?: number
  max_tokens?: number
  tools?: OpenAIToolDefinition[]
  tool_choice?: 'auto' | 'none' | 'required'
  stream?: boolean
  stream_options?: {
    include_usage: boolean
  }
  metadata?: Record<string, unknown>
}

interface OpenAIChatResponse {
  id?: string
  model?: string
  choices?: Array<{
    message?: {
      content?: OpenAIMessageContent
      tool_calls?: OpenAIToolCall[]
    }
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

const defaultCapabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: false,
  jsonMode: false,
  systemPrompt: true,
}

export class OpenAICompatibleModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'openai-chat'
  readonly capabilities: ModelCapabilities

  private readonly config: ModelProviderConfig
  private readonly fetchImpl: FetchLike

  constructor(config: ModelProviderConfig, options: ModelClientOptions = {}) {
    this.config = config
    this.provider = config.id
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.capabilities = {
      ...defaultCapabilities,
      ...config.capabilities,
    }
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const payload = toOpenAIChatPayload(this.config, { ...request, stream: false })
    const response = await this.postJson(payload)
    return normalizeOpenAIChatResponse(this.provider, response)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const payload = toOpenAIChatPayload(this.config, { ...request, stream: true })
    const response = await this.post(payload)

    if (!response.body) {
      throw new ModelProviderError('Model provider returned an empty stream body.', {
        provider: this.provider,
        statusCode: response.status,
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const toolCalls = new Map<number, { id: string; name: string; argumentsText: string }>()
    let buffer = ''
    let finishReason: string | undefined
    let responseId: string | undefined
    let responseModel: string | undefined

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const event = parseServerSentEventLine(line)
          if (!event) continue
          if (event === '[DONE]') {
            yield { type: 'done', response: { id: responseId, model: responseModel, finishReason } }
            return
          }

          const chunk = parseJson<OpenAIChatResponse>(event)
          if (!chunk) continue
          responseId = chunk.id ?? responseId
          responseModel = chunk.model ?? responseModel

          if (chunk.usage) {
            yield { type: 'usage', usage: normalizeUsage(chunk.usage) }
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue
          finishReason = choice.finish_reason ?? finishReason

          const content = choice.delta?.content
          if (content) {
            yield { type: 'text-delta', text: content }
          }

          for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
            const index = toolCallDelta.index ?? 0
            const current = toolCalls.get(index) ?? { id: '', name: '', argumentsText: '' }
            current.id = toolCallDelta.id ?? current.id
            current.name = toolCallDelta.function?.name ?? current.name
            current.argumentsText += toolCallDelta.function?.arguments ?? ''
            toolCalls.set(index, current)
          }

          if (choice.finish_reason === 'tool_calls') {
            for (const toolCall of toolCalls.values()) {
              yield { type: 'tool-call', toolCall: normalizeToolCall(toolCall.id, toolCall.name, toolCall.argumentsText) }
            }
            toolCalls.clear()
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'done', response: { id: responseId, model: responseModel, finishReason } }
  }

  private async postJson(payload: OpenAIChatPayload): Promise<OpenAIChatResponse> {
    const response = await this.post(payload)
    return parseResponseJson(this.provider, response)
  }

  private async post(payload: OpenAIChatPayload): Promise<Response> {
    const response = await this.fetchImpl(chatCompletionsUrl(this.config), {
      method: 'POST',
      headers: requestHeaders(this.config),
      body: JSON.stringify(payload),
      signal: abortSignal(this.config.timeoutMs),
    })

    if (!response.ok) {
      throw await providerHttpError(this.provider, response)
    }

    return response
  }
}

export function toOpenAIChatPayload(config: ModelProviderConfig, request: ModelRequest): OpenAIChatPayload {
  return {
    model: request.model ?? config.defaultModel,
    messages: request.messages.map(toOpenAIChatMessage),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    tools: request.tools?.map(toOpenAIToolDefinition),
    tool_choice: request.toolChoice,
    stream: request.stream,
    stream_options: request.stream ? { include_usage: true } : undefined,
    metadata: request.metadata,
  }
}

export function normalizeOpenAIChatResponse(provider: string, response: OpenAIChatResponse): ModelResponse {
  if (response.error) {
    throw new ModelProviderError(response.error.message ?? 'Model provider returned an error.', {
      provider,
      details: response.error,
    })
  }

  const choice = response.choices?.[0]
  return {
    id: response.id,
    model: response.model,
    content: normalizeContent(choice?.message?.content),
    toolCalls: choice?.message?.tool_calls?.map(toAgentToolCall),
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: choice?.finish_reason ?? undefined,
    raw: response,
  }
}

function toOpenAIChatMessage(message: AgentMessage): OpenAIChatMessage {
  return {
    role: message.role,
    content: message.role === 'assistant' && message.toolCalls?.length ? message.content || null : message.content,
    name: message.name,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map(toOpenAIToolCall),
  }
}

function toOpenAIToolDefinition(tool: AgentToolDefinition): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function toOpenAIToolCall(toolCall: AgentToolCall): OpenAIToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
    },
  }
}

function toAgentToolCall(toolCall: OpenAIToolCall): AgentToolCall {
  return normalizeToolCall(toolCall.id, toolCall.function.name, toolCall.function.arguments)
}

function normalizeToolCall(id: string, name: string, argumentsText: string): AgentToolCall {
  const parsedArguments = parseJson<unknown>(argumentsText)
  if (isPlainRecord(parsedArguments)) {
    return { id, name, arguments: parsedArguments, rawArguments: argumentsText }
  }
  return { id, name, arguments: {}, rawArguments: argumentsText }
}

function normalizeContent(content: OpenAIMessageContent): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map(part => part.text ?? '').join('')
}

function normalizeUsage(usage: NonNullable<OpenAIChatResponse['usage']>): ModelUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

function chatCompletionsUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.openai.com/v1', 'chat/completions')
}
