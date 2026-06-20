import { readFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../../config'
import { PROVIDER_PRESETS } from '../../shared/providers'
import { fetchProviderModels, PROVIDER_ENV_MAP, readConfigYamlForProfile } from '../config-helpers'
import { readAppConfig } from '../app-config'
import { getCompatibleCustomProviders } from './custom-providers-compat'
import { resolveCopilotOAuthToken } from './copilot-models'
import { logger } from '../logger'
import { safeFileStore } from '../safe-file-store'
import { getProfileDir, listProfileNamesFromDisk } from './hermes-profile'

export type ModelCatalogSource = 'live' | 'fallback'

export interface ProviderModelCatalogEntry {
  provider: string
  label: string
  base_url: string
  models: string[]
  source: ModelCatalogSource
  updated_at: string
  free_only?: boolean
  profiles?: string[]
}

export interface ProviderModelCatalogCache {
  version: 1
  updated_at: string
  providers: Record<string, ProviderModelCatalogEntry>
}

interface RefreshCandidate {
  provider: string
  label: string
  base_url: string
  api_key: string
  fallback_models: string[]
  free_only?: boolean
  profile: string
  skip_live_fetch?: boolean
}

interface StoredAuthCatalogCredential {
  hasAuth: boolean
  api_key?: string
  base_url?: string
}

const CACHE_VERSION = 1
const CACHE_PATH = join(config.appHome, 'cache', 'provider-model-catalog.json')
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const KEYLESS_CATALOG_PROVIDERS = new Set(['cliproxyapi'])
const AUTH_CATALOG_PROVIDERS = new Set([
  'openai-codex',
  'copilot',
  'xai-oauth',
  'nous',
  'google-gemini-cli',
  'claude-oauth',
])
let backgroundRefresh: Promise<void> | null = null

function emptyCache(): ProviderModelCatalogCache {
  return { version: CACHE_VERSION, updated_at: new Date(0).toISOString(), providers: {} }
}

function safeKey(value: string): boolean {
  return !!value && !RESERVED_KEYS.has(value)
}

export function normalizeCatalogBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

export function providerModelCatalogKey(provider: string, baseUrl: string, freeOnly = false): string {
  return `${provider.trim()}|${normalizeCatalogBaseUrl(baseUrl)}|${freeOnly ? 'free' : 'all'}`
}

function uniqueModels(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  return Array.from(new Set(models.map(model => String(model || '').trim()).filter(Boolean)))
}

function normalizeCache(raw: unknown): ProviderModelCatalogCache {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCache()
  const input = raw as Record<string, any>
  const providers: Record<string, ProviderModelCatalogEntry> = {}
  if (input.providers && typeof input.providers === 'object' && !Array.isArray(input.providers)) {
    for (const [key, value] of Object.entries(input.providers as Record<string, any>)) {
      if (!safeKey(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue
      const provider = String(value.provider || '').trim()
      const baseUrl = normalizeCatalogBaseUrl(value.base_url || '')
      const models = uniqueModels(value.models)
      if (!provider || !baseUrl) continue
      providers[key] = {
        provider,
        label: String(value.label || provider).trim() || provider,
        base_url: baseUrl,
        models,
        source: value.source === 'fallback' ? 'fallback' : 'live',
        updated_at: typeof value.updated_at === 'string' ? value.updated_at : new Date(0).toISOString(),
        ...(value.free_only === true ? { free_only: true } : {}),
        ...(Array.isArray(value.profiles) ? { profiles: uniqueModels(value.profiles) } : {}),
      }
    }
  }
  return {
    version: CACHE_VERSION,
    updated_at: typeof input.updated_at === 'string' ? input.updated_at : new Date(0).toISOString(),
    providers,
  }
}

export async function readProviderModelCatalogCache(): Promise<ProviderModelCatalogCache> {
  try {
    const raw = await safeFileStore.readText(CACHE_PATH)
    return normalizeCache(JSON.parse(raw))
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn(err, '[model-catalog-cache] failed to read provider model catalog cache')
    }
    return emptyCache()
  }
}

export function getCachedProviderModels(
  cache: ProviderModelCatalogCache,
  provider: string,
  baseUrl: string,
  freeOnly = false,
): string[] | null {
  const entry = cache.providers[providerModelCatalogKey(provider, baseUrl, freeOnly)]
  return entry && entry.models.length > 0 ? entry.models : null
}

export async function writeProviderModelCatalogEntry(input: {
  provider: string
  label: string
  base_url: string
  models: string[]
  source: ModelCatalogSource
  free_only?: boolean
  profiles?: string[]
  overwriteExistingModels?: boolean
}): Promise<ProviderModelCatalogEntry> {
  const provider = input.provider.trim()
  const baseUrl = normalizeCatalogBaseUrl(input.base_url)
  const models = uniqueModels(input.models)
  const key = providerModelCatalogKey(provider, baseUrl, input.free_only === true)
  const now = new Date().toISOString()
  const entry: ProviderModelCatalogEntry = {
    provider,
    label: input.label.trim() || provider,
    base_url: baseUrl,
    models,
    source: input.source,
    updated_at: now,
    ...(input.free_only === true ? { free_only: true } : {}),
    ...(input.profiles?.length ? { profiles: uniqueModels(input.profiles) } : {}),
  }

  await safeFileStore.updateText(CACHE_PATH, (current) => {
    let cache = emptyCache()
    if (current.trim()) {
      try { cache = normalizeCache(JSON.parse(current)) } catch { cache = emptyCache() }
    }
    const existing = cache.providers[key]
    if (existing && existing.models.length > 0 && input.overwriteExistingModels === false) {
      const profiles = Array.from(new Set([...(existing.profiles || []), ...(entry.profiles || [])]))
      cache.providers[key] = { ...existing, ...(profiles.length ? { profiles } : {}) }
    } else {
      cache.providers[key] = entry
    }
    cache.updated_at = now
    return JSON.stringify(cache, null, 2) + '\n'
  })

  return entry
}

export async function refreshProviderModelCatalog(input: {
  provider: string
  label: string
  base_url: string
  api_key?: string
  fallback_models?: string[]
  free_only?: boolean
  profiles?: string[]
}): Promise<ProviderModelCatalogEntry | null> {
  const provider = input.provider.trim()
  const baseUrl = normalizeCatalogBaseUrl(input.base_url)
  if (!provider || !baseUrl) return null

  const fetched = await fetchProviderModelsForCatalog(provider, baseUrl, input.api_key || '', input.free_only === true)
  if (fetched.length > 0) {
    return writeProviderModelCatalogEntry({
      provider,
      label: input.label,
      base_url: baseUrl,
      models: fetched,
      source: 'live',
      free_only: input.free_only,
      profiles: input.profiles,
    })
  }

  const fallback = uniqueModels(input.fallback_models)
  if (fallback.length > 0) {
    return writeProviderModelCatalogEntry({
      provider,
      label: input.label,
      base_url: baseUrl,
      models: fallback,
      source: 'fallback',
      free_only: input.free_only,
      profiles: input.profiles,
      overwriteExistingModels: false,
    })
  }
  return null
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key && value && !value.startsWith('#')) env[key] = value
  }
  return env
}

