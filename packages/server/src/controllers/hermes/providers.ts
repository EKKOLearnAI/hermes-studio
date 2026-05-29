import { existsSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import { updateConfigYamlForProfile, saveEnvValueForProfile, PROVIDER_ENV_MAP } from '../../services/config-helpers'
import { PROVIDER_PRESETS } from '../../shared/providers'
import { logger } from '../../services/logger'

const OPTIONAL_API_KEY_PROVIDERS = new Set(['cliproxyapi', 'xai-oauth'])
const DIRECT_CONFIG_PROVIDERS = new Set(['xai-oauth'])

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

function buildProviderEntry(name: string, base_url: string, api_key: string, model: string, context_length?: number) {
  const entry: any = { name, base_url, api_key, model }
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

export async function create(ctx: any) {
  const { name, base_url, api_key, model, context_length, providerKey } = ctx.request.body as {
    name: string; base_url: string; api_key: string; model: string; context_length?: number; providerKey?: string | null
  }
  const normalizedName = String(name || '').trim()
  const poolKey = providerKey || `custom:${normalizedName.toLowerCase().replace(/ /g, '-')}`
  const isBuiltin = poolKey in PROVIDER_ENV_MAP
  const effectiveBaseUrl = isBuiltin ? builtinBaseUrl(poolKey, base_url) : base_url
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
          if (context_length && context_length > 0) {
            if (!existing.models) existing.models = {}
            existing.models[model] = existing.models[model] || {}
            existing.models[model].context_length = context_length
          }
        } else {
          const entry = buildProviderEntry(normalizedName.toLowerCase().replace(/ /g, '-'), effectiveBaseUrl, api_key, model, context_length)
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
            if (context_length && context_length > 0) {
              if (!existing.models) existing.models = {}
              existing.models[model] = existing.models[model] || {}
              existing.models[model].context_length = context_length
            }
          } else {
            const entry = buildProviderEntry(poolKey, effectiveBaseUrl, api_key, model, context_length)
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
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  const { name, base_url, api_key, model } = ctx.request.body as {
    name?: string; base_url?: string; api_key?: string; model?: string
  }
  try {
    const profile = requestedProfile(ctx)
    const isCustom = poolKey.startsWith('custom:')
    if (isCustom) {
      const found = await updateConfigYamlForProfile(profile, (config) => {
        if (!Array.isArray(config.custom_providers)) return { data: config, result: false, write: false }
        const entry = (config.custom_providers as any[]).find((e: any) => {
          return `custom:${e.name.trim().toLowerCase().replace(/ /g, '-')}` === poolKey
        })
        if (!entry) return { data: config, result: false, write: false }
        if (name !== undefined) entry.name = name
        if (base_url !== undefined) entry.base_url = base_url
        if (api_key !== undefined) entry.api_key = api_key
        if (model !== undefined) entry.model = model
        return { data: config, result: true }
      })
      if (!found) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
    } else {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping?.api_key_env) {
        ctx.status = 400; ctx.body = { error: `Cannot update credentials for "${poolKey}"` }; return
      }
      if (api_key !== undefined) { await saveEnvValueForProfile(profile, envMapping.api_key_env, api_key) }
    }
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  try {
    const profile = requestedProfile(ctx)
    const isCustom = poolKey.startsWith('custom:')
    const removed = await updateConfigYamlForProfile(profile, async (config) => {
      if (isCustom) {
        const idx = Array.isArray(config.custom_providers)
          ? (config.custom_providers as any[]).findIndex((e: any) => {
            return `custom:${e.name.trim().toLowerCase().replace(/ /g, '-')}` === poolKey
          })
          : -1
        if (idx === -1) return { data: config, result: false, write: false }
        ;(config.custom_providers as any[]).splice(idx, 1)
      } else {
        const envMapping = PROVIDER_ENV_MAP[poolKey]
        if (envMapping?.api_key_env) {
          await saveEnvValueForProfile(profile, envMapping.api_key_env, '')
        }
        if (envMapping?.base_url_env) {
          await saveEnvValueForProfile(profile, envMapping.base_url_env, '')
        }
      }
      if (config.model?.provider === poolKey) {
        const remaining = Array.isArray(config.custom_providers) ? config.custom_providers as any[] : []
        if (remaining.length > 0) {
          const fallbackCp = remaining[0]
          const fallbackKey = `custom:${fallbackCp.name.trim().toLowerCase().replace(/ /g, '-')}`
          if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
          config.model.default = fallbackCp.model
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
      const envMapping = PROVIDER_ENV_MAP[poolKey]
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
