const GLM53_REASONING_EFFORT_MAP: Record<string, string> = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
  ultra: 'max',
}

export function isGlm53Model(model: unknown): boolean {
  const normalized = typeof model === 'string' ? model.trim().toLowerCase() : ''
  return /(^|[/_:.-])glm[-_.]?5[.-]3($|[/_:.-])/.test(normalized)
}

export function normalizeReasoningEffortForModel(model: unknown, effort: unknown): string {
  const normalized = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  if (!normalized || !isGlm53Model(model)) return normalized
  return GLM53_REASONING_EFFORT_MAP[normalized] || 'high'
}
