import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { readConfigYamlForProfile } from '../../config-helpers'
import { getHermesBaseDir } from '../hermes-profile'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/
const CONFIG_KEYS = new Set([
  'enabled', 'base_url', 'token', 'token_env', 'connect_timeout_ms', 'request_timeout_ms',
  'heartbeat_interval_ms', 'reconnect_initial_ms', 'reconnect_max_ms',
  'max_ws_message_bytes', 'max_rest_response_bytes', 'tls_verify',
])

export type HomeAssistantConfigErrorCode =
  | 'HOME_ASSISTANT_PROFILE_INVALID'
  | 'HOME_ASSISTANT_PROFILE_NOT_FOUND'
  | 'HOME_ASSISTANT_CONFIG_INVALID'
  | 'HOME_ASSISTANT_TOKEN_MISSING'
  | 'HOME_ASSISTANT_URL_UNSAFE'
  | 'HOME_ASSISTANT_TLS_POLICY_UNSAFE'

export class HomeAssistantConfigError extends Error {
  constructor(readonly code: HomeAssistantConfigErrorCode) {
    super(code)
    this.name = 'HomeAssistantConfigError'
  }
}

export interface ResolvedHomeAssistantConfig {
  profile: string
  baseUrl: string
  restStatesUrl: string
  websocketUrl: string
  token: string
  credentialFingerprint: string
  connectTimeoutMs: number
  requestTimeoutMs: number
  heartbeatIntervalMs: number
  reconnectInitialMs: number
  reconnectMaxMs: number
  maxWebSocketMessageBytes: number
  maxRestResponseBytes: number
  tlsVerify: true
}

export interface PublicHomeAssistantConfig {
  profile: string
  configured: true
  baseUrl: string
  tokenConfigured: true
  credentialFingerprint: string
  connectTimeoutMs: number
  requestTimeoutMs: number
  heartbeatIntervalMs: number
  reconnectInitialMs: number
  reconnectMaxMs: number
  maxWebSocketMessageBytes: number
  maxRestResponseBytes: number
  tlsVerify: true
}

export async function resolveHomeAssistantConfig(profile: string): Promise<ResolvedHomeAssistantConfig | null> {
  const name = profileName(profile)
  const directory = exactProfileDirectory(name)
  const configPath = join(directory, 'config.yaml')
  if (!existsSync(configPath)) return null
  let root: Record<string, unknown>
  try {
    root = await readConfigYamlForProfile(name)
  } catch {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  }
  const env = await readBoundedProfileEnv(join(directory, '.env'))
  return resolveHomeAssistantConfigMaterial(name, root, env)
}

