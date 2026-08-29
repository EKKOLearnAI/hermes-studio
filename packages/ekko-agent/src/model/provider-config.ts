import type { EkkoConfig } from '../config'
import type {
  ModelClient,
  ModelClientOptions,
  ModelProviderConfig,
  ModelProviderType,
  ModelRequest,
  ModelRequestStyle,
} from './types'
import { authorizedModelProviderPreset } from './authorized-providers'
import {
  modelApiModeToRequestStyle,
  requestStyleToModelApiMode,
  type EkkoModelApiMode,
} from './provider-presets'
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from '../config'
import { createModelClient } from './registry'

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

export interface ResolveConfiguredModelProviderInput {
  config: EkkoConfig
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  apiMode?: EkkoModelApiMode
}

export interface CreateConfiguredModelClientInput extends ResolveConfiguredModelProviderInput {
  clientOptions?: ModelClientOptions
}

export function requestStyleFromApiMode(apiMode?: string): ModelRequestStyle | undefined {
  const normalized = String(apiMode || '').toLowerCase()
  if (normalized === 'chat_completions') return 'openai-chat'
  if (normalized === 'codex_responses') return 'openai-responses'
  if (normalized === 'anthropic_messages') return 'anthropic-messages'
  if (normalized === 'gemini_contents') return 'gemini-contents'
  if (normalized === 'prompt_completion') return 'prompt-completion'
  if (normalized === 'custom_runtime') return 'custom-runtime'
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
    apiMode: authorizedPreset?.apiMode || requestStyleToModelApiMode(input.requestStyle),
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
  const timeoutMs = input.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS
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

/** Resolve one persisted provider, with an optional per-call credential override. */
export function resolveConfiguredModelProvider(
  input: ResolveConfiguredModelProviderInput,
): ModelProviderConfig {
  const provider = String(input.provider || input.config.model.defaultProvider || '').trim()
  if (!provider) {
    throw new Error('No model provider was selected and model.defaultProvider is not configured.')
  }
  const settings = input.config.model.providers[provider]
  if (!settings) throw new Error(`Configured model provider not found: ${provider}`)

  const authorization = input.config.model.authorizations[provider]
  const apiKey = input.apiKey ?? authorization?.accessToken ?? settings.apiKey
  const preset = authorizedModelProviderPreset(provider, apiKey)
  const configuredApiMode = input.apiMode || authorization?.apiMode || settings.apiMode
  const apiModeStyle = configuredApiMode ? modelApiModeToRequestStyle(configuredApiMode) : undefined
  const defaultModel = String(
    input.model ||
    (provider === input.config.model.defaultProvider ? input.config.model.defaultModel : '') ||
    settings.defaultModel,
  ).trim()
  if (!defaultModel) throw new Error(`Model provider ${provider} has no default model.`)

  return {
    id: preset?.id || provider,
    type: settings.type,
    apiMode: configuredApiMode
      ? configuredApiMode
      : requestStyleToModelApiMode(settings.requestStyle || preset?.requestStyle || requestStyleForConfig(provider, settings.baseUrl)),
    requestStyle: apiModeStyle || settings.requestStyle || preset?.requestStyle || requestStyleForConfig(provider, settings.baseUrl),
    openAIChatReasoningReplayFormat: settings.openAIChatReasoningReplayFormat,
    apiKey,
    baseUrl: input.baseUrl || authorization?.baseUrl || settings.baseUrl || preset?.baseUrl,
    endpointPath: settings.endpointPath,
    defaultModel,
    headers: {
      ...(preset?.headers || {}),
      ...(settings.headers || {}),
    },
    timeoutMs: settings.timeoutMs ?? input.config.model.requestTimeoutMs,
    capabilities: settings.capabilities,
  }
}

export function createConfiguredModelClient(
  input: CreateConfiguredModelClientInput,
): ModelClient {
  return createModelClient(resolveConfiguredModelProvider(input), input.clientOptions)
}

export function modelRequestDefaultsFromConfig(
  config: EkkoConfig,
  provider?: string,
): Omit<ModelRequest, 'messages' | 'tools' | 'stream'> {
  const selectedProvider = String(provider || config.model.defaultProvider || '').trim()
  const providerModel = selectedProvider
    ? config.model.providers[selectedProvider]?.defaultModel
    : undefined
  return {
    model: config.model.defaultModel || providerModel,
    ...(config.model.temperature === undefined ? {} : { temperature: config.model.temperature }),
    ...(config.model.maxTokens === undefined ? {} : { maxTokens: config.model.maxTokens }),
    reasoningEffort: config.model.reasoningEffort,
    reasoningSummary: config.model.reasoningSummary,
  }
}
