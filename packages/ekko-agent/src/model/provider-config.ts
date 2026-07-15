import type { ModelProviderConfig, ModelProviderType, ModelRequestStyle } from './types'
import { authorizedModelProviderPreset } from './authorized-providers'

export interface ResolveModelProviderConfigInput {
  provider: string
  baseUrl?: string
  apiKey?: string
  model: string
  apiMode?: string
  timeoutMs?: number
}

export interface ResolvedModelProviderConfigs {
  providerConfig: ModelProviderConfig
  fallbackProviderConfig?: ModelProviderConfig
  requestStyle: ModelRequestStyle
  inferredRequestStyle: ModelRequestStyle
}

export function requestStyleFromApiMode(apiMode?: string): ModelRequestStyle | undefined {
  const normalized = String(apiMode || '').toLowerCase()
  if (normalized === 'chat_completions') return 'openai-chat'
  if (normalized === 'codex_responses') return 'openai-responses'
  if (normalized === 'anthropic_messages') return 'anthropic-messages'
  return undefined
}

export function inferredRequestStyleForConfig(provider: string, baseUrl = ''): ModelRequestStyle {
  const key = provider.toLowerCase()
  const url = baseUrl.toLowerCase()
  const authorizedPreset = authorizedModelProviderPreset(key)
  if (authorizedPreset) return authorizedPreset.requestStyle
  if (url.endsWith('/anthropic') || url.includes('api.anthropic.com')) return 'anthropic-messages'
  if (key.includes('gemini') || key.includes('google') || url.includes('generativelanguage.googleapis.com')) return 'gemini-contents'
  if (url.includes('api.openai.com') || url.includes('api.x.ai')) return 'openai-responses'
  return 'openai-chat'
}

export function requestStyleForConfig(provider: string, baseUrl = '', apiMode?: string): ModelRequestStyle {
  return requestStyleFromApiMode(apiMode) || inferredRequestStyleForConfig(provider, baseUrl)
}

export function providerTypeForStyle(provider: string, style: ModelRequestStyle): ModelProviderType {
  const key = provider.toLowerCase()
  if (style === 'anthropic-messages') return 'anthropic'
  if (style === 'gemini-contents') return 'gemini'
  if (key.includes('ollama')) return 'ollama'
  if (key === 'openai') return 'openai'
  return 'openai-compatible'
}

export function createProviderConfig(input: {
  provider: string
  requestStyle: ModelRequestStyle
  baseUrl?: string
  apiKey?: string
  model: string
  timeoutMs?: number
}): ModelProviderConfig {
  const authorizedPreset = authorizedModelProviderPreset(input.provider, input.apiKey)
  return {
    id: authorizedPreset?.id || input.provider || 'openai',
    type: providerTypeForStyle(input.provider, input.requestStyle),
    requestStyle: input.requestStyle,
    baseUrl: input.baseUrl || authorizedPreset?.baseUrl,
    apiKey: input.apiKey || undefined,
    defaultModel: input.model,
    headers: authorizedPreset?.headers,
    timeoutMs: input.timeoutMs,
  }
}

export function resolveModelProviderConfigs(input: ResolveModelProviderConfigInput): ResolvedModelProviderConfigs {
  const baseUrl = input.baseUrl || ''
  const timeoutMs = input.timeoutMs ?? 120_000
  const requestStyle = requestStyleForConfig(input.provider, baseUrl, input.apiMode)
  const inferredRequestStyle = inferredRequestStyleForConfig(input.provider, baseUrl)
  const providerConfig = createProviderConfig({
    provider: input.provider,
    requestStyle,
    baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    timeoutMs,
  })
  const fallbackProviderConfig = requestStyleFromApiMode(input.apiMode) && inferredRequestStyle !== requestStyle
    ? createProviderConfig({
        provider: input.provider,
        requestStyle: inferredRequestStyle,
        baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        timeoutMs,
      })
    : undefined

  return {
    providerConfig,
    fallbackProviderConfig,
    requestStyle,
    inferredRequestStyle,
  }
}