export function resolveHomeAssistantConfigMaterial(
  profile: string,
  root: Record<string, unknown>,
  env: Readonly<Record<string, string>>,
): ResolvedHomeAssistantConfig | null {
  const name = profileName(profile)
  if (!plain(root)) throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  const material = root.home_assistant
  if (material === undefined) return null
  if (!plain(material)) throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  if (Reflect.ownKeys(material).some(key => typeof key !== 'string' || !CONFIG_KEYS.has(key))) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  }
  if (material.enabled !== undefined && typeof material.enabled !== 'boolean') {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  }
  if (material.enabled === false) return null

  const baseUrl = safeBaseUrl(material.base_url)
  if (material.tls_verify !== undefined && material.tls_verify !== true) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_TLS_POLICY_UNSAFE')
  }
  const tokenEnv = material.token_env === undefined ? 'HOME_ASSISTANT_TOKEN' : requiredEnvKey(material.token_env)
  const envToken = Object.prototype.hasOwnProperty.call(env, tokenEnv) ? env[tokenEnv] : undefined
  const token = requiredToken(envToken || material.token)
  const connectTimeoutMs = boundedInteger(material.connect_timeout_ms, 10_000, 1_000, 30_000)
  const requestTimeoutMs = boundedInteger(material.request_timeout_ms, 15_000, 1_000, 600_000)
  const heartbeatIntervalMs = boundedInteger(material.heartbeat_interval_ms, 30_000, 5_000, 120_000)
  const reconnectInitialMs = boundedInteger(material.reconnect_initial_ms, 1_000, 250, 30_000)
  const reconnectMaxMs = boundedInteger(material.reconnect_max_ms, 30_000, reconnectInitialMs, 300_000)
  const maxWebSocketMessageBytes = boundedInteger(material.max_ws_message_bytes, 1_048_576, 16_384, 2_097_152)
  const maxRestResponseBytes = boundedInteger(material.max_rest_response_bytes, 8_388_608, 65_536, 33_554_432)
  const websocketProtocol = baseUrl.startsWith('https:') ? 'wss:' : 'ws:'
  const authority = new URL(baseUrl).host
  return {
    profile: name,
    baseUrl,
    restStatesUrl: `${baseUrl}/api/states`,
    websocketUrl: `${websocketProtocol}//${authority}/api/websocket`,
    token,
    credentialFingerprint: createHash('sha256').update(token).digest('hex'),
    connectTimeoutMs,
    requestTimeoutMs,
    heartbeatIntervalMs,
    reconnectInitialMs,
    reconnectMaxMs,
    maxWebSocketMessageBytes,
    maxRestResponseBytes,
    tlsVerify: true,
  }
}

export function publicHomeAssistantConfig(config: ResolvedHomeAssistantConfig): PublicHomeAssistantConfig {
  return {
    profile: config.profile,
    configured: true,
    baseUrl: config.baseUrl,
    tokenConfigured: true,
    credentialFingerprint: config.credentialFingerprint,
    connectTimeoutMs: config.connectTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconnectInitialMs: config.reconnectInitialMs,
    reconnectMaxMs: config.reconnectMaxMs,
    maxWebSocketMessageBytes: config.maxWebSocketMessageBytes,
    maxRestResponseBytes: config.maxRestResponseBytes,
    tlsVerify: true,
  }
}

function profileName(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE.test(value)) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_PROFILE_INVALID')
  }
  return value
}

function exactProfileDirectory(profile: string): string {
  const root = getHermesBaseDir()
  if (profile === 'default') return root
  const directory = join(root, 'profiles', profile)
  if (!existsSync(directory)) throw new HomeAssistantConfigError('HOME_ASSISTANT_PROFILE_NOT_FOUND')
  return directory
}

function safeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_URL_UNSAFE')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new HomeAssistantConfigError('HOME_ASSISTANT_URL_UNSAFE') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== '' && url.pathname !== '/')) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_URL_UNSAFE')
  }
  if (url.protocol === 'http:' && !localHttpHostname(url.hostname)) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_URL_UNSAFE')
  }
  return url.origin
}

function localHttpHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.local') || !hostname.includes('.')) return true
  const family = isIP(hostname)
  if (family === 4) {
    const octets = hostname.split('.').map(Number)
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
  }
  if (family === 6) return hostname === '::1' || /^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname)
  return false
}

function requiredEnvKey(value: unknown): string {
  if (typeof value !== 'string' || !ENV_KEY.test(value)) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  }
  return value
}

function requiredToken(value: unknown): string {
  if (typeof value !== 'string') throw new HomeAssistantConfigError('HOME_ASSISTANT_TOKEN_MISSING')
  const token = value.trim()
  if (token.length < 16 || token.length > 4096 || /\s|[\u0000-\u001f\u007f]/.test(token)) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_TOKEN_MISSING')
  }
  return token
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  }
  return value as number
}

async function readBoundedProfileEnv(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {}
  let size: number
  try { size = (await stat(path)).size } catch { throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID') }
  if (size > 65_536) throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID')
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch { throw new HomeAssistantConfigError('HOME_ASSISTANT_CONFIG_INVALID') }
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (!ENV_KEY.test(key)) continue
    let value = trimmed.slice(separator + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    env[key] = value
  }
  return env
}

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