function providerKeyForCustom(name: string): string {
  return `custom:${name.trim().toLowerCase().replace(/ /g, '-')}`
}

function mergeCandidate(candidates: Map<string, RefreshCandidate>, candidate: RefreshCandidate) {
  const key = providerModelCatalogKey(candidate.provider, candidate.base_url, candidate.free_only === true)
  const existing = candidates.get(key)
  if (!existing) {
    candidates.set(key, candidate)
    return
  }
  existing.fallback_models = Array.from(new Set([...existing.fallback_models, ...candidate.fallback_models]))
  existing.profile = Array.from(new Set([existing.profile, candidate.profile])).join(',')
  if (!existing.api_key && candidate.api_key) existing.api_key = candidate.api_key
  existing.skip_live_fetch = existing.skip_live_fetch === true && candidate.skip_live_fetch === true
}

function authCredentialToken(value: any): string {
  return String(
    value?.agent_key ||
    value?.tokens?.access_token ||
    value?.access_token ||
    value?.tokens?.refresh_token ||
    value?.refresh_token ||
    '',
  ).trim()
}

function authAccessToken(value: any): string {
  return String(value?.tokens?.access_token || value?.access_token || '').trim()
}

async function fetchCodexOAuthModels(accessToken: string): Promise<string[]> {
  if (!accessToken) return []
  try {
    const res = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=1.0.0', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      logger.warn('[model-catalog-cache] Codex models returned %d', res.status)
      return []
    }
    const body = await res.json() as { models?: Array<{ slug?: unknown; visibility?: unknown; priority?: unknown }> }
    const sortable: Array<{ model: string; rank: number }> = []
    for (const item of Array.isArray(body.models) ? body.models : []) {
      const model = String(item.slug || '').trim()
      if (!model) continue
      const visibility = String(item.visibility || '').trim().toLowerCase()
      if (visibility === 'hide' || visibility === 'hidden') continue
      const priority = Number(item.priority)
      sortable.push({ model, rank: Number.isFinite(priority) ? priority : 10000 })
    }
    sortable.sort((a, b) => a.rank - b.rank || a.model.localeCompare(b.model))
    return uniqueModels(sortable.map(item => item.model))
  } catch (err) {
    logger.warn(err, '[model-catalog-cache] Codex models fetch failed')
    return []
  }
}

