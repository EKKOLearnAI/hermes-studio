import type {
  FetchLike,
  ModelCapabilities,
  ModelClient,
  ModelClientOptions,
  ModelEvent,
  ModelProviderConfig,
  ModelRequest,
  ModelResponse,
} from '../types'
import { postJson, postStream, providerUrl, readServerSentEvents, parseJson } from '../http'

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  jsonMode: true,
  systemPrompt: true,
}

export class CustomRuntimeModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'custom-runtime'
  readonly capabilities: ModelCapabilities

  private readonly config: ModelProviderConfig
  private readonly fetchImpl: FetchLike

  constructor(config: ModelProviderConfig, options: ModelClientOptions = {}) {
    this.config = config
    this.provider = config.id
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.capabilities = { ...capabilities, ...config.capabilities }
  }

  requestTarget(): string {
    return customRuntimeUrl(this.config)
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    return postJson<ModelResponse>(
      this.config,
      this.fetchImpl,
      customRuntimeUrl(this.config),
      toCustomRuntimePayload(this.config, request, false),
      undefined,
      request.signal,
    )
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      customRuntimeUrl(this.config),
      toCustomRuntimePayload(this.config, request, true),
      undefined,
      request.signal,
    )

    for await (const event of readServerSentEvents(response)) {
      if (event === '[DONE]') {
        yield { type: 'done' }
        return
      }
      const chunk = parseJson<ModelEvent>(event)
      if (chunk) yield chunk
    }
  }
}

function toCustomRuntimePayload(
  config: ModelProviderConfig,
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  const { metadata: _metadata, tools, toolChoice, ...rest } = request
  return {
    ...rest,
    ...(tools?.length
      ? {
          tools,
          ...(toolChoice ? { toolChoice } : {}),
        }
      : {}),
    model: request.model ?? config.defaultModel,
    stream,
  }
}

function customRuntimeUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'http://127.0.0.1:11434', config.endpointPath ?? 'v1/agent')
}
