import { existsSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import { updateConfigYamlForProfile, saveEnvValueForProfile, PROVIDER_ENV_MAP } from '../../services/config-helpers'
import { getCompatibleCustomProviders, normalizeCustomProviderEntry } from '../../services/hermes/custom-providers-compat'
import {
  canonicalProviderIdentity,
  credentialReplacement,
  providerPoolKeyForCustomName,
} from '../../services/hermes/provider-credentials'
import { PROVIDER_PRESETS } from '../../shared/providers'
import { logger } from '../../services/logger'

const OPTIONAL_API_KEY_PROVIDERS = new Set(['cliproxyapi', 'xai-oauth', 'openai-codex', 'google-gemini-cli', 'claude-oauth'])
const DIRECT_CONFIG_PROVIDERS = new Set(['xai-oauth', 'openai-codex', 'google-gemini-cli', 'claude-oauth'])
type ProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'
type ProviderConfigSource = 'custom_providers' | 'providers'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function authPathForProfile(profile: string): string {
  return join(getProfileDir(profile), 'auth.json')
}

async function clearStoredAuthProvider(profile: string, poolKey: string) {
  try {
    const authPath = authPathForProfile(profile)
    if (!existsSync(authPath)) return

    const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
    let changed = false
    if (auth.providers && Object.prototype.hasOwnProperty.call(auth.providers, poolKey)) {
      delete auth.providers[poolKey]
      changed = true
    }
    if (auth.credential_pool && Object.prototype.hasOwnProperty.call(auth.credential_pool, poolKey)) {
      delete auth.credential_pool[poolKey]
      changed = true
    }
    if (changed) {
      await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
    }
  } catch (err: any) { logger.error(err, 'Failed to clear auth credentials for %s', poolKey) }
}

function normalizeApiMode(value: unknown): ProviderApiMode | undefined {
  const apiMode = String(value || '').trim()
  return apiMode === 'chat_completions' ||
    apiMode === 'codex_responses' ||
    apiMode === 'anthropic_messages' ||
    apiMode === 'bedrock_converse' ||
    apiMode === 'codex_app_server'
    ? apiMode
    : undefined
}

function buildProviderEntry(name: string, base_url: string, api_key: string, model: string, context_length?: number, api_mode?: ProviderApiMode) {
  const entry: any = { name, base_url, api_key, model }
  if (api_mode) {
    entry.api_mode = api_mode
  }
  if (context_length && context_length > 0) {
    entry.models = { [model]: { context_length } }
  }
  return entry
}

function normalizeBaseUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '')
}

function builtinBaseUrl(poolKey: string, requestedBaseUrl: string): string {
  return requestedBaseUrl || PROVIDER_PRESETS.find(p => p.value === poolKey)?.base_url || ''
}

function shouldPersistBuiltinBaseUrl(poolKey: string, requestedBaseUrl: string): boolean {
  const presetBaseUrl = PROVIDER_PRESETS.find(p => p.value === poolKey)?.base_url || ''
  if (!requestedBaseUrl || !presetBaseUrl) return !!requestedBaseUrl
  return normalizeBaseUrl(requestedBaseUrl) !== normalizeBaseUrl(presetBaseUrl)
}

function providerKeyForCustomName(name: string): string {
  return providerPoolKeyForCustomName(name)
}

function findLegacyCustomProviderIndex(config: any, poolKey: string): number {
  return Array.isArray(config.custom_providers)
    ? (config.custom_providers as any[]).findIndex((e: any) => providerKeyForCustomName(e?.name) === poolKey)
    : -1
}

function findProviderDictKey(config: any, poolKey: string, requestedProviderKey = ''): string {
  const dict = config.providers
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return ''
  if (requestedProviderKey) {
    return Object.prototype.hasOwnProperty.call(dict, requestedProviderKey)
      ? requestedProviderKey
      : ''
  }
  for (const [key, entry] of Object.entries(dict)) {
    const normalized = normalizeCustomProviderEntry(entry, key, 'providers')
    if (normalized && providerKeyForCustomName(normalized.name) === poolKey) return key
  }
  return ''
}

