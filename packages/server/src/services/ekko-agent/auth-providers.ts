import { readFile } from 'fs/promises'
import { join } from 'path'
import { getProfileDir } from '../hermes/hermes-profile'

const EKKO_AUTH_PROVIDERS = new Set(['nous', 'openai-codex', 'xai-oauth', 'qwen-oauth'])

export interface EkkoAuthorizedProviderCredentials {
  apiKey?: string
  baseUrl?: string
}

export async function resolveEkkoAuthorizedProviderCredentials(
  profile: string,
  provider: string,
): Promise<EkkoAuthorizedProviderCredentials> {
  const providerKey = String(provider || '').trim().toLowerCase()
  if (!EKKO_AUTH_PROVIDERS.has(providerKey)) return {}

  let auth: Record<string, any>
  try {
    auth = JSON.parse(await readFile(join(getProfileDir(profile), 'auth.json'), 'utf8'))
  } catch {
    return {}
  }

  const providerEntry = auth?.providers?.[providerKey]
  const poolEntries = auth?.credential_pool?.[providerKey]
  const poolEntry = Array.isArray(poolEntries)
    ? poolEntries.find((entry: unknown) => !!credentialToken(entry, providerKey))
    : undefined
  const credential = providerEntry || poolEntry
  if (!credentialToken(credential, providerKey) && !credentialToken(poolEntry, providerKey)) return {}

  return {
    apiKey: credentialToken(credential, providerKey) || credentialToken(poolEntry, providerKey) || undefined,
    baseUrl: credentialBaseUrl(credential) || credentialBaseUrl(poolEntry) || undefined,
  }
}

function credentialToken(value: unknown, provider: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const entry = value as Record<string, any>
  if (provider === 'nous') {
    return String(entry.agent_key || entry.runtime_api_key || entry.tokens?.access_token || entry.access_token || '').trim()
  }
  return String(entry.tokens?.access_token || entry.access_token || entry.runtime_api_key || '').trim()
}

function credentialBaseUrl(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const entry = value as Record<string, any>
  return String(entry.inference_base_url || entry.base_url || entry.runtime_base_url || '').trim().replace(/\/+$/, '')
}
