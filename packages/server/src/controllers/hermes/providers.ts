import { existsSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { getActiveAuthPath } from '../../services/hermes/hermes-profile'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { readConfigYaml, writeConfigYaml, saveEnvValue, PROVIDER_ENV_MAP } from '../../services/config-helpers'
import { logger } from '../../services/logger'

function buildProviderEntry(name: string, base_url: string, api_key: string, model: string, context_length?: number) {
  const entry: any = { name, base_url, api_key, model }
  if (context_length && context_length > 0) {
    entry.models = { [model]: { context_length } }
  }
  return entry
}

export async function create(ctx: any) {
  const { name, base_url, api_key, model, context_length, providerKey } = ctx.request.body as {
    name: string; base_url: string; api_key: string; model: string; context_length?: number; providerKey?: string | null
  }
  if (!name || !base_url || !model) {
    ctx.status = 400; ctx.body = { error: 'Missing name, base_url, or model' }; return
  }
  if (!api_key) {
    ctx.status = 400; ctx.body = { error: 'Missing API key' }; return
  }
  try {
    const poolKey = providerKey || `custom:${name.trim().toLowerCase().replace(/ /g, '-')}`
    const isBuiltin = poolKey in PROVIDER_ENV_MAP
    const config = await readConfigYaml()
    if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
    if (!isBuiltin) {
      if (!Array.isArray(config.custom_providers)) { config.custom_providers = [] }
      const existing = (config.custom_providers as any[]).find(
        (e: any) => `custom:${e.name}` === poolKey
      )
      if (existing) {
        existing.base_url = base_url
        existing.api_key = api_key
        existing.model = model
        if (context_length && context_length > 0) {
          if (!existing.models) existing.models = {}
          existing.models[model] = existing.models[model] || {}
          existing.models[model].context_length = context_length
        }
      } else {
        config.custom_providers.push(buildProviderEntry(name.trim().toLowerCase().replace(/ /g, '-'), base_url, api_key, model, context_length))
      }
      config.model.default = model
      config.model.provider = poolKey
    } else {
      console.log(PROVIDER_ENV_MAP[poolKey])
      if (PROVIDER_ENV_MAP[poolKey].api_key_env) {
        await saveEnvValue(PROVIDER_ENV_MAP[poolKey].api_key_env, api_key)
        if (PROVIDER_ENV_MAP[poolKey].base_url_env) { await saveEnvValue(PROVIDER_ENV_MAP[poolKey].base_url_env, base_url) }
        config.model.default = model
        config.model.provider = poolKey
      } else {
        if (!Array.isArray(config.custom_providers)) { config.custom_providers = [] }
        const existing = (config.custom_providers as any[]).find(
          (e: any) => `custom:${e.name}` === `custom:${poolKey}`
        )
        if (existing) {
          existing.base_url = base_url
          existing.api_key = api_key
          existing.model = model
          if (context_length && context_length > 0) {
            if (!existing.models) existing.models = {}
            existing.models[model] = existing.models[model] || {}
            existing.models[model].context_length = context_length
          }
        } else {
          config.custom_providers.push(buildProviderEntry(poolKey, base_url, api_key, model, context_length))
        }
        config.model.default = model
        config.model.provider = `custom:${poolKey}`
      }
    }
    delete config.model.base_url
    delete config.model.api_key
    await writeConfigYaml(config)
    try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
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
    const isCustom = poolKey.startsWith('custom:')
    if (isCustom) {
      const config = await readConfigYaml()
      if (!Array.isArray(config.custom_providers)) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
      const entry = (config.custom_providers as any[]).find((e: any) => {
        return `custom:${e.name.trim().toLowerCase().replace(/ /g, '-')}` === poolKey
      })
      if (!entry) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
      if (name !== undefined) entry.name = name
      if (base_url !== undefined) entry.base_url = base_url
      if (api_key !== undefined) entry.api_key = api_key
      if (model !== undefined) entry.model = model
      await writeConfigYaml(config)
    } else {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping?.api_key_env) {
        ctx.status = 400; ctx.body = { error: `Cannot update credentials for "${poolKey}"` }; return
      }
      if (api_key !== undefined) { await saveEnvValue(envMapping.api_key_env, api_key) }
    }
    try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  try {
    const config = await readConfigYaml()
    const isCustom = poolKey.startsWith('custom:')
    if (isCustom) {
      const idx = Array.isArray(config.custom_providers)
        ? (config.custom_providers as any[]).findIndex((e: any) => {
          return `custom:${e.name.trim().toLowerCase().replace(/ /g, '-')}` === poolKey
        })
        : -1
      if (idx === -1) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
      (config.custom_providers as any[]).splice(idx, 1)
      await writeConfigYaml(config)
    } else {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (envMapping?.api_key_env) {
        await saveEnvValue(envMapping.api_key_env, '')
        if (envMapping.base_url_env) { await saveEnvValue(envMapping.base_url_env, '') }
      } else if (!envMapping?.api_key_env) {
        try {
          const authPath = getActiveAuthPath()
          if (existsSync(authPath)) {
            const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
            if (auth.providers?.[poolKey]) { delete auth.providers[poolKey] }
            if (auth.credential_pool?.[poolKey]) { delete auth.credential_pool[poolKey] }
            await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
          }
        } catch (err: any) { logger.error(err, 'Failed to clear OAuth tokens for %s', poolKey) }
      }
    }
    const currentProvider = config.model?.provider
    if (currentProvider === poolKey) {
      const freshConfig = await readConfigYaml()
      const remaining = Array.isArray(freshConfig.custom_providers) ? freshConfig.custom_providers as any[] : []
      if (remaining.length > 0) {
        const fallbackCp = remaining[0]
        const fallbackKey = `custom:${fallbackCp.name.trim().toLowerCase().replace(/ /g, '-')}`
        if (typeof freshConfig.model !== 'object' || freshConfig.model === null) { freshConfig.model = {} }
        freshConfig.model.default = fallbackCp.model
        freshConfig.model.provider = fallbackKey
        delete freshConfig.model.base_url
        delete freshConfig.model.api_key
        await writeConfigYaml(freshConfig)
      } else {
        freshConfig.model = {}
        await writeConfigYaml(freshConfig)
      }
    }
    try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
