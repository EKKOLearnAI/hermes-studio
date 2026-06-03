const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/
const SESSION_PROTOCOL_RE = /^session:\/\//i
const MARKDOWN_LINK_RE = /^\[(.*)\]\((.+)\)$/s

export interface SessionReference {
  sessionId: string
  profile?: string
}

function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function normalizeSafeToken(value: string): string | null {
  if (!SAFE_SESSION_ID_RE.test(value)) {
    return null
  }

  return value
}

function extractHref(reference: string): string | null {
  const trimmed = reference.trim()
  if (!trimmed) {
    return null
  }

  const markdownMatch = trimmed.match(MARKDOWN_LINK_RE)
  return markdownMatch ? markdownMatch[2].trim() : trimmed
}

export function extractSessionReference(reference: string): SessionReference | null {
  const href = extractHref(reference)
  if (!href || !SESSION_PROTOCOL_RE.test(href)) {
    return null
  }

  const rawTarget = href.slice('session://'.length).trim()
  if (!rawTarget) {
    return null
  }

  const queryStart = rawTarget.indexOf('?')
  const rawSessionId = queryStart >= 0 ? rawTarget.slice(0, queryStart) : rawTarget
  const query = queryStart >= 0 ? rawTarget.slice(queryStart + 1) : ''
  const decodedSessionId = decodeComponent(rawSessionId)
  const sessionId = decodedSessionId ? normalizeSafeToken(decodedSessionId) : null
  if (!sessionId) {
    return null
  }

  const params = new URLSearchParams(query)
  const rawProfile = params.get('profile')?.trim()
  const decodedProfile = rawProfile ? decodeComponent(rawProfile) : null
  const profile = decodedProfile ? normalizeSafeToken(decodedProfile) : null

  return profile ? { sessionId, profile } : { sessionId }
}

export function extractSessionIdFromReference(reference: string): string | null {
  return extractSessionReference(reference)?.sessionId ?? null
}

export function buildSessionHashHref(sessionId: string, profile?: string | null): string | null {
  const normalized = normalizeSafeToken(sessionId)
  if (!normalized) {
    return null
  }

  const normalizedProfile = profile?.trim() ? normalizeSafeToken(profile.trim()) : null
  const profileQuery = normalizedProfile ? `?profile=${encodeURIComponent(normalizedProfile)}` : ''
  return `#/hermes/session/${encodeURIComponent(normalized)}${profileQuery}`
}

export function escapeMarkdownLinkLabel(label: string): string {
  return label
    .replace(/\r?\n+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

export function buildSessionProtocolLink(sessionId: string, label: string, profile?: string | null): string | null {
  const normalized = normalizeSafeToken(sessionId)
  if (!normalized) {
    return null
  }

  const normalizedProfile = profile?.trim() ? normalizeSafeToken(profile.trim()) : null
  const profileQuery = normalizedProfile ? `?profile=${encodeURIComponent(normalizedProfile)}` : ''
  const safeLabel = escapeMarkdownLinkLabel(label.trim() || normalized)
  return `[${safeLabel}](session://${encodeURIComponent(normalized)}${profileQuery})`
}
