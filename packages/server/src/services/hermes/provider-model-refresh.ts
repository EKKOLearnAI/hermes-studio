import {
  normalizeCatalogBaseUrl,
  readProviderModelCatalogCache,
  resolveProviderCatalogEntry,
  writeProviderModelCatalogEntry,
  type ProviderModelCatalogEntry,
} from './model-catalog-cache'
import {
  fetchProviderCatalogForTest,
  getProviderEditorDetail,
  ProviderEditorError,
  type ProviderApiMode,
} from './provider-editor'
import { PROVIDER_ENV_MAP, readConfigYamlForProfile } from '../config-helpers'
import { getCompatibleCustomProviders, normalizeCustomProviderEntry } from './custom-providers-compat'
import { PROVIDER_PRESETS } from '../../shared/providers'
import { getProfileDir } from './hermes-profile'
import { readFile } from 'fs/promises'
import { join } from 'path'
import YAML from 'js-yaml'

export interface ProviderModelRefreshDiff {
  added: string[]
  removed: string[]
  unchanged: string[]
}

export interface ProviderModelRefreshResult {
  provider_id: string
  applied: boolean
  requires_confirmation: boolean
  models: string[]
  previous_models: string[]
  unavailable_models: string[]
  restore_available: boolean
  diff: ProviderModelRefreshDiff
  default_model?: string
  preferred_model?: string
  message?: string
}

const inflight = new Map<string, Promise<ProviderModelRefreshResult>>()

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map(model => String(model || '').trim()).filter(Boolean)))
}

function lockKey(profile: string, providerId: string): string {
  return `${profile}::${providerId}`
}

function refreshCapability(apiMode: ProviderApiMode | undefined): { supported: boolean; reason?: string } {
  if (apiMode === 'bedrock_converse' || apiMode === 'codex_app_server') {
    return { supported: false, reason: `Model refresh is not available for ${apiMode}` }
  }
  return { supported: true }
}

function diffModels(current: string[], remote: string[]): ProviderModelRefreshDiff {
  const currentSet = new Set(current)
  const remoteSet = new Set(remote)
  return {
    added: remote.filter(model => !currentSet.has(model)),
    removed: current.filter(model => !remoteSet.has(model)),
    unchanged: remote.filter(model => currentSet.has(model)),
  }
}

async function currentModelsForProvider(
  profile: string,
  providerId: string,
  baseUrl: string,
): Promise<{ models: string[]; entry?: ProviderModelCatalogEntry; freeOnly: boolean }> {
  const freeOnly = providerId === 'openrouter'
  const cache = await readProviderModelCatalogCache()
  const entry = resolveProviderCatalogEntry(cache, providerId, baseUrl, { freeOnly, profile })
  if (entry?.models?.length) {
    return {
      models: uniqueModels([...entry.models, ...(entry.unavailable_models || [])]),
      entry,
      freeOnly,
    }
  }

  // Fallback to configured/static models when no cache entry exists yet.
  const config = await readConfigYamlForProfile(profile)
  if (providerId.startsWith('custom:')) {
    const custom = getCompatibleCustomProviders(config).find(
      item => `custom:${String(item.name || '').trim().toLowerCase().replace(/ /g, '-')}` === providerId,
    )
    const configured = uniqueModels([
      custom?.model || '',
      ...(custom?.models ? Object.keys(custom.models) : []),
    ])
    return { models: configured, freeOnly }
  }
  const preset = PROVIDER_PRESETS.find(item => item.value === providerId)
  return { models: uniqueModels(preset?.models || []), freeOnly }
}

async function protectedModels(profile: string, providerId: string, preferredModel: string): Promise<string[]> {
  const config = await readConfigYamlForProfile(profile)
  const modelSection = config.model
  const defaults: string[] = []
  if (typeof modelSection === 'object' && modelSection !== null) {
    const defaultProvider = String(modelSection.provider || '').trim()
    const defaultModel = String(modelSection.default || '').trim()
    if (defaultProvider === providerId && defaultModel) defaults.push(defaultModel)
  }
  if (preferredModel.trim()) defaults.push(preferredModel.trim())
  return uniqueModels(defaults)
}

