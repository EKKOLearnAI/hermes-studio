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
import { isPlainRecord, postJson, postStream, readServerSentEvents, parseJson } from '../http'

interface GeminiPayload {
  contents: Array<{
    role: 'user' | 'model' | 'function'
    parts: GeminiPart[]
  }>
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
  }
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description?: string
      parameters?: Record<string, unknown>
    }>
  }>
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[]
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: false,
  jsonMode: true,
  systemPrompt: true,
}

export class GeminiContentsModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'gemini-contents'
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
    const response = await postJson<GeminiResponse>(
      this.config,
      this.fetchImpl,
      geminiUrl(this.config, request.model, false),
      toGeminiContentsPayload(this.config, request),
    )
    return normalizeGeminiResponse(response, request.model ?? this.config.defaultModel)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      geminiUrl(this.config, request.model, true),
      toGeminiContentsPayload(this.config, request),
    )

    for await (const event of readServerSentEvents(response)) {
      const chunk = parseJson<GeminiResponse>(event)
      if (!chunk) continue
      const normalized = normalizeGeminiResponse(chunk, request.model ?? this.config.defaultModel)
      if (normalized.content) yield { type: 'text-delta', text: normalized.content }
      for (const toolCall of normalized.toolCalls ?? []) yield { type: 'tool-call', toolCall }
      if (normalized.usage) yield { type: 'usage', usage: normalized.usage }
    }
    yield { type: 'done' }
  }
}

export function toGeminiContentsPayload(config: ModelProviderConfig, request: ModelRequest): GeminiPayload {
  return {
    systemInstruction: request.messages.some(message => message.role === 'system')
      ? { parts: request.messages.filter(message => message.role === 'system').map(message => ({ text: message.content })) }
      : undefined,
    contents: request.messages.filter(message => message.role !== 'system').map(toGeminiContent),
    generationConfig: request.temperature !== undefined || request.maxTokens !== undefined
      ? { temperature: request.temperature, maxOutputTokens: request.maxTokens }
      : undefined,
    tools: request.tools?.length ? [{ functionDeclarations: request.tools.map(toGeminiTool) }] : undefined,
  }
}

export function normalizeGeminiResponse(response: GeminiResponse, model?: string): ModelResponse {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  return {
    model,
    content: parts.filter(hasTextPart).map(part => part.text).join(''),
    toolCalls: parts.filter(hasFunctionCallPart).map((part, index) => ({
      id: `gemini_call_${index}`,
      name: part.functionCall.name,
      arguments: part.functionCall.args,
      rawArguments: JSON.stringify(part.functionCall.args),
    })),
    usage: response.usageMetadata ? normalizeUsage(response.usageMetadata) : undefined,
    finishReason: response.candidates?.[0]?.finishReason,
    raw: response,
  }
}

function toGeminiContent(message: AgentMessage): GeminiPayload['contents'][number] {
  if (message.role === 'assistant') {
    return {
      role: 'model',
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls?.map(toolCall => ({ functionCall: { name: toolCall.name, args: toolCall.arguments } })) ?? []),
      ],
    }
  }

  if (message.role === 'tool') {
    return {
      role: 'function',
      parts: [{
        functionResponse: {
          name: message.name ?? message.toolCallId ?? 'tool',
          response: { content: message.content },
        },
      }],
    }
  }

  return { role: 'user', parts: [{ text: message.content }] }
}

function toGeminiTool(tool: AgentToolDefinition): NonNullable<NonNullable<GeminiPayload['tools']>[number]['functionDeclarations']>[number] {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

function normalizeUsage(usage: NonNullable<GeminiResponse['usageMetadata']>): ModelUsage {
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
  }
}

function geminiUrl(config: ModelProviderConfig, model: string | undefined, stream: boolean): string {
  if (config.endpointPath) return `${(config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')}/${config.endpointPath}`
  const baseUrl = (config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  const separator = method.includes('?') ? '&' : '?'
  const key = config.apiKey ? `${separator}key=${encodeURIComponent(config.apiKey)}` : ''
  return `${baseUrl}/models/${encodeURIComponent(model ?? config.defaultModel)}:${method}${key}`
}

function hasTextPart(part: GeminiPart): part is { text: string } {
  return 'text' in part && typeof part.text === 'string'
}

function hasFunctionCallPart(part: GeminiPart): part is { functionCall: { name: string; args: Record<string, unknown> } } {
  return 'functionCall' in part && isPlainRecord(part.functionCall) && typeof part.functionCall.name === 'string' && isPlainRecord(part.functionCall.args)
}
