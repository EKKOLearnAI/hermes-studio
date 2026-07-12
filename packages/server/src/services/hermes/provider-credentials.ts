import { join } from 'path'

import { PROVIDER_ENV_MAP, readConfigYamlForProfile, safeReadFile } from '../config-helpers'
import { PROVIDER_PRESETS } from '../../shared/providers'
import {
  getCompatibleCustomProviders,
  type NormalizedCustomProvider,
} from './custom-providers-compat'
import { getProfileDir } from './hermes-profile'

export type StoredProviderApiMode =
  | 'chat_completions'
  | 'codex_responses'
  | 'anthropic_messages'
  | 'bedrock_converse'
  | 'codex_app_server'

export type CanonicalProviderIdentity =
  | { kind: 'builtin'; poolKey: string; lookupKey: string }
  | { kind: 'custom'; poolKey: `custom:${string}`; lookupKey: string }

export type StoredProviderCredentialSource =
  | { kind: 'builtin-env'; envKey: string }
  | { kind: 'custom-inline'; providerSource: 'custom_providers' | 'providers'; providerKey?: string }
  | { kind: 'custom-env'; envKey: string; providerSource: 'custom_providers' | 'providers'; providerKey?: string }
  | { kind: 'none' }

export interface ResolvedStoredProviderRuntime {
  identity: CanonicalProviderIdentity
  baseUrl: string
  apiMode: StoredProviderApiMode
  hasApiKey: boolean
  /** Server-only credential. Never serialize this object in an HTTP response. */
  apiKey: string
  credentialSource: StoredProviderCredentialSource
}

export interface ResolveStoredProviderRuntimeOptions {
  profile: string
  poolKey: string
  config?: Record<string, any>
  envContent?: string
}

export class ProviderCredentialError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ProviderCredentialError'
    this.status = status
  }
}

const PROVIDER_LOOKUP_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const REDACTED_PROVIDER_FIELDS = new Set([
  'api_key',
  'apiKey',
  'token',
  'access_token',
  'authorization',
  'password',
  'secret',
])
const NON_SECRET_AUTH_METADATA_SUFFIXES = [
  'authorizationurl',
  'authorizationendpoint',
  'authenticationurl',
  'authenticationendpoint',
  'authurl',
  'authendpoint',
  'tokenurl',
  'tokenendpoint',
  'tokenmethod',
  'authorizationmethod',
  'authenticationmethod',
  'authmethod',
  'authorizationtype',
  'authenticationtype',
  'authtype',
  'tokentype',
]

function isRedactedProviderField(key: string): boolean {
  if (REDACTED_PROVIDER_FIELDS.has(key)) return true
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!normalized || normalized === 'hasapikey' || normalized.endsWith('env')) return false
  const words = new Set(
    key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )
  const hasHighConfidenceSecretMarker = normalized.includes('apikey') ||
    (words.has('api') && words.has('key')) ||
    words.has('secret') ||
    words.has('password') ||
    words.has('passphrase') ||
    (words.has('private') && words.has('key')) ||
    (words.has('signing') && words.has('key')) ||
    normalized.includes('connectionstring') ||
    words.has('cookie') ||
    words.has('credential')
  if (hasHighConfidenceSecretMarker) return true
  if (NON_SECRET_AUTH_METADATA_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return false
  return words.has('auth') ||
    words.has('authentication') ||
    words.has('authorization') ||
    words.has('token')
}

function normalizeLookupKey(value: string): string {
  const lookupKey = value.trim().toLowerCase()
  if (!PROVIDER_LOOKUP_KEY.test(lookupKey)) {
    throw new ProviderCredentialError('Invalid provider pool key')
  }
  return lookupKey
}

export function canonicalProviderIdentity(rawPoolKey: string): CanonicalProviderIdentity {
  const value = String(rawPoolKey || '').trim()
  if (!value) throw new ProviderCredentialError('Invalid provider pool key')

  if (value.startsWith('custom:')) {
    const lookupKey = normalizeLookupKey(value.slice('custom:'.length))
    return { kind: 'custom', poolKey: `custom:${lookupKey}`, lookupKey }
  }
  if (value.startsWith('custom_')) {
    const lookupKey = normalizeLookupKey(value.slice('custom_'.length))
    return { kind: 'custom', poolKey: `custom:${lookupKey}`, lookupKey }
  }

  const lookupKey = normalizeLookupKey(value)
  return { kind: 'builtin', poolKey: lookupKey, lookupKey }
}

export function providerPoolKeyForCustomName(name: string): `custom:${string}` {
  const lookupKey = String(name || '').trim().toLowerCase().replace(/\s+/g, '-')
  if (!PROVIDER_LOOKUP_KEY.test(lookupKey)) {
    throw new ProviderCredentialError('Invalid custom provider name')
  }
  return `custom:${lookupKey}`
}

