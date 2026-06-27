import type { ProviderApiMode } from './hermes/system'

export const CODING_AGENT_API_MODES = [
  'chat_completions',
  'codex_responses',
  'anthropic_messages',
] as const satisfies readonly ProviderApiMode[]

export type CodingAgentApiMode = typeof CODING_AGENT_API_MODES[number]

export function isCodingAgentApiMode(value: unknown): value is CodingAgentApiMode {
  return typeof value === 'string' && (CODING_AGENT_API_MODES as readonly string[]).includes(value)
}

export function inferCodingAgentApiMode(provider?: string | null, baseUrl?: string | null): CodingAgentApiMode {
  const providerKey = String(provider || '').toLowerCase()
  const normalizedBaseUrl = String(baseUrl || '').toLowerCase()

  if (
    providerKey.includes('claude') ||
    providerKey === 'anthropic' ||
    normalizedBaseUrl.includes('anthropic') ||
    normalizedBaseUrl.includes('/anthropic')
  ) {
    return 'anthropic_messages'
  }

  if (
    providerKey === 'deepseek' ||
    providerKey === 'lmstudio' ||
    normalizedBaseUrl.includes('deepseek') ||
    normalizedBaseUrl.includes('127.0.0.1') ||
    normalizedBaseUrl.includes('localhost')
  ) {
    return 'chat_completions'
  }

  return 'chat_completions'
}

export function normalizeCodingAgentApiMode(
  value: unknown,
  fallback: CodingAgentApiMode = 'codex_responses',
): CodingAgentApiMode {
  return isCodingAgentApiMode(value) ? value : fallback
}
