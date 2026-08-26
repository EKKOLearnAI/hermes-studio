import { join } from 'path'
import { getCompatibleCustomProviders } from '../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../studio/contracts/providers'
import {
  getProfileDir,
  PROVIDER_ENV_MAP,
  readConfigYamlForProfile,
  safeReadFile,
} from '../../studio/public/profile-config'
import { resolveEkkoAuthorizedProviderCredentials } from './auth-providers'

export interface EkkoProviderRuntimeConfig {
  provider: string
  baseUrl?: string
  apiKey?: string
  apiMode?: string
}

export async function resolveEkkoProviderRuntimeConfig(input: {
  profile: string
  provider: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: string
}): Promise<EkkoProviderRuntimeConfig> {
  const provider = String(input.provider || '').trim()
  if (!provider) throw new Error('Ekko model provider is required')

  const profile = String(input.profile || '').trim() || 'default'
  const providerKey = providerKeyWithoutCustomPrefix(provider.toLowerCase())
  const authorized = await resolveEkkoAuthorizedProviderCredentials(profile, provider, input.model)
  const authorizedValuesFirst = providerKey === 'minimax-oauth'
  let baseUrl = String(
    authorizedValuesFirst
      ? authorized.baseUrl || input.baseUrl || ''
      : input.baseUrl || authorized.baseUrl || '',
  ).trim()
  let apiKey = String(
    authorizedValuesFirst
      ? authorized.apiKey || input.apiKey || ''
      : input.apiKey || authorized.apiKey || '',
  ).trim()
  let apiMode = String(
    authorizedValuesFirst
      ? authorized.apiMode || input.apiMode || ''
      : input.apiMode || authorized.apiMode || '',
  ).trim()

  let config: Record<string, any> = {}
  try {
    config = await readConfigYamlForProfile(profile)
  } catch {}
  const envContent = await safeReadFile(join(getProfileDir(profile), '.env')) || ''

  const customEntry = getCompatibleCustomProviders(config).find((entry) => {
    const entryKeys = [entry.name, entry.provider_key]
      .filter(Boolean)
      .flatMap(value => providerLookupCandidates(String(value)))
    return providerLookupCandidates(provider).some(candidate => entryKeys.includes(candidate))
  })
  if (customEntry) {
    if (!baseUrl) baseUrl = String(customEntry.base_url || '').trim()
    if (!apiKey) apiKey = String(customEntry.api_key || '').trim()
    if (!apiKey && customEntry.key_env) apiKey = parseEnvValue(envContent, customEntry.key_env)
    if (!apiMode) apiMode = String(customEntry.api_mode || '').trim()
  }

  const preset = PROVIDER_PRESETS.find(entry => entry.value === providerKey)
  const envMapping = PROVIDER_ENV_MAP[providerKey]
  if (!baseUrl) {
    baseUrl = envMapping?.base_url_env
      ? parseEnvValue(envContent, envMapping.base_url_env) || preset?.base_url || ''
      : preset?.base_url || ''
  }
  if (!apiKey && envMapping?.api_key_env) {
    apiKey = parseEnvValue(envContent, envMapping.api_key_env)
  }
  if (!apiMode) apiMode = String(preset?.api_mode || '').trim()

  return {
    provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiMode ? { apiMode } : {}),
  }
}

function providerKeyWithoutCustomPrefix(provider: string): string {
  if (provider.startsWith('custom:')) return provider.slice('custom:'.length)
  if (provider.startsWith('custom_')) return provider.slice('custom_'.length)
  return provider
}

function providerLookupCandidates(provider: string): string[] {
  const normalized = String(provider || '').trim().toLowerCase().replace(/ /g, '-')
  const withoutCustom = providerKeyWithoutCustomPrefix(normalized)
  return [...new Set([
    normalized,
    withoutCustom,
    withoutCustom ? `custom:${withoutCustom}` : '',
    withoutCustom ? `custom_${withoutCustom}` : '',
  ].filter(Boolean))]
}

function parseEnvValue(envContent: string, key: string): string {
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0 || trimmed.slice(0, separator).trim() !== key) continue
    const raw = trimmed.slice(separator + 1).trim()
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1)
    }
    return raw
  }
  return ''
}
