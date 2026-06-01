import { readConfigYaml } from '../config-helpers'
import { getGatewayManagerInstance } from '../gateway-bootstrap'
import { logger } from '../logger'
import { getActiveProfileName } from './hermes-profile'
import { scheduleLlmTask, type LlmTaskPriority } from './llm-scheduler'

interface CustomProviderConfig {
  name?: string
  base_url?: string
  api_key?: string
  model?: string
  api_mode?: string
}

interface ResponsesTextChunk {
  text?: string
}

interface ResponsesOutputItem {
  content?: ResponsesTextChunk[]
}

interface ResponsesBody {
  output_text?: string
  output?: ResponsesOutputItem[]
}

interface ChatCompletionBody {
  choices?: Array<{
    message?: {
      content?: string
    }
    delta?: {
      content?: string
    }
    text?: string
  }>
}

export interface HermesLlmGenerateOptions {
  instructions: string
  input?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  priority?: LlmTaskPriority
  taskKind?: string
}

export interface HermesLlmRuntime {
  baseUrl: string
  apiKey?: string
  model: string
  provider: string
  mode: 'hermes-gateway' | 'custom-provider'
  endpointKind: 'responses' | 'chat-completions'
  timeoutMs: number
  isOllama: boolean
}

export interface HermesLlmGenerateResult {
  text: string
  runtime: HermesLlmRuntime
}

const DEFAULT_GATEWAY_TIMEOUT_MS = 45_000
const DEFAULT_CUSTOM_TIMEOUT_MS = 45_000
const OLLAMA_TIMEOUT_MS = 90_000

function slugProviderName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeUrl(value: unknown): string {
  return trimSlash(String(value || '').trim())
}

function resolveModelConfig(config: Record<string, any>): { model: string; provider: string; baseUrl: string } {
  const modelConfig = config?.model
  if (typeof modelConfig === 'string') {
    return { model: modelConfig.trim(), provider: '', baseUrl: '' }
  }
  if (modelConfig && typeof modelConfig === 'object') {
    return {
      model: String(modelConfig.default || '').trim(),
      provider: String(modelConfig.provider || '').trim(),
      baseUrl: normalizeUrl(modelConfig.base_url),
    }
  }
  return { model: '', provider: '', baseUrl: '' }
}

function listCustomProviders(config: Record<string, any>): CustomProviderConfig[] {
  return Array.isArray(config?.custom_providers) ? config.custom_providers as CustomProviderConfig[] : []
}

function customProviderKey(provider: CustomProviderConfig): string {
  return `custom:${slugProviderName(String(provider.name || ''))}`
}

function matchCustomProvider(
  config: Record<string, any>,
  model: string,
  providerKey: string,
  modelBaseUrl: string,
): CustomProviderConfig | null {
  const normalizedProvider = providerKey.trim()
  const normalizedModelBase = normalizeUrl(modelBaseUrl)

  return listCustomProviders(config).find((provider) => {
    const name = String(provider.name || '').trim()
    const normalizedName = slugProviderName(name)
    const providerBase = normalizeUrl(provider.base_url)
    const providerModel = String(provider.model || '').trim()

    if (normalizedProvider) {
      if (normalizedProvider === customProviderKey(provider)) return true
      if (normalizedProvider === `custom:${name}`) return true
      if (normalizedProvider === name) return true
      if (normalizedProvider === normalizedName) return true
    }

    if (normalizedProvider === 'custom' && normalizedModelBase && providerBase === normalizedModelBase) {
      return !model || !providerModel || providerModel === model
    }

    if (!normalizedProvider && normalizedModelBase && providerBase === normalizedModelBase) {
      return !model || !providerModel || providerModel === model
    }

    return false
  }) || null
}

function looksLikeOllama(runtime: Pick<HermesLlmRuntime, 'baseUrl' | 'provider' | 'model'>): boolean {
  return /11434|ollama/i.test(`${runtime.baseUrl} ${runtime.provider} ${runtime.model}`)
}

function joinOpenAiPath(baseUrl: string, path: '/v1/responses' | '/v1/chat/completions'): string {
  const base = trimSlash(baseUrl)
  if (/\/v\d+$/i.test(base)) {
    return `${base}${path.replace(/^\/v\d+/, '')}`
  }
  return `${base}${path}`
}

function extractResponsesText(body: ResponsesBody): string {
  if (typeof body.output_text === 'string' && body.output_text.trim()) return body.output_text.trim()

  const chunks: string[] = []
  for (const item of body.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') chunks.push(content.text)
    }
  }
  return chunks.join('').trim()
}

function extractChatText(body: ChatCompletionBody): string {
  const chunks: string[] = []
  for (const choice of body.choices || []) {
    if (typeof choice.message?.content === 'string') chunks.push(choice.message.content)
    if (typeof choice.delta?.content === 'string') chunks.push(choice.delta.content)
    if (typeof choice.text === 'string') chunks.push(choice.text)
  }
  return chunks.join('').trim()
}

