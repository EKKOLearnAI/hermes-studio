import type { ModelClient, ModelClientOptions, ModelProviderConfig, ModelRequestStyle } from './types'
import { AnthropicMessagesModelClient } from './providers/anthropic'
import { CustomRuntimeModelClient } from './providers/custom-runtime'
import { GeminiContentsModelClient } from './providers/gemini'
import { OpenAICompatibleModelClient } from './providers/openai-compatible'
import { OpenAIResponsesModelClient } from './providers/openai-responses'
import { PromptCompletionModelClient } from './providers/prompt-completion'

export function resolveRequestStyle(config: ModelProviderConfig): ModelRequestStyle {
  if (config.requestStyle) return config.requestStyle
  if (config.type === 'anthropic') return 'anthropic-messages'
  if (config.type === 'gemini') return 'gemini-contents'
  if (config.type === 'custom') return 'custom-runtime'
  return 'openai-chat'
}

export function createModelClient(config: ModelProviderConfig, options: ModelClientOptions = {}): ModelClient {
  const requestStyle = resolveRequestStyle(config)

  if (requestStyle === 'openai-chat') {
    return new OpenAICompatibleModelClient({ ...config, requestStyle }, options)
  }
  if (requestStyle === 'openai-responses') {
    return new OpenAIResponsesModelClient({ ...config, requestStyle }, options)
  }
  if (requestStyle === 'anthropic-messages') {
    return new AnthropicMessagesModelClient({ ...config, requestStyle }, options)
  }
  if (requestStyle === 'gemini-contents') {
    return new GeminiContentsModelClient({ ...config, requestStyle }, options)
  }
  if (requestStyle === 'prompt-completion') {
    return new PromptCompletionModelClient({ ...config, requestStyle }, options)
  }
  if (requestStyle === 'custom-runtime') {
    return new CustomRuntimeModelClient({ ...config, requestStyle }, options)
  }

  throw new Error(`Unsupported model request style: ${requestStyle}`)
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProviderConfig>()

  register(config: ModelProviderConfig): void {
    this.providers.set(config.id, config)
  }

  getConfig(providerId: string): ModelProviderConfig | undefined {
    return this.providers.get(providerId)
  }

  create(providerId: string, options: ModelClientOptions = {}): ModelClient {
    const config = this.providers.get(providerId)
    if (!config) {
      throw new Error(`Unknown model provider: ${providerId}`)
    }
    return createModelClient(config, options)
  }

  list(): ModelProviderConfig[] {
    return [...this.providers.values()]
  }
}
