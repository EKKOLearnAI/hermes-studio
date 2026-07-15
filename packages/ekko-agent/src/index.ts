export interface EkkoAgentInfo {
  name: string
  displayName: string
  packageName: string
}

export function createEkkoAgentInfo(): EkkoAgentInfo {
  return {
    name: 'ekko-agent',
    displayName: 'Ekko Agent',
    packageName: 'ekko-agent',
  }
}

export * from './model/errors'
export * from './model/authorized-providers'
export * from './model/messages'
export * from './model/provider-config'
export * from './model/registry'
export * from './model/types'
export * from './database'
export * from './memory/context'
export * from './memory/extraction'
export * from './memory/paths'
export * from './memory/retrieval'
export * from './memory/schema'
export * from './memory/service'
export * from './memory/store'
export * from './memory/tools'
export * from './memory/types'
export * from './runtime/events'
export * from './runtime/runtime'
export * from './runtime/system-prompt'
export * from './runtime/types'
export * from './skills/types'
export * from './tools/browser'
export * from './tools/files'
export * from './tools/registry'
export * from './tools/terminal'
export * from './tools/tool-result-sanitizer'
export * from './tools/types'
export {
  AnthropicMessagesModelClient,
  normalizeAnthropicResponse,
  toAnthropicMessagesPayload,
} from './model/providers/anthropic'
export {
  CustomRuntimeModelClient,
} from './model/providers/custom-runtime'
export {
  GeminiContentsModelClient,
  normalizeGeminiResponse,
  toGeminiContentsPayload,
} from './model/providers/gemini'
export {
  OpenAICompatibleModelClient,
  normalizeOpenAIChatResponse,
  toOpenAIChatPayload,
} from './model/providers/openai-compatible'
export {
  OpenAIResponsesModelClient,
  normalizeOpenAIResponsesResponse,
  toOpenAIResponsesPayload,
} from './model/providers/openai-responses'
export {
  PromptCompletionModelClient,
  normalizePromptCompletionResponse,
  toPromptCompletionPayload,
} from './model/providers/prompt-completion'