async function fetchGeminiOAuthModels(accessToken: string): Promise<string[]> {
  if (!accessToken) return []
  try {
    const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'google-api-nodejs-client/9.15.1 (gzip)',
        'X-Goog-Api-Client': 'gl-node/24.0.0',
      },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      logger.warn('[model-catalog-cache] Gemini quota models returned %d', res.status)
      return []
    }
    const body = await res.json() as { buckets?: Array<{ modelId?: unknown }> }
    return uniqueModels((Array.isArray(body.buckets) ? body.buckets : [])
      .map(bucket => String(bucket.modelId || '').trim())
      .filter(Boolean))
  } catch (err) {
    logger.warn(err, '[model-catalog-cache] Gemini quota models fetch failed')
    return []
  }
}

async function fetchProviderModelsForCatalog(provider: string, baseUrl: string, apiKey: string, freeOnly: boolean): Promise<string[]> {
  if (provider === 'openai-codex') return fetchCodexOAuthModels(apiKey)
  if (provider === 'google-gemini-cli') return fetchGeminiOAuthModels(apiKey)
  return fetchProviderModels(baseUrl, apiKey, freeOnly)
}

function hasOAuthCredential(value: any): boolean {
  return !!(
    value?.tokens?.access_token ||
    value?.tokens?.refresh_token ||
    value?.access_token ||
    value?.refresh_token ||
    value?.agent_key
  )
}

async function profileStoredAuthCredential(profile: string, provider: string): Promise<StoredAuthCatalogCredential> {
  try {
    const raw = await readFile(join(getProfileDir(profile), 'auth.json'), 'utf-8')
    const auth = JSON.parse(raw)
    const providerEntry = auth?.providers?.[provider]
    const pool = auth?.credential_pool?.[provider]
    const poolEntry = Array.isArray(pool) ? pool.find(hasOAuthCredential) : null
    const hasAuth = !!(
      hasOAuthCredential(providerEntry) ||
      poolEntry
    )
    if (!hasAuth) return { hasAuth: false }
    const providerSupportsLiveCatalog = provider === 'nous' ||
      provider === 'xai-oauth' ||
      provider === 'openai-codex' ||
      provider === 'google-gemini-cli'
    if (!providerSupportsLiveCatalog) return { hasAuth: true }
    const apiKey = provider === 'nous'
      ? authCredentialToken(providerEntry) || authCredentialToken(poolEntry)
      : authAccessToken(providerEntry) || authAccessToken(poolEntry)
    const baseUrl = String(
      providerEntry?.inference_base_url ||
      providerEntry?.base_url ||
      poolEntry?.inference_base_url ||
      poolEntry?.base_url ||
      '',
    ).trim()
    return { hasAuth: true, ...(apiKey ? { api_key: apiKey } : {}), ...(baseUrl ? { base_url: baseUrl } : {}) }
  } catch {
    return { hasAuth: false }
  }
}

