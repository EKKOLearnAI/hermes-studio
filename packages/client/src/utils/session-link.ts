const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/
const SESSION_PROTOCOL_RE = /^session:\/\//i
const MARKDOWN_LINK_RE = /^\[(.*)\]\((.+)\)$/s

function decodeSessionId(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function normalizeSessionId(sessionId: string): string | null {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    return null
  }

  return sessionId
}

export function extractSessionIdFromReference(reference: string): string | null {
  const trimmed = reference.trim()
  if (!trimmed) {
    return null
  }

  let href = trimmed
  const markdownMatch = trimmed.match(MARKDOWN_LINK_RE)
  if (markdownMatch) {
    href = markdownMatch[2].trim()
  }

  if (!SESSION_PROTOCOL_RE.test(href)) {
    return null
  }

  const rawSessionId = href.slice('session://'.length).trim()
  if (!rawSessionId) {
    return null
  }

  const decodedSessionId = decodeSessionId(rawSessionId)
  if (!decodedSessionId) {
    return null
  }

  return normalizeSessionId(decodedSessionId)
}

export function buildSessionHashHref(sessionId: string): string | null {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) {
    return null
  }

  return `#/hermes/session/${encodeURIComponent(normalized)}`
}

export function escapeMarkdownLinkLabel(label: string): string {
  return label
    .replace(/\r?\n+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

export function buildSessionProtocolLink(sessionId: string, label: string): string | null {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) {
    return null
  }

  const safeLabel = escapeMarkdownLinkLabel(label.trim() || normalized)
  return `[${safeLabel}](session://${encodeURIComponent(normalized)})`
}
