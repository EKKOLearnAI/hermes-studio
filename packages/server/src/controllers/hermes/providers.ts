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

type CustomProviderSelection =
  | { status: 'found'; source: 'custom_providers'; listIndex: number }
  | { status: 'found'; source: 'providers'; dictKey: string }
  | { status: 'not_found' }
  | { status: 'ambiguous' }

function providerEntryMatchesPoolKey(
  entry: unknown,
  poolKey: string,
  providerKey = '',
  source: ProviderConfigSource = providerKey ? 'providers' : 'custom_providers',
): boolean {
  try {
    const normalized = normalizeCustomProviderEntry(entry, providerKey, source)
    return !!normalized && providerKeyForCustomName(normalized.name) === poolKey
  } catch {
    return false
  }
}

function selectCustomProvider(
  config: any,
  poolKey: string,
  requestedSource: ProviderConfigSource | '',
  requestedProviderKey = '',
): CustomProviderSelection {
  const matches: Array<Extract<CustomProviderSelection, { status: 'found' }>> = []

  if (requestedSource !== 'providers' && Array.isArray(config.custom_providers)) {
    for (const [listIndex, entry] of (config.custom_providers as any[]).entries()) {
      if (providerEntryMatchesPoolKey(entry, poolKey)) {
        matches.push({ status: 'found', source: 'custom_providers', listIndex })
      }
    }
  }

  const dict = config.providers
  if (requestedSource !== 'custom_providers' && dict && typeof dict === 'object' && !Array.isArray(dict)) {
    if (requestedProviderKey) {
      if (
        Object.prototype.hasOwnProperty.call(dict, requestedProviderKey) &&
        providerEntryMatchesPoolKey(dict[requestedProviderKey], poolKey, requestedProviderKey, 'providers')
      ) {
        matches.push({ status: 'found', source: 'providers', dictKey: requestedProviderKey })
      }
    } else {
      for (const [dictKey, entry] of Object.entries(dict)) {
        if (providerEntryMatchesPoolKey(entry, poolKey, dictKey, 'providers')) {
          matches.push({ status: 'found', source: 'providers', dictKey })
        }
      }
    }
  }

  if (matches.length === 0) return { status: 'not_found' }
  if (matches.length > 1) return { status: 'ambiguous' }
  return matches[0]
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
      const mutation = await updateConfigYamlForProfile(profile, async (config) => {
        const selection = selectCustomProvider(
          config,
          identity.poolKey,
          requestedSource,
          requestedProviderKey,
        )
        if (selection.status !== 'found') {
          return { data: config, result: selection.status, write: false }
        }
        const entry = selection.source === 'custom_providers'
          ? config.custom_providers[selection.listIndex]
          : config.providers[selection.dictKey]
        if (!entry || typeof entry !== 'object') {
          return { data: config, result: 'not_found' as const, write: false }
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

        return { data: config, result: 'updated' as const, write: writeConfig }
      })
      if (mutation === 'ambiguous') {
        ctx.status = 400
        ctx.body = { error: 'Provider selector is ambiguous' }
        return
      }
      if (mutation !== 'updated') {
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
    const removal = await updateConfigYamlForProfile(profile, async (config) => {
      if (isCustom) {
        const selection = selectCustomProvider(
          config,
          poolKey,
          requestedSource,
          requestedProviderKey,
        )
        if (selection.status !== 'found') {
          return { data: config, result: selection.status, write: false }
        }
        if (selection.source === 'custom_providers') {
          ;(config.custom_providers as any[]).splice(selection.listIndex, 1)
        } else {
          delete config.providers[selection.dictKey]
        }
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
      return { data: config, result: 'removed' as const }
    })
    if (removal === 'ambiguous') {
      ctx.status = 400
      ctx.body = { error: 'Provider selector is ambiguous' }
      return
    }
    if (removal !== 'removed') {
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
