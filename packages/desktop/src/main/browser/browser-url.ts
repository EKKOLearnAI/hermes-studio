import { isIP } from 'node:net'

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.internal',
  '100.100.100.200',
])
const SENSITIVE_QUERY_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|password|authorization|auth|code|session)$/i

export function redactBrowserText(input: unknown, limit = 500): string {
  return String(input ?? '')
    .replace(/\bAuthorization\s*([:=])\s*Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Authorization$1 Bearer [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret)\s*([:=])\s*([^\s&,;]+)/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bAuthorization\s*([:=])\s*(?!Bearer\s+\[redacted\])(?:Basic\s+)?[^\s&,;]+/gi, 'Authorization$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

export function publicBrowserUrl(input: string): string {
  try {
    const parsed = new URL(input)
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, '[redacted]')
    }
    if (/(?:access[_-]?token|id[_-]?token|token|api[_-]?key|secret|password|authorization|auth|code)=/i.test(parsed.hash)) {
      parsed.hash = '#[redacted]'
    }
    return parsed.toString()
  } catch {
    return redactBrowserText(input, 2048)
  }
}

export function normalizeBrowserUrl(input: string, options: { allowBlank?: boolean } = {}): string {
  const raw = String(input || '').trim()
  if (!raw && options.allowBlank) return 'about:blank'
  if (!raw) throw new Error('URL is required')
  if (raw === 'about:blank' && options.allowBlank) return raw
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  const parsed = new URL(candidate)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are allowed')
  }
  if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not allowed')
  if (isBlockedBrowserHost(parsed.hostname)) throw new Error('This address is blocked by the browser security policy')
  return parsed.toString()
}

export function isBlockedBrowserHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTS.has(host)) return true
  if (host.startsWith('169.254.')) return true
  if (isIP(host) === 6) {
    return host === '::1' ? false : host.startsWith('fe80:')
  }
  return false
}

export function isAllowedBrowserRequest(input: string): boolean {
  try {
    const parsed = new URL(input)
    if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return true
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return !isBlockedBrowserHost(parsed.hostname)
  } catch {
    return false
  }
}

export function isAllowedBrowserSubresource(input: string): boolean {
  try {
    const parsed = new URL(input)
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return !isBlockedBrowserHost(parsed.hostname)
    return isAllowedBrowserRequest(input)
  } catch {
    return false
  }
}
