import type {
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
import { parseJson, postJson, postStream, providerUrl, readServerSentEvents } from '../http'

interface PromptCompletionPayload {
  model: string
  prompt: string
  temperature?: number
  max_tokens?: number
  stream?: boolean
}

interface PromptCompletionResponse {
  id?: string
  model?: string
  choices?: Array<{
    text?: string
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: false,
  vision: false,
  jsonMode: false,
  systemPrompt: false,
}

export class PromptCompletionModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'prompt-completion'
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
    const response = await postJson<PromptCompletionResponse>(
      this.config,
      this.fetchImpl,
      completionsUrl(this.config),
      toPromptCompletionPayload(this.config, { ...request, stream: false }),
      undefined,
      request.signal,
    )
    return normalizePromptCompletionResponse(response)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      completionsUrl(this.config),
      toPromptCompletionPayload(this.config, { ...request, stream: true }),
      undefined,
      request.signal,
    )

    for await (const event of readServerSentEvents(response)) {
      if (event === '[DONE]') {
        yield { type: 'done' }
        return
      }
      const chunk = parseJson<PromptCompletionResponse>(event)
      const text = chunk?.choices?.[0]?.text
      if (text) yield { type: 'text-delta', text }
      if (chunk?.usage) yield { type: 'usage', usage: normalizeUsage(chunk.usage) }
    }
  }
}

export function toPromptCompletionPayload(config: ModelProviderConfig, request: ModelRequest): PromptCompletionPayload {
  return {
    model: request.model ?? config.defaultModel,
    prompt: request.messages.map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n'),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stream: request.stream,
  }
}

export function normalizePromptCompletionResponse(response: PromptCompletionResponse): ModelResponse {
  return {
    id: response.id,
    model: response.model,
    content: response.choices?.[0]?.text ?? '',
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: response.choices?.[0]?.finish_reason,
    raw: response,
  }
}

function normalizeUsage(usage: NonNullable<PromptCompletionResponse['usage']>): ModelUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

function completionsUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.openai.com/v1', config.endpointPath ?? 'completions')
}