function getTimeoutMs(baseTimeoutMs: number, runtime: Pick<HermesLlmRuntime, 'baseUrl' | 'provider' | 'model'>): number {
  if (looksLikeOllama(runtime)) return Math.max(baseTimeoutMs, OLLAMA_TIMEOUT_MS)
  return baseTimeoutMs
}

export async function resolveHermesLlmRuntime(options: { timeoutMs?: number } = {}): Promise<HermesLlmRuntime> {
  const config = await readConfigYaml().catch((error) => {
    logger.warn(error, '[dynamic-llm] failed to read Hermes config')
    return {}
  })
  const modelConfig = resolveModelConfig(config)
  const customProvider = matchCustomProvider(config, modelConfig.model, modelConfig.provider, modelConfig.baseUrl)

  if (customProvider?.base_url) {
    const model = modelConfig.model || String(customProvider.model || '').trim()
    const provider = modelConfig.provider || customProviderKey(customProvider)
    const partialRuntime = {
      baseUrl: normalizeUrl(customProvider.base_url),
      provider,
      model,
    }
    return {
      ...partialRuntime,
      apiKey: String(customProvider.api_key || '').trim() || undefined,
      mode: 'custom-provider',
      endpointKind: 'chat-completions',
      timeoutMs: getTimeoutMs(options.timeoutMs ?? DEFAULT_CUSTOM_TIMEOUT_MS, partialRuntime),
      isOllama: looksLikeOllama(partialRuntime),
    }
  }

  const manager = getGatewayManagerInstance()
  if (!manager) throw new Error('GatewayManager not initialized')

  const profile = typeof manager.getActiveProfile === 'function'
    ? manager.getActiveProfile()
    : getActiveProfileName()
  const upstream = normalizeUrl(manager.getUpstream(profile))
  const apiKey = manager.getApiKey(profile) || undefined
  const partialRuntime = {
    baseUrl: upstream,
    provider: modelConfig.provider || 'hermes-gateway',
    model: modelConfig.model,
  }

  return {
    ...partialRuntime,
    apiKey,
    mode: 'hermes-gateway',
    endpointKind: 'responses',
    timeoutMs: getTimeoutMs(options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS, partialRuntime),
    isOllama: looksLikeOllama(partialRuntime),
  }
}

async function callResponsesApi(runtime: HermesLlmRuntime, options: HermesLlmGenerateOptions): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (runtime.apiKey) headers.Authorization = `Bearer ${runtime.apiKey}`

  const response = await fetch(joinOpenAiPath(runtime.baseUrl, '/v1/responses'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(runtime.model ? { model: runtime.model } : {}),
      input: options.input || '請依照 system 指令輸出。',
      instructions: options.instructions,
      temperature: options.temperature ?? 0.2,
      max_output_tokens: options.maxTokens ?? 512,
      store: false,
      stream: false,
    }),
    signal: AbortSignal.timeout(runtime.timeoutMs),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Hermes gateway request failed: ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ''}`)
  }

  const text = extractResponsesText(await response.json() as ResponsesBody)
  if (!text) throw new Error('Hermes gateway returned empty text')
  return text
}

async function callChatCompletionsApi(runtime: HermesLlmRuntime, options: HermesLlmGenerateOptions): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (runtime.apiKey) headers.Authorization = `Bearer ${runtime.apiKey}`

  const response = await fetch(joinOpenAiPath(runtime.baseUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: runtime.model,
      messages: [
        { role: 'system', content: options.instructions },
        { role: 'user', content: options.input || '請依照 system 指令輸出。' },
      ],
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 512,
      stream: false,
    }),
    signal: AbortSignal.timeout(runtime.timeoutMs),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Custom provider request failed: ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ''}`)
  }

  const text = extractChatText(await response.json() as ChatCompletionBody)
  if (!text) throw new Error('Custom provider returned empty text')
  return text
}

export async function generateHermesText(options: HermesLlmGenerateOptions): Promise<HermesLlmGenerateResult> {
  return scheduleLlmTask(async () => {
    const runtime = await resolveHermesLlmRuntime({ timeoutMs: options.timeoutMs })
    logger.info({
      mode: runtime.mode,
      provider: runtime.provider,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      timeoutMs: runtime.timeoutMs,
      isOllama: runtime.isOllama,
    }, '[dynamic-llm] resolved runtime')

    const text = runtime.endpointKind === 'chat-completions'
      ? await callChatCompletionsApi(runtime, options)
      : await callResponsesApi(runtime, options)

    return { text, runtime }
  }, {
    priority: options.priority || 'medium',
    kind: options.taskKind || 'dynamic-llm',
  })
}
