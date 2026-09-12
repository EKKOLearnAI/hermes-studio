export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'

export interface ModelReasoningPolicy {
  /** Levels documented or declared for the model family. */
  official: readonly ReasoningEffort[]
  /** Levels that some compatible routes may accept but are not part of the model's default contract. */
  extensions: readonly ReasoningEffort[]
}

const KIMI_K2_POLICY = {
  official: ['low', 'medium', 'high'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

const KIMI_K3_POLICY = {
  official: ['low', 'high', 'max'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

const GROK_46_POLICY = {
  official: ['low', 'medium', 'high', 'xhigh'],
  extensions: ['max'],
} as const satisfies ModelReasoningPolicy

const GROK_LEGACY_POLICY = {
  official: ['low', 'medium', 'high'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

const CODEX_GPT56_POLICY = {
  official: ['low', 'medium', 'high', 'xhigh', 'max'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

const CODEX_LEGACY_POLICY = {
  official: ['low', 'medium', 'high', 'xhigh'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

const DEEPSEEK_V4_POLICY = {
  official: ['low', 'medium', 'high', 'max'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

const GLM52_POLICY = {
  official: ['high', 'max'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

const GLM53_POLICY = {
  official: ['low', 'medium', 'high', 'max'],
  extensions: [],
} as const satisfies ModelReasoningPolicy

function modelTail(model: string): string {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .split('/')
    .pop() || ''
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}-`) || value.startsWith(`${prefix}.`)
}

/**
 * Return the static model-family policy when the model is known to Hermes' provider/runtime rules.
 * A null result is intentional: custom and newly released models retain the legacy full selector.
 */
export function getModelReasoningPolicy(provider: string | undefined, model: string | undefined): ModelReasoningPolicy | null {
  const providerId = String(provider || '').trim().toLowerCase()
  const tail = modelTail(String(model || ''))
  if (!tail) return null

  const isKimiProvider = providerId.includes('kimi') || providerId.includes('moonshot')
  if (
    matchesPrefix(tail, 'kimi-k3')
    || (isKimiProvider && matchesPrefix(tail, 'k3'))
  ) return KIMI_K3_POLICY
  if (
    matchesPrefix(tail, 'kimi-k2')
    || tail === 'kimi-for-coding'
    || (isKimiProvider && matchesPrefix(tail, 'k2'))
  ) return KIMI_K2_POLICY

  if (matchesPrefix(tail, 'grok-4.6')) return GROK_46_POLICY
  if (
    matchesPrefix(tail, 'grok-mini')
    || matchesPrefix(tail, 'grok-4.20-multi-agent')
    || matchesPrefix(tail, 'grok-4.3')
    || matchesPrefix(tail, 'grok-4.5')
  ) return GROK_LEGACY_POLICY

  if (matchesPrefix(tail, 'gpt-5.6')) return CODEX_GPT56_POLICY
  if (matchesPrefix(tail, 'gpt-5')) return CODEX_LEGACY_POLICY
  if (matchesPrefix(tail, 'deepseek-v4')) return DEEPSEEK_V4_POLICY
  if (matchesPrefix(tail, 'glm-5.3')) return GLM53_POLICY
  if (matchesPrefix(tail, 'glm-5.2')) return GLM52_POLICY

  return null
}

/**
 * Filter one surface's existing choices without changing its sentinel values.
 * The empty value means "provider default" and `none` means "disable reasoning";
 * both remain available even when a provider's wire vocabulary does not list them.
 */
export function filterReasoningEffortValues(
  values: readonly string[],
  provider: string | undefined,
  model: string | undefined,
): string[] {
  const policy = getModelReasoningPolicy(provider, model)
  if (!policy) return [...values]

  const allowed = new Set<string>([...policy.official, ...policy.extensions])
  return values.filter((value) => {
    const normalized = String(value || '').trim().toLowerCase()
    return normalized === '' || normalized === 'default' || normalized === 'none' || allowed.has(normalized)
  })
}