export function credentialReplacement(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeProfile(profile: string): string {
  const value = String(profile || '').trim() || 'default'
  if (value === 'default') return value
  if (!PROFILE_NAME.test(value) || value === '.' || value === '..') {
    throw new ProviderCredentialError('Invalid profile name')
  }
  return value
}

function strictProfileDir(profile: string): string {
  const normalized = normalizeProfile(profile)
  const defaultDir = getProfileDir('default')
  if (normalized === 'default') return defaultDir
  const profileDir = getProfileDir(normalized)
  return profileDir === defaultDir ? '' : profileDir
}

async function readProfileConfig(profile: string): Promise<Record<string, any>> {
  if (!strictProfileDir(profile)) return {}
  return readConfigYamlForProfile(profile)
}

async function readProfileEnv(profile: string): Promise<string> {
  const profileDir = strictProfileDir(profile)
  if (!profileDir) return ''
  return await safeReadFile(join(profileDir, '.env')) || ''
}

export function readEnvCredential(envContent: string, envKey: string): string {
  const key = String(envKey || '').trim()
  if (!key) return ''

  for (const line of String(envContent || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equalIndex = trimmed.indexOf('=')
    if (equalIndex < 0 || trimmed.slice(0, equalIndex).trim() !== key) continue
    const raw = trimmed.slice(equalIndex + 1).trim()
    if (!raw || raw.startsWith('#')) return ''
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1).trim()
    }
    return raw
  }
  return ''
}

function normalizeBaseUrl(value: unknown): string {
  return String(value || '').trim().replace(/\/+$/, '')
}

function parseStoredApiMode(value: unknown): StoredProviderApiMode | undefined {
  const mode = String(value || '').trim()
  if (
    mode === 'chat_completions' ||
    mode === 'codex_responses' ||
    mode === 'anthropic_messages' ||
    mode === 'bedrock_converse' ||
    mode === 'codex_app_server'
  ) {
    return mode
  }
  return undefined
}

function normalizeStoredApiMode(value: unknown, fallback: StoredProviderApiMode): StoredProviderApiMode {
  return parseStoredApiMode(value) || fallback
}

function inferApiMode(providerKey: string, baseUrl: string): StoredProviderApiMode {
  const provider = providerKey.toLowerCase()
  const endpoint = baseUrl.toLowerCase()
  if (provider === 'anthropic' || provider.includes('claude') || endpoint.includes('anthropic')) {
    return 'anthropic_messages'
  }
  if (endpoint.includes('bedrock')) return 'bedrock_converse'
  return 'chat_completions'
}

function findCustomProvider(config: Record<string, any>, identity: Extract<CanonicalProviderIdentity, { kind: 'custom' }>): NormalizedCustomProvider | undefined {
  return getCompatibleCustomProviders(config).find((entry) => {
    try {
      return providerPoolKeyForCustomName(entry.name) === identity.poolKey
    } catch {
      return false
    }
  })
}

function customSourceDetails(entry: NormalizedCustomProvider): {
  providerSource: 'custom_providers' | 'providers'
  providerKey?: string
} {
  return {
    providerSource: entry.source,
    ...(entry.provider_key ? { providerKey: entry.provider_key } : {}),
  }
}

export async function resolveStoredProviderRuntime(
  options: ResolveStoredProviderRuntimeOptions,
): Promise<ResolvedStoredProviderRuntime> {
  const profile = normalizeProfile(options.profile)
  const identity = canonicalProviderIdentity(options.poolKey)
  const config = options.config ?? await readProfileConfig(profile)
  const envContent = options.envContent ?? await readProfileEnv(profile)

  if (identity.kind === 'custom') {
    const entry = findCustomProvider(config, identity)
    if (!entry) {
      throw new ProviderCredentialError(`Custom provider "${identity.poolKey}" not found`, 404)
    }

    const inlineApiKey = credentialReplacement(entry.api_key) || ''
    const envKey = credentialReplacement(entry.key_env) || ''
    const envApiKey = inlineApiKey || !envKey
      ? ''
      : readEnvCredential(envContent, envKey)
    const apiKey = inlineApiKey || envApiKey
    const baseUrl = normalizeBaseUrl(entry.base_url)
    const apiMode = normalizeStoredApiMode(entry.api_mode, inferApiMode('', baseUrl))
    const sourceDetails = customSourceDetails(entry)
    const credentialSource: StoredProviderCredentialSource = inlineApiKey
      ? { kind: 'custom-inline', ...sourceDetails }
      : envApiKey
        ? { kind: 'custom-env', envKey, ...sourceDetails }
        : { kind: 'none' }

    return {
      identity,
      baseUrl,
      apiMode,
      hasApiKey: Boolean(apiKey),
      apiKey,
      credentialSource,
    }
  }

  const mapping = PROVIDER_ENV_MAP[identity.lookupKey]
  const preset = PROVIDER_PRESETS.find(provider => provider.value === identity.lookupKey)
  const baseUrlFromEnv = mapping?.base_url_env
    ? readEnvCredential(envContent, mapping.base_url_env)
    : ''
  const baseUrl = normalizeBaseUrl(baseUrlFromEnv || preset?.base_url || '')
  const envKey = String(mapping?.api_key_env || '').trim()
  const apiKey = envKey ? readEnvCredential(envContent, envKey) : ''
  const apiMode = normalizeStoredApiMode(
    preset?.api_mode,
    inferApiMode(identity.lookupKey, baseUrl),
  )

  return {
    identity,
    baseUrl,
    apiMode,
    hasApiKey: Boolean(apiKey),
    apiKey,
    credentialSource: apiKey && envKey
      ? { kind: 'builtin-env', envKey }
      : { kind: 'none' },
  }
}

