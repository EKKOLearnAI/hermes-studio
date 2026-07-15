export const SKILL_DESCRIPTION_PREVIEW_LIMIT = 140

export function normalizeSkillDescription(value: string | null | undefined): string {
  return value == null ? '' : value.replace(/\s+/gu, ' ').trim()
}

export function skillDescriptionPreview(
  value: string | null | undefined,
  maxCharacters = SKILL_DESCRIPTION_PREVIEW_LIMIT,
): string {
  if (!Number.isFinite(maxCharacters)) return ''

  const limit = Math.floor(maxCharacters)
  if (limit <= 0) return ''

  const normalized = normalizeSkillDescription(value)
  if (!normalized) return ''

  const codePoints = Array.from(normalized)
  if (codePoints.length <= limit) return normalized
  if (limit === 1) return '…'

  return `${codePoints.slice(0, limit - 1).join('').trimEnd()}…`
}