export async function create(ctx: any) {
  const { name, base_url, api_key, model, context_length, providerKey, api_mode } = ctx.request.body as {
    name: string; base_url: string; api_key: string; model: string; context_length?: number; providerKey?: string | null; api_mode?: ProviderApiMode
  }
  const normalizedName = String(name || '').trim()
  let identity: ReturnType<typeof canonicalProviderIdentity>
  try {
    identity = canonicalProviderIdentity(providerKey || providerPoolKeyForCustomName(normalizedName))
  } catch (err: any) {
    ctx.status = err?.status || 400
    ctx.body = { error: err?.message || 'Invalid provider pool key' }
    return
  }
  const poolKey = identity.poolKey
  const isBuiltin = identity.kind === 'builtin' && identity.lookupKey in PROVIDER_ENV_MAP
  if (identity.kind === 'builtin' && !isBuiltin) {
    ctx.status = 400
    ctx.body = { error: `Unknown built-in provider "${identity.poolKey}"` }
    return
  }
  const effectiveBaseUrl = isBuiltin ? builtinBaseUrl(identity.lookupKey, base_url) : base_url
  const customApiMode = normalizeApiMode(api_mode)
  if (!normalizedName || !effectiveBaseUrl || !model) {
    ctx.status = 400; ctx.body = { error: 'Missing name, base_url, or model' }; return
  }
  if (!api_key && !OPTIONAL_API_KEY_PROVIDERS.has(String(providerKey || ''))) {
    ctx.status = 400; ctx.body = { error: 'Missing API key' }; return
  }
  try {
    const profile = requestedProfile(ctx)
    await updateConfigYamlForProfile(profile, async (config) => {
      if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
      if (!isBuiltin) {
        if (!Array.isArray(config.custom_providers)) { config.custom_providers = [] }
        const existing = (config.custom_providers as any[]).find(
          (e: any) => `custom:${e.name}` === poolKey
        )
        if (existing) {
          existing.base_url = effectiveBaseUrl
          existing.api_key = api_key
          existing.model = model
          const preset = PROVIDER_PRESETS.find(p => p.value === poolKey.replace('custom:', ''))
          if (preset?.api_mode) existing.api_mode = preset.api_mode
          else if (customApiMode) existing.api_mode = customApiMode
          if (context_length && context_length > 0) {
            if (!existing.models) existing.models = {}
            existing.models[model] = existing.models[model] || {}
            existing.models[model].context_length = context_length
          }
        } else {
          const entry = buildProviderEntry(normalizedName.toLowerCase().replace(/ /g, '-'), effectiveBaseUrl, api_key, model, context_length, customApiMode)
          const preset = PROVIDER_PRESETS.find(p => p.value === poolKey.replace('custom:', ''))
          if (preset?.api_mode) entry.api_mode = preset.api_mode
          config.custom_providers.push(entry)
        }
        config.model.default = model
        config.model.provider = poolKey
      } else {
        if (PROVIDER_ENV_MAP[poolKey].api_key_env) {
          await saveEnvValueForProfile(profile, PROVIDER_ENV_MAP[poolKey].api_key_env, api_key)
          if (PROVIDER_ENV_MAP[poolKey].base_url_env && shouldPersistBuiltinBaseUrl(poolKey, base_url)) { await saveEnvValueForProfile(profile, PROVIDER_ENV_MAP[poolKey].base_url_env, effectiveBaseUrl) }
          config.model.default = model
          config.model.provider = poolKey
        } else if (DIRECT_CONFIG_PROVIDERS.has(poolKey)) {
          if (PROVIDER_ENV_MAP[poolKey].base_url_env && shouldPersistBuiltinBaseUrl(poolKey, base_url)) { await saveEnvValueForProfile(profile, PROVIDER_ENV_MAP[poolKey].base_url_env, effectiveBaseUrl) }
          config.model.default = model
          config.model.provider = poolKey
        } else {
          if (!Array.isArray(config.custom_providers)) { config.custom_providers = [] }
          const existing = (config.custom_providers as any[]).find(
            (e: any) => `custom:${e.name}` === `custom:${poolKey}`
          )
          if (existing) {
            existing.base_url = effectiveBaseUrl
            existing.api_key = api_key
            existing.model = model
            const preset = PROVIDER_PRESETS.find(p => p.value === poolKey)
            if (preset?.api_mode) existing.api_mode = preset.api_mode
            else if (customApiMode) existing.api_mode = customApiMode
            if (context_length && context_length > 0) {
              if (!existing.models) existing.models = {}
              existing.models[model] = existing.models[model] || {}
              existing.models[model].context_length = context_length
            }
          } else {
            const entry = buildProviderEntry(poolKey, effectiveBaseUrl, api_key, model, context_length, customApiMode)
            const preset = PROVIDER_PRESETS.find(p => p.value === poolKey)
            if (preset?.api_mode) entry.api_mode = preset.api_mode
            config.custom_providers.push(entry)
          }
          config.model.default = model
          config.model.provider = `custom:${poolKey}`
        }
      }
      delete config.model.base_url
      delete config.model.api_key
      return config
    })
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function update(ctx: any) {
  let identity: ReturnType<typeof canonicalProviderIdentity>
  try {
    identity = canonicalProviderIdentity(decodeURIComponent(String(ctx.params.poolKey || '')))
  } catch (err: any) {
    ctx.status = err?.status || 400
    ctx.body = { error: err?.message || 'Invalid provider pool key' }
    return
  }

  const {
    name,
    base_url,
    api_key,
    model,
    api_mode,
    provider_source,
    provider_key,
  } = ctx.request.body as {
    name?: string
    base_url?: string
    api_key?: string | null
    model?: string
    api_mode?: ProviderApiMode
    provider_source?: ProviderConfigSource
    provider_key?: string
  }
  const customApiMode = normalizeApiMode(api_mode)
  const replacement = credentialReplacement(api_key)
  const requestedProviderKey = String(provider_key || '').trim()
  const rawRequestedSource = String(provider_source || '').trim()
  if (rawRequestedSource && rawRequestedSource !== 'custom_providers' && rawRequestedSource !== 'providers') {
    ctx.status = 400
    ctx.body = { error: 'Invalid provider source' }
    return
  }
  const requestedSource: ProviderConfigSource | '' = rawRequestedSource as ProviderConfigSource | ''
    || (requestedProviderKey ? 'providers' : '')
  if (
    (identity.kind !== 'custom' && (requestedSource || requestedProviderKey)) ||
    (requestedSource === 'custom_providers' && requestedProviderKey) ||
    (requestedSource === 'providers' && !requestedProviderKey)
  ) {
    ctx.status = 400
    ctx.body = { error: 'Provider source and provider key do not identify one credential source' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    if (identity.kind === 'custom') {
      const found = await updateConfigYamlForProfile(profile, async (config) => {
        const listIndex = requestedSource === 'providers'
          ? -1
          : findLegacyCustomProviderIndex(config, identity.poolKey)
        const dictKey = requestedSource === 'custom_providers'
          ? ''
          : findProviderDictKey(config, identity.poolKey, requestedProviderKey)
        const entry = listIndex >= 0
          ? config.custom_providers[listIndex]
          : dictKey
            ? config.providers[dictKey]
            : undefined
        if (!entry || typeof entry !== 'object') {
          return { data: config, result: false, write: false }
        }

        let writeConfig = false
        if (name !== undefined) { entry.name = name; writeConfig = true }
        if (base_url !== undefined) { entry.base_url = base_url; writeConfig = true }
        if (model !== undefined) { entry.model = model; writeConfig = true }
        if (customApiMode !== undefined) { entry.api_mode = customApiMode; writeConfig = true }

        if (replacement) {
          const inlineApiKey = credentialReplacement(entry.api_key)
          const envKey = String(entry.key_env || entry.api_key_env || '').trim()
          if (inlineApiKey || !envKey) {
            entry.api_key = replacement
            writeConfig = true
          } else {
            await saveEnvValueForProfile(profile, envKey, replacement)
          }
        }

        return { data: config, result: true, write: writeConfig }
      })
      if (!found) {
        ctx.status = 404
        ctx.body = { error: `Custom provider "${identity.poolKey}" not found` }
        return
      }
    } else {
      const envMapping = PROVIDER_ENV_MAP[identity.lookupKey]
      if (!envMapping?.api_key_env) {
        ctx.status = 400
        ctx.body = { error: `Cannot update credentials for "${identity.poolKey}"` }
        return
      }
      if (replacement) {
        await saveEnvValueForProfile(profile, envMapping.api_key_env, replacement)
      }
    }
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = err?.status || 500
    ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  let identity: ReturnType<typeof canonicalProviderIdentity>
  try {
    identity = canonicalProviderIdentity(decodeURIComponent(String(ctx.params.poolKey || '')))
  } catch (err: any) {
    ctx.status = err?.status || 400
    ctx.body = { error: err?.message || 'Invalid provider pool key' }
    return
  }
  const poolKey = identity.poolKey
  const query = ctx.query as { source?: string; providerKey?: string }
  if (query?.source && query.source !== 'providers' && query.source !== 'custom_providers') {
    ctx.status = 400
    ctx.body = { error: 'Invalid provider source' }
    return
  }
  const rawRequestedSource = String(query?.source || '').trim()
  const requestedProviderKey = typeof query?.providerKey === 'string' ? query.providerKey.trim() : ''
  const requestedSource: ProviderConfigSource | '' = rawRequestedSource as ProviderConfigSource | ''
    || (requestedProviderKey ? 'providers' : '')
  if (
    (identity.kind !== 'custom' && (requestedSource || requestedProviderKey)) ||
    (requestedSource === 'custom_providers' && requestedProviderKey) ||
    (requestedSource === 'providers' && !requestedProviderKey)
  ) {
    ctx.status = 400
    ctx.body = { error: 'Provider source and provider key do not identify one credential source' }
    return
  }
  try {
    const profile = requestedProfile(ctx)
    const isCustom = identity.kind === 'custom'
    const removed = await updateConfigYamlForProfile(profile, async (config) => {
      if (isCustom) {
        const removeLegacy = requestedSource !== 'providers'
        const removeDict = requestedSource !== 'custom_providers'
        let didRemove = false
        if (removeLegacy) {
          const idx = findLegacyCustomProviderIndex(config, poolKey)
          if (idx !== -1) {
            ;(config.custom_providers as any[]).splice(idx, 1)
            didRemove = true
          }
        }
        if (!didRemove && removeDict) {
          const dictKey = findProviderDictKey(config, poolKey, requestedProviderKey)
          if (dictKey) {
            delete config.providers[dictKey]
            didRemove = true
          }
        }
        if (!didRemove) return { data: config, result: false, write: false }
      } else {
        const envMapping = PROVIDER_ENV_MAP[identity.lookupKey]
        if (envMapping?.api_key_env) {
          await saveEnvValueForProfile(profile, envMapping.api_key_env, '')
        }
        if (envMapping?.base_url_env) {
          await saveEnvValueForProfile(profile, envMapping.base_url_env, '')
        }
      }
      if (config.model?.provider === poolKey) {
        const remaining = getCompatibleCustomProviders(config)
        if (remaining.length > 0) {
          const fallbackCp = remaining[0]
          const fallbackKey = providerKeyForCustomName(fallbackCp.name)
          if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
          config.model.default = fallbackCp.model || Object.keys(fallbackCp.models || {})[0] || ''
          config.model.provider = fallbackKey
          delete config.model.base_url
          delete config.model.api_key
        } else {
          config.model = {}
        }
      }
      return { data: config, result: true }
    })
    if (!removed) {
      ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
    }
    if (!isCustom) {
      const envMapping = PROVIDER_ENV_MAP[identity.lookupKey]
      if (!envMapping) {
        ctx.status = 404; ctx.body = { error: `Provider "${poolKey}" not found` }; return
      }
    }
    await clearStoredAuthProvider(profile, poolKey)
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
