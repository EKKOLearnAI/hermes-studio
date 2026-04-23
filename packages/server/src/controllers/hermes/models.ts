import { readFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { getActiveEnvPath, getActiveAuthPath } from '../../services/hermes/hermes-profile'
import { readConfigYaml, writeConfigYaml, fetchProviderModels, buildModelGroups, PROVIDER_ENV_MAP } from '../../services/config-helpers'
import { buildProviderModelMap, PROVIDER_PRESETS } from '../../shared/providers'

const PROVIDER_MODEL_CATALOG = buildProviderModelMap()

export async function getAvailable(ctx: any) {
  try {
    const config = await readConfigYaml()
    const modelSection = config.model
    let currentDefault = ''
    let currentDefaultProvider = ''
    if (typeof modelSection === 'object' && modelSection !== null) {
      currentDefault = String(modelSection.default || '').trim()
      currentDefaultProvider = String(modelSection.provider || '').trim()
    } else if (typeof modelSection === 'string') {
      currentDefault = modelSection.trim()
    }

    const groups: Array<{ provider: string; label: string; base_url: string; models: string[]; api_key: string }> = []
    const seenProviders = new Set<string>()

    let envContent = ''
    try { envContent = await readFile(getActiveEnvPath(), 'utf-8') } catch { }

    const envHasValue = (key: string): boolean => {
      if (!key) return false
      const match = envContent.match(new RegExp(`^${key}\\s*=\\s*(.+)`, 'm'))
      return !!match && match[1].trim() !== '' && !match[1].trim().startsWith('#')
    }
    const envGetValue = (key: string): string => {
      if (!key) return ''
      const match = envContent.match(new RegExp(`^${key}\\s*=\\s*(.+)`, 'm'))
      return match?.[1]?.trim() || ''
    }
    const addGroup = (provider: string, label: string, base_url: string, models: string[], api_key: string) => {
      if (seenProviders.has(provider)) return
      seenProviders.add(provider)
      groups.push({ provider, label, base_url, models: [...models], api_key })
    }

    const isOAuthAuthorized = (providerKey: string): boolean => {
      try {
        const authPath = getActiveAuthPath()
        if (!existsSync(authPath)) return false
        const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
        const provider = auth.providers?.[providerKey]
        if (!provider) return false
        // Codex: providers.openai-codex.tokens.access_token
        // Nous:  providers.nous.access_token
        return !!(
          provider.tokens?.access_token ||
          provider.access_token
        )
      } catch { return false }
    }

    for (const [providerKey, envMapping] of Object.entries(PROVIDER_ENV_MAP)) {
      if (envMapping.api_key_env && !envHasValue(envMapping.api_key_env)) continue
      if (!envMapping.api_key_env && !isOAuthAuthorized(providerKey)) continue
      const preset = PROVIDER_PRESETS.find((p: any) => p.value === providerKey)
      const label = preset?.label || providerKey.replace(/^custom:/, '')
      const baseUrl = preset?.base_url || ''
      const catalogModels = PROVIDER_MODEL_CATALOG[providerKey]
      if (catalogModels && catalogModels.length > 0) {
        const apiKey = envMapping.api_key_env ? envGetValue(envMapping.api_key_env) : ''
        addGroup(providerKey, label, baseUrl, catalogModels, apiKey)
      }
    }

    const customProviders = Array.isArray(config.custom_providers)
      ? config.custom_providers as Array<{ name: string; base_url: string; model: string; api_key?: string }>
      : []

    const customFetches = await Promise.allSettled(
      customProviders.map(async cp => {
        if (!cp.base_url) return null
        const providerKey = `custom:${cp.name.trim().toLowerCase().replace(/ /g, '-')}`
        const baseUrl = cp.base_url.replace(/\/+$/, '')
        const bareKey = cp.name.trim().toLowerCase().replace(/ /g, '-')
        const builtinPreset = PROVIDER_PRESETS.find(p => p.value === bareKey)
        let models = builtinPreset?.models?.length ? [...builtinPreset.models] : [cp.model]
        if (cp.api_key) {
          try { const fetched = await fetchProviderModels(baseUrl, cp.api_key); if (fetched.length > 0) models = fetched } catch { }
        }
        const label = builtinPreset?.label || cp.name
        const presetBaseUrl = builtinPreset?.base_url || ''
        return { providerKey, label, base_url: presetBaseUrl || baseUrl, models, api_key: cp.api_key || '' }
      }),
    )

    for (const result of customFetches) {
      if (result.status === 'fulfilled' && result.value) {
        const { providerKey, label, base_url, models, api_key: cpApiKey } = result.value
        addGroup(providerKey, label, base_url, models, cpApiKey)
      }
    }

    for (const g of groups) { g.models = Array.from(new Set(g.models)) }

    if (groups.length === 0) {
      const fallback = buildModelGroups(config)
      const allProviders = PROVIDER_PRESETS.map((p: any) => ({ provider: p.value, label: p.label, base_url: p.base_url, models: p.models }))
      ctx.body = { ...fallback, allProviders }
      return
    }

    const allProviders = PROVIDER_PRESETS.map((p: any) => ({ provider: p.value, label: p.label, base_url: p.base_url, models: p.models }))
    ctx.body = { default: currentDefault, default_provider: currentDefaultProvider, groups, allProviders }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function getConfigModels(ctx: any) {
  try {
    const config = await readConfigYaml()
    ctx.body = buildModelGroups(config)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function setConfigModel(ctx: any) {
  const { default: defaultModel, provider: reqProvider } = ctx.request.body as { default: string; provider?: string }
  if (!defaultModel) {
    ctx.status = 400
    ctx.body = { error: 'Missing default model' }
    return
  }
  try {
    const config = await readConfigYaml()
    if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
    config.model.default = defaultModel
    if (reqProvider) { config.model.provider = reqProvider }
    await writeConfigYaml(config)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
