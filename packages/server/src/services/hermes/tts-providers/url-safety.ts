import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

type DnsLookup = typeof dnsLookup
let resolveHostname: DnsLookup = dnsLookup

export function setTtsDnsLookupForTests(lookup: DnsLookup) {
  resolveHostname = lookup
}

export function resetTtsDnsLookupForTests() {
  resolveHostname = dnsLookup
}

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

  const firstHextet = normalized.split(':', 1)[0]
  const firstHextetValue = firstHextet ? Number.parseInt(firstHextet, 16) : Number.NaN
  const isLinkLocal = Number.isInteger(firstHextetValue) && (firstHextetValue & 0xffc0) === 0xfe80

  return normalized === '::'
    || normalized === '::1'
    || isLinkLocal
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

export async function assertSafeResolvedTtsBaseUrl(url: URL, providerLabel: string) {
  assertSafeTtsBaseUrl(url, providerLabel)

  if (isIP(normalizeHostname(url.hostname))) {
    return
  }

  const records = await resolveHostname(url.hostname, { all: true, verbatim: true })
  if (!records.length) {
    throw new Error(`${providerLabel} TTS baseUrl hostname did not resolve`)
  }

  if (records.some(record => isBlockedIp(record.address))) {
    throw new Error(`${providerLabel} TTS baseUrl resolved to localhost or private network addresses`)
  }
}

export function normalizeSafeTtsBaseUrl(baseUrl: string, providerLabel: string): string {
  const value = String(baseUrl || '').trim()
  if (!value) {
    return ''
  }

  const url = new URL(value)
  assertSafeTtsBaseUrl(url, providerLabel)
  return url.toString()
}