async function applyAuthoritativeList(input: {
  profile: string
  providerId: string
  label: string
  baseUrl: string
  freeOnly: boolean
  remoteModels: string[]
  currentEntry?: ProviderModelCatalogEntry
  protectedModels: string[]
}): Promise<ProviderModelCatalogEntry> {
  const remote = uniqueModels(input.remoteModels)
  if (remote.length === 0) {
    throw new ProviderEditorError('Provider returned an empty model catalog', 422, 'PROVIDER_EMPTY_CATALOG')
  }
  const unavailable = input.protectedModels.filter(model => !remote.includes(model))
  const previousModels = uniqueModels(input.currentEntry?.models || [])
  const previousUnavailable = uniqueModels(input.currentEntry?.unavailable_models || [])
  return writeProviderModelCatalogEntry({
    provider: input.providerId,
    label: input.label,
    base_url: input.baseUrl,
    models: remote,
    source: 'live',
    free_only: input.freeOnly,
    profile: input.profile,
    profiles: [input.profile],
    unavailable_models: unavailable,
    previous_models: previousModels.length ? previousModels : null,
    previous_unavailable_models: previousUnavailable.length ? previousUnavailable : null,
    previous_updated_at: input.currentEntry?.updated_at || null,
  })
}

export async function refreshProviderModels(
  profile: string,
  providerId: string,
  options: { confirm?: boolean } = {},
): Promise<ProviderModelRefreshResult> {
  const key = lockKey(profile, providerId)
  const existing = inflight.get(key)
  if (existing) return existing

  const task = (async () => {
    const detail = await getProviderEditorDetail(profile, providerId)
    if (!detail.editable) {
      throw new ProviderEditorError(`Provider "${providerId}" is not refreshable`, 404, 'PROVIDER_NOT_REFRESHABLE')
    }
    const capability = refreshCapability(detail.api_mode)
    if (!capability.supported) {
      throw new ProviderEditorError(capability.reason || 'Model refresh is not supported', 422, 'PROVIDER_REFRESH_UNSUPPORTED')
    }
    if (!detail.credential_configured) {
      throw new ProviderEditorError('Provider credential is not configured', 422, 'PROVIDER_REFRESH_NO_CREDENTIAL')
    }

    const baseUrl = normalizeCatalogBaseUrl(detail.base_url)
    const { models: currentModels, entry, freeOnly } = await currentModelsForProvider(profile, providerId, baseUrl)
    const protectedList = await protectedModels(profile, providerId, detail.preferred_model)
    const remoteModels = await fetchFullRemoteModels(profile, providerId, detail.api_mode)
    const diff = diffModels(currentModels, remoteModels)

    if (diff.removed.length > 0 && !options.confirm) {
      return {
        provider_id: providerId,
        applied: false,
        requires_confirmation: true,
        models: currentModels,
        previous_models: entry?.previous_models || [],
        unavailable_models: entry?.unavailable_models || [],
        restore_available: !!(entry?.previous_models?.length),
        diff,
        preferred_model: detail.preferred_model,
        message: 'Refreshing would remove models; confirmation is required',
      }
    }

    const written = await applyAuthoritativeList({
      profile,
      providerId,
      label: detail.label,
      baseUrl,
      freeOnly,
      remoteModels,
      currentEntry: entry,
      protectedModels: protectedList,
    })

    return {
      provider_id: providerId,
      applied: true,
      requires_confirmation: false,
      models: uniqueModels([...written.models, ...(written.unavailable_models || [])]),
      previous_models: written.previous_models || [],
      unavailable_models: written.unavailable_models || [],
      restore_available: !!(written.previous_models?.length),
      diff,
      preferred_model: detail.preferred_model,
    }
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    if (inflight.get(key) === task) inflight.delete(key)
  }
}

async function fetchFullRemoteModels(
  profile: string,
  providerId: string,
  apiMode: ProviderApiMode | undefined,
): Promise<string[]> {
  const detailAndKey = await loadCredentialForRefresh(profile, providerId)
  return fetchProviderCatalogForTest(detailAndKey.baseUrl, detailAndKey.apiKey, apiMode)
}

async function loadCredentialForRefresh(profile: string, providerId: string): Promise<{ baseUrl: string; apiKey: string }> {
  const detail = await getProviderEditorDetail(profile, providerId)
  const envRaw = await readFile(join(getProfileDir(profile), '.env'), 'utf-8').catch(() => '')
  const configRaw = await readFile(join(getProfileDir(profile), 'config.yaml'), 'utf-8').catch(() => '')
  const config = (YAML.load(configRaw, { json: true }) as Record<string, any>) || {}
  const env: Record<string, string> = {}
  for (const line of envRaw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }

  if (detail.source === 'builtin_env') {
    const mapping = PROVIDER_ENV_MAP[providerId]
    return {
      baseUrl: detail.base_url,
      apiKey: mapping?.api_key_env ? env[mapping.api_key_env] || '' : '',
    }
  }

  if (detail.source === 'custom_providers' && Array.isArray(config.custom_providers)) {
    const entry = config.custom_providers.find((item: any) =>
      `custom:${String(item?.name || '').trim().toLowerCase().replace(/ /g, '-')}` === providerId,
    )
    const normalized = normalizeCustomProviderEntry(entry, '', 'custom_providers')
    const apiKey = normalized?.key_env ? env[normalized.key_env] || '' : String(normalized?.api_key || '')
    return { baseUrl: detail.base_url, apiKey }
  }
  if (detail.source === 'providers' && config.providers && typeof config.providers === 'object') {
    const key = detail.source_key || providerId.replace(/^custom:/, '')
    const entry = config.providers[key]
    const normalized = normalizeCustomProviderEntry(entry, key, 'providers')
    const apiKey = normalized?.key_env ? env[normalized.key_env] || '' : String(normalized?.api_key || '')
    return { baseUrl: detail.base_url, apiKey }
  }
  return { baseUrl: detail.base_url, apiKey: '' }
}

export async function restoreProviderModels(
  profile: string,
  providerId: string,
): Promise<ProviderModelRefreshResult> {
  const key = lockKey(profile, providerId)
  const existing = inflight.get(key)
  if (existing) return existing

  const task = (async () => {
    const detail = await getProviderEditorDetail(profile, providerId)
    const baseUrl = normalizeCatalogBaseUrl(detail.base_url)
    const freeOnly = providerId === 'openrouter'
    const cache = await readProviderModelCatalogCache()
    const entry = resolveProviderCatalogEntry(cache, providerId, baseUrl, { freeOnly, profile })
    if (!entry?.previous_models?.length) {
      throw new ProviderEditorError('No previous model list is available to restore', 404, 'PROVIDER_RESTORE_UNAVAILABLE')
    }

    const restored = await writeProviderModelCatalogEntry({
      provider: providerId,
      label: detail.label,
      base_url: baseUrl,
      models: entry.previous_models,
      source: 'live',
      free_only: freeOnly,
      profile,
      profiles: [profile],
      unavailable_models: entry.previous_unavailable_models || [],
      previous_models: entry.models,
      previous_unavailable_models: entry.unavailable_models || [],
      previous_updated_at: entry.updated_at,
    })

    const current = uniqueModels([...(entry.models || []), ...(entry.unavailable_models || [])])
    const next = uniqueModels([...(restored.models || []), ...(restored.unavailable_models || [])])
    return {
      provider_id: providerId,
      applied: true,
      requires_confirmation: false,
      models: next,
      previous_models: restored.previous_models || [],
      unavailable_models: restored.unavailable_models || [],
      restore_available: !!(restored.previous_models?.length),
      diff: diffModels(current, next),
      preferred_model: detail.preferred_model,
    }
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    if (inflight.get(key) === task) inflight.delete(key)
  }
}

export function providerModelRefreshCapabilities(apiMode?: ProviderApiMode): {
  refreshable: boolean
  refresh_reason?: string
} {
  const capability = refreshCapability(apiMode)
  return {
    refreshable: capability.supported,
    ...(capability.reason ? { refresh_reason: capability.reason } : {}),
  }
}