async function collectRefreshCandidates(): Promise<RefreshCandidate[]> {
  const candidates = new Map<string, RefreshCandidate>()
  const presetsByProvider = new Map(PROVIDER_PRESETS.map(preset => [preset.value, preset]))
  const appConfig = await readAppConfig().catch((): { copilotEnabled?: boolean } => ({}))
  const copilotEnabled = appConfig.copilotEnabled === true

  for (const profile of listProfileNamesFromDisk()) {
    let env: Record<string, string> = {}
    try {
      env = parseEnv(await readFile(join(getProfileDir(profile), '.env'), 'utf-8'))
    } catch {}

    let configYaml: Record<string, any> = {}
    try { configYaml = await readConfigYamlForProfile(profile) } catch {}
    const activeProvider = typeof configYaml.model === 'object' && configYaml.model !== null
      ? String(configYaml.model.provider || '').trim()
      : ''

    for (const [provider, mapping] of Object.entries(PROVIDER_ENV_MAP)) {
      const preset = presetsByProvider.get(provider)
      if (!preset?.base_url) continue
      const apiKey = mapping.api_key_env ? env[mapping.api_key_env] || '' : ''
      let skipLiveFetch = false
      if (mapping.api_key_env && !apiKey) {
        if (provider !== 'copilot' || !copilotEnabled || !(await resolveCopilotOAuthToken(Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')))) {
          continue
        }
        skipLiveFetch = true
      }
      if (!mapping.api_key_env) {
        const keylessActive = KEYLESS_CATALOG_PROVIDERS.has(provider) && activeProvider === provider
        const authCredential = AUTH_CATALOG_PROVIDERS.has(provider)
          ? await profileStoredAuthCredential(profile, provider)
          : { hasAuth: false }
        if (!keylessActive && !authCredential.hasAuth) continue
        if (authCredential.api_key) {
          const authBaseUrl = normalizeCatalogBaseUrl(authCredential.base_url || preset.base_url)
          if (authBaseUrl) {
            mergeCandidate(candidates, {
              provider,
              label: preset.label,
              base_url: authBaseUrl,
              api_key: authCredential.api_key,
              fallback_models: preset.models,
              free_only: provider === 'openrouter',
              profile,
            })
            continue
          }
        }
        skipLiveFetch = authCredential.hasAuth && !keylessActive
      }
      const baseUrl = normalizeCatalogBaseUrl(mapping.base_url_env && env[mapping.base_url_env] ? env[mapping.base_url_env] : preset.base_url)
      if (!baseUrl) continue
      mergeCandidate(candidates, {
        provider,
        label: preset.label,
        base_url: baseUrl,
        api_key: apiKey,
        fallback_models: preset.models,
        free_only: provider === 'openrouter',
        profile,
        skip_live_fetch: skipLiveFetch,
      })
    }

    const customProviders = getCompatibleCustomProviders(configYaml)
    for (const cp of customProviders) {
      const name = cp.name
      const baseUrl = normalizeCatalogBaseUrl(cp.base_url)
      if (!name || !baseUrl) continue
      const provider = providerKeyForCustom(name)
      const presetModels = presetsByProvider.get(name)?.models || []
      // Respect the configured `models:` whitelist (v12+ dict) when present —
      // those entries should always be reachable as fallbacks even before a
      // live `/v1/models` probe runs.
      const configuredModels = cp.models ? Object.keys(cp.models) : []
      mergeCandidate(candidates, {
        provider,
        label: name,
        base_url: baseUrl,
        api_key: cp.api_key || '',
        fallback_models: uniqueModels([cp.model, ...configuredModels, ...presetModels]),
        profile,
      })
    }
  }

  return [...candidates.values()]
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) continue
      await worker(item)
    }
  })
  await Promise.all(workers)
}

export async function refreshConfiguredProviderModelCatalogs(options: { force?: boolean } = {}): Promise<void> {
  const cache = await readProviderModelCatalogCache()
  if (!options.force && Object.keys(cache.providers).length > 0) {
    logger.info('[model-catalog-cache] provider model catalog cache exists; skipping startup refresh')
    return
  }

  const candidates = await collectRefreshCandidates()
  if (candidates.length === 0) return
  logger.info('[model-catalog-cache] refreshing %d configured provider catalogs', candidates.length)
  await runLimited(candidates, 4, async (candidate) => {
    try {
      const profiles = candidate.profile.split(',').filter(Boolean)
      if (candidate.skip_live_fetch) {
        await writeProviderModelCatalogEntry({
          provider: candidate.provider,
          label: candidate.label,
          base_url: candidate.base_url,
          models: candidate.fallback_models,
          source: 'fallback',
          free_only: candidate.free_only,
          profiles,
          overwriteExistingModels: false,
        })
      } else {
        await refreshProviderModelCatalog({
          provider: candidate.provider,
          label: candidate.label,
          base_url: candidate.base_url,
          api_key: candidate.api_key,
          fallback_models: candidate.fallback_models,
          free_only: candidate.free_only,
          profiles,
        })
      }
    } catch (err) {
      logger.warn(err, '[model-catalog-cache] failed to refresh provider=%s base_url=%s', candidate.provider, candidate.base_url)
    }
  })
}

export function refreshConfiguredProviderModelCatalogsInBackground(reason = 'startup'): void {
  if (backgroundRefresh) return
  backgroundRefresh = refreshConfiguredProviderModelCatalogs()
    .catch(err => logger.warn(err, '[model-catalog-cache] background refresh failed reason=%s', reason))
    .finally(() => { backgroundRefresh = null })
}
