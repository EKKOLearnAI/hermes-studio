import { isIP } from 'node:net'

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized === 'metadata.google.internal'
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b, c] = parts
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  if (mappedIpv4) {
    return isBlockedIpv4(mappedIpv4)
  }

  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
}

function isBlockedIp(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  const version = isIP(normalized)
  if (version === 4) return isBlockedIpv4(normalized)
  if (version === 6) return isBlockedIpv6(normalized)
  return false
}

export function assertSafeTtsBaseUrl(url: URL, providerLabel: string) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${providerLabel} TTS baseUrl must use http or https`)
  }

  if (url.username || url.password) {
    throw new Error(`${providerLabel} TTS baseUrl must not include credentials`)
  }

  if (isBlockedHostname(url.hostname) || isBlockedIp(url.hostname)) {
    throw new Error(`${providerLabel} TTS baseUrl cannot target localhost or private network addresses`)
  }
}