export function normalizeCredentialEndpoint(value: unknown): string {
  const endpoint = String(value || '').trim()
  if (!endpoint) return ''
  try {
    const parsed = new URL(endpoint)
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return endpoint.replace(/\/+$/, '')
  }
}

export function assertStoredProviderRuntimeMatch(
  suppliedBaseUrl: unknown,
  suppliedApiMode: unknown,
  stored: ResolvedStoredProviderRuntime,
): void {
  const suppliedEndpoint = normalizeCredentialEndpoint(suppliedBaseUrl)
  const storedEndpoint = normalizeCredentialEndpoint(stored.baseUrl)
  if (!storedEndpoint || (suppliedEndpoint && suppliedEndpoint !== storedEndpoint)) {
    throw new ProviderCredentialError('Provider endpoint does not match the stored credential source')
  }

  const suppliedMode = String(suppliedApiMode || '').trim()
  if (suppliedMode) {
    const normalizedSuppliedMode = parseStoredApiMode(suppliedMode)
    if (!normalizedSuppliedMode) {
      throw new ProviderCredentialError('Invalid provider API protocol')
    }
    const comparableSuppliedMode = normalizedSuppliedMode === 'codex_app_server'
      ? 'codex_responses'
      : normalizedSuppliedMode
    const comparableStoredMode = stored.apiMode === 'codex_app_server'
      ? 'codex_responses'
      : stored.apiMode
    if (comparableSuppliedMode !== comparableStoredMode) {
      throw new ProviderCredentialError('Provider API protocol does not match the stored credential source')
    }
  }
}

function hasInlineProviderSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasInlineProviderSecret)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
    isRedactedProviderField(key)
      ? Boolean(credentialReplacement(nested))
      : hasInlineProviderSecret(nested)
  ))
}

function redactProviderSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProviderSecretFields)
  if (!value || typeof value !== 'object') return value

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isRedactedProviderField(key)
      ? ''
      : redactProviderSecretFields(nested)
  }
  return output
}

function projectProviderEntry(value: unknown, envContent: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return redactProviderSecretFields(value)
  }
  const entry = value as Record<string, unknown>
  const envKey = credentialReplacement(entry.key_env) || credentialReplacement(entry.api_key_env) || ''
  const hasApiKey = hasInlineProviderSecret(entry) || Boolean(envKey && readEnvCredential(envContent, envKey))
  const projected = redactProviderSecretFields(entry) as Record<string, unknown>
  projected.api_key = ''
  if ('apiKey' in entry) projected.apiKey = ''
  projected.has_api_key = hasApiKey
  return projected
}

function isProviderDictionary(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const providerEntryFields = new Set([
    'name',
    'baseurl',
    'api',
    'model',
    'defaultmodel',
    'models',
    'keyenv',
    'apikeyenv',
    'apimode',
    'contextlength',
  ])
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    return !isRedactedProviderField(key) &&
      !providerEntryFields.has(normalizedKey) &&
      !!entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry)
  })
}

export async function projectProviderConfigForResponse(
  config: Record<string, any>,
  options: { profile: string; envContent?: string },
): Promise<Record<string, any>> {
  const envContent = options.envContent ?? await readProfileEnv(options.profile)
  const response = { ...config }

  if (Object.prototype.hasOwnProperty.call(config, 'model')) {
    if (config.model && typeof config.model === 'object' && !Array.isArray(config.model)) {
      const model = config.model as Record<string, unknown>
      const projected = redactProviderSecretFields(model) as Record<string, unknown>
      if (hasInlineProviderSecret(model)) {
        projected.api_key = ''
        if ('apiKey' in model) projected.apiKey = ''
        projected.has_api_key = true
      }
      response.model = projected
    } else {
      response.model = redactProviderSecretFields(config.model)
    }
  }

  if (Object.prototype.hasOwnProperty.call(config, 'custom_providers')) {
    response.custom_providers = Array.isArray(config.custom_providers)
      ? config.custom_providers.map(entry => projectProviderEntry(entry, envContent))
      : redactProviderSecretFields(config.custom_providers)
  }
  if (Object.prototype.hasOwnProperty.call(config, 'providers')) {
    response.providers = isProviderDictionary(config.providers)
      ? Object.fromEntries(
          Object.entries(config.providers).map(([key, entry]) => [key, projectProviderEntry(entry, envContent)]),
        )
      : redactProviderSecretFields(config.providers)
  }

  return response
}
