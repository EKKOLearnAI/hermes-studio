import { readFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { getActiveEnvPath, getActiveAuthPath } from '../../services/hermes/hermes-profile'
import { readConfigYaml, updateConfigYaml, fetchProviderModels, buildModelGroups, PROVIDER_ENV_MAP } from '../../services/config-helpers'
import { buildProviderModelMap, PROVIDER_PRESETS } from '../../shared/providers'
import { getCopilotModelsDetailed, resolveCopilotOAuthToken, type CopilotModelMeta } from '../../services/hermes/copilot-models'
import { readAppConfig, writeAppConfig, type ModelVisibilityRule } from '../../services/app-config'
import { getDb } from '../../db'
import { MODEL_CONTEXT_TABLE } from '../../db/hermes/schemas'

const PROVIDER_MODEL_CATALOG = buildProviderModelMap()

type ModelMeta = { preview?: boolean; disabled?: boolean; alias?: string }
type AvailableGroup = { provider: string; label: string; base_url: string; models: string[]; api_key: string; builtin?: boolean; model_meta?: Record<string, ModelMeta>; available_models?: string[] }
type ModelVisibility = Record<string, ModelVisibilityRule>

const RESERVED_ALIAS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isSafeAliasKey(value: string): boolean {
  const trimmed = value.trim()
  return !!trimmed && trimmed.length <= 512 && !RESERVED_ALIAS_KEYS.has(trimmed)
}

function createAliasMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function createProviderAliasMap(): Record<string, Record<string, string>> {
  return Object.create(null) as Record<string, Record<string, string>>
}

function normalizeAliases(value: unknown): Record<string, Record<string, string>> {
  const normalized = createProviderAliasMap()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized
  for (const [provider, models] of Object.entries(value as Record<string, unknown>)) {
    if (!isSafeAliasKey(provider) || !models || typeof models !== 'object' || Array.isArray(models)) continue
    for (const [model, alias] of Object.entries(models as Record<string, unknown>)) {
      if (!isSafeAliasKey(model) || typeof alias !== 'string') continue
      const trimmed = alias.trim()
      if (!trimmed || trimmed.length > 512) continue
      if (!Object.hasOwn(normalized, provider)) normalized[provider] = createAliasMap()
      normalized[provider][model] = trimmed
    }
  }
  return normalized
}

function applyModelAliases<T extends { provider: string; models: string[]; model_meta?: Record<string, ModelMeta> }>(groups: T[], aliases: Record<string, Record<string, string>>): T[] {
  return groups.map((group) => {
    const providerAliases = aliases[group.provider]
    if (!providerAliases) return group
    const modelMeta: Record<string, ModelMeta> = { ...(group.model_meta || {}) }
    let changed = false
    for (const model of group.models) {
      const alias = providerAliases[model]
      if (!alias) continue
      modelMeta[model] = { ...(modelMeta[model] || {}), alias }
      changed = true
    }
    return changed ? { ...group, model_meta: modelMeta } : group
  })
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.map(v => String(v || '').trim()).filter(Boolean)))
}

function normalizeModelVisibility(input: unknown): ModelVisibility {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: ModelVisibility = {}
  for (const [provider, rawRule] of Object.entries(input as Record<string, unknown>)) {
    const providerKey = String(provider || '').trim()
    if (!providerKey || !rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue
    const rule = rawRule as { mode?: unknown; models?: unknown }
    const mode = rule.mode === 'include' ? 'include' : 'all'
    const models = uniqueStrings(rule.models)
    if (mode === 'include') {
      if (models.length > 0) out[providerKey] = { mode, models }
    } else {
      out[providerKey] = { mode: 'all', models: [] }
    }
  }
  return out
}

function filterModelsForProvider(provider: string, models: string[], visibility: ModelVisibility): string[] {
  const rule = visibility[provider]
  if (!rule || rule.mode !== 'include') return models
  const allowed = new Set(rule.models)
  const visible = models.filter(model => allowed.has(model))
  // If a stale hand-edited rule references models that are no longer present,
  // fail open so the provider remains recoverable from the Web UI.
  return visible.length > 0 ? visible : models
}

function applyModelVisibility(groups: AvailableGroup[], visibility: ModelVisibility): AvailableGroup[] {
  return groups
    .map(group => {
      const availableModels = group.available_models || group.models
      return {
        ...group,
        available_models: availableModels,
        models: filterModelsForProvider(group.provider, availableModels, visibility),
      }
    })
    .filter(group => group.models.length > 0)
}

function resolveVisibleDefault(defaultModel: string, defaultProvider: string, groups: AvailableGroup[]) {
  if (defaultModel) {
    const explicit = groups.find(group => group.provider === defaultProvider && group.models.includes(defaultModel))
    if (explicit) return { defaultModel, defaultProvider }
    const inferred = groups.find(group => group.models.includes(defaultModel))
    if (inferred) return { defaultModel, defaultProvider: inferred.provider }
  }
  const fallback = groups.find(group => group.models.length > 0)
  return { defaultModel: fallback?.models[0] || '', defaultProvider: fallback?.provider || '' }
}


// Copilot 授权检测：复用同一套 token 解析逻辑（含 ~/.config/github-copilot/apps.json
// 与 ghp_ PAT 跳过），与 getCopilotModels 行为一致，避免出现"模型能拉到却被判未授权"。
async function isCopilotAuthorized(envContent: string): Promise<boolean> {
  return !!(await resolveCopilotOAuthToken(envContent))
}

export async function getAvailable(ctx: any) {
  try {
    const config = await readConfigYaml()
    const modelSection = config.model
    let currentDefault = ''
    let currentDefaultProvider = ''
    if (typeof modelSection === 'object' && modelSection !== null) {
      currentDefault = String(modelSection.default || '').trim()
      currentDefaultProvider = String(modelSection.provider || '').trim()
      // When hermes CLI sets provider: custom, resolve to custom:name
      // by matching base_url + model against custom_providers
      if (currentDefaultProvider === 'custom' && currentDefault) {
        const cps = Array.isArray(config.custom_providers) ? config.custom_providers as any[] : []
        const match = cps.find(
          (cp: any) => cp.base_url?.replace(/\/+$/, '') === String(modelSection.base_url || '').replace(/\/+$/, '')
            && cp.model === currentDefault,
        )
        if (match) {
          currentDefaultProvider = `custom:${match.name.trim().toLowerCase().replace(/ /g, '-')}`
        }
      }
    } else if (typeof modelSection === 'string') {
      currentDefault = modelSection.trim()
    }

    const groups: AvailableGroup[] = []
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
    const addGroup = (provider: string, label: string, base_url: string, models: string[], api_key: string, builtin?: boolean, model_meta?: Record<string, ModelMeta>) => {
      if (seenProviders.has(provider)) return
      seenProviders.add(provider)
      const availableModels = [...models]
      groups.push({ provider, label, base_url, models: availableModels, available_models: availableModels, api_key, ...(builtin ? { builtin: true } : {}), ...(model_meta ? { model_meta } : {}) })
    }

    const isOAuthAuthorized = (providerKey: string): boolean => {
      try {
        const authPath = getActiveAuthPath()
        if (!existsSync(authPath)) return false
        const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
        const provider = auth.providers?.[providerKey]
        const pool = auth.credential_pool?.[providerKey]
        // Legacy OAuth providers are stored under providers.*; newer Hermes
        // credential pools store Codex-style OAuth entries under
        // credential_pool.*. Treat either shape as an authorized provider.
        return !!(
          provider?.tokens?.access_token ||
          provider?.access_token ||
          (Array.isArray(pool) && pool.some((entry: any) => entry?.access_token))
        )
      } catch { return false }
    }

    // 同一请求内复用 copilot 动态模型（getCopilotModelsDetailed 内部有 inflight + 缓存，
    // 这里再缓存到局部变量进一步减少分支）
    let copilotLiveModels: CopilotModelMeta[] | null = null
    const getCopilotLive = async (): Promise<CopilotModelMeta[]> => {
      if (copilotLiveModels !== null) return copilotLiveModels
      try { copilotLiveModels = await getCopilotModelsDetailed(envContent) }
      catch { copilotLiveModels = [] }
      return copilotLiveModels
    }

    // Copilot 显式 opt-in：即便能解析到 token，未通过 web-ui Add Provider 显式启用
    // 时也不返回。避免误把 VS Code/gh CLI 用户的全局凭证当作 hermes provider。
    const appConfig = await readAppConfig()
    const copilotEnabled = appConfig.copilotEnabled === true
    const modelAliases = normalizeAliases(appConfig.modelAliases)
    const modelVisibility = normalizeModelVisibility(appConfig.modelVisibility)

    // 兼容老用户：上一版本会"自动 fallback discovery"出 Copilot；升级后这些用户的
    // config.yaml 可能仍把 model.default 指向某个 copilot 模型。若此时 copilot 已不
    // 启用，把返回的 default 清掉，让前端兜底自动选剩余 provider 的第一个 model。
    if (!copilotEnabled && currentDefaultProvider.toLowerCase() === 'copilot') {
      currentDefault = ''
      currentDefaultProvider = ''
    }

    for (const [providerKey, envMapping] of Object.entries(PROVIDER_ENV_MAP)) {
      if (envMapping.api_key_env && !envHasValue(envMapping.api_key_env)) continue
      if (!envMapping.api_key_env) {
        if (providerKey === 'copilot') {
          if (!copilotEnabled) continue
          if (!(await isCopilotAuthorized(envContent))) continue
        } else if (!isOAuthAuthorized(providerKey)) {
          continue
        }
      }
      const preset = PROVIDER_PRESETS.find((p: any) => p.value === providerKey)
      const label = preset?.label || providerKey.replace(/^custom:/, '')
      let baseUrl = preset?.base_url || ''
      if (envMapping.base_url_env && envHasValue(envMapping.base_url_env)) {
        baseUrl = envGetValue(envMapping.base_url_env) || baseUrl
      }
      const catalogModels = PROVIDER_MODEL_CATALOG[providerKey]
      let modelsList: string[] = catalogModels && catalogModels.length > 0 ? [...catalogModels] : []
      let modelMeta: Record<string, ModelMeta> | undefined
      if (providerKey === 'copilot') {
        const live = await getCopilotLive()
        if (live.length > 0) {
          modelsList = live.map((m) => m.id)
          modelMeta = {}
          for (const m of live) {
            if (m.preview || m.disabled) {
              modelMeta[m.id] = {
                ...(m.preview ? { preview: true } : {}),
                ...(m.disabled ? { disabled: true } : {}),
              }
            }
          }
          if (Object.keys(modelMeta).length === 0) modelMeta = undefined
        }
      } else if (providerKey === 'openrouter' || providerKey === 'cliproxyapi' || providerKey === 'ollama-cloud') {
        // OpenRouter and local CLIProxyAPI expose dynamic OpenAI-compatible /models catalogs.
        if (envMapping.api_key_env) {
          const apiKey = envGetValue(envMapping.api_key_env)
          if (apiKey) {
            try {
              const fetched = await fetchProviderModels(baseUrl, apiKey, providerKey === 'openrouter')
              if (fetched.length > 0) modelsList = fetched
            } catch { /* ignore — leave empty, won't show */ }
          }
        }
      }
      if (modelsList.length > 0) {
        const apiKey = envMapping.api_key_env ? envGetValue(envMapping.api_key_env) : ''
        addGroup(providerKey, label, baseUrl, modelsList, apiKey, true, modelMeta)
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
        let models = [cp.model]
        if (cp.api_key) {
          try { const fetched = await fetchProviderModels(baseUrl, cp.api_key); if (fetched.length > 0) models = [...new Set([cp.model, ...fetched])] } catch { }
        }
        return { providerKey, label: cp.name, base_url: baseUrl, models, api_key: cp.api_key || '' }
      }),
    )

    for (const result of customFetches) {
      if (result.status === 'fulfilled' && result.value) {
        const { providerKey, label, base_url, models, api_key: cpApiKey, builtin: cpBuiltin } = result.value as any
        addGroup(providerKey, label, base_url, models, cpApiKey, cpBuiltin)
      }
    }

    for (const g of groups) { g.models = Array.from(new Set(g.models)) }
    const groupsWithAliases = applyModelAliases(groups, modelAliases)
    const visibleGroups = applyModelVisibility(groupsWithAliases, modelVisibility)
    const visibleDefault = resolveVisibleDefault(currentDefault, currentDefaultProvider, visibleGroups)

    // 动态拉一次 copilot 模型用于 allProviders 展示（同一请求复用缓存）
    // 未启用 Copilot 时跳过拉取，避免空跑网络请求。
    const liveCopilotModels = copilotEnabled ? await getCopilotLive() : []
    const liveCopilotIds = liveCopilotModels.map((m) => m.id)

    const allProvidersBase = PROVIDER_PRESETS.map((p: any) => ({
      provider: p.value,
      label: p.label,
      base_url: p.base_url,
      models: p.value === 'copilot' && liveCopilotIds.length > 0 ? liveCopilotIds : p.models,
    }))
    const allProviders = applyModelAliases(allProvidersBase, modelAliases)

    if (groups.length === 0) {
      const fallback = buildModelGroups(config)
      const fallbackGroups: AvailableGroup[] = fallback.groups.map(group => {
        const models = group.models.map(model => model.id)
        return {
          provider: group.provider,
          label: group.provider,
          base_url: '',
          models,
          available_models: models,
          api_key: '',
        }
      })
      const fallbackGroupsWithAliases = applyModelAliases(fallbackGroups, modelAliases)
      const visibleFallbackGroups = applyModelVisibility(fallbackGroupsWithAliases, modelVisibility)
      const fallbackDefault = resolveVisibleDefault(fallback.default, currentDefaultProvider, visibleFallbackGroups)
      ctx.body = {
        default: fallbackDefault.defaultModel,
        default_provider: fallbackDefault.defaultProvider,
        groups: visibleFallbackGroups,
        allProviders,
        model_aliases: modelAliases,
        model_visibility: modelVisibility,
      }
      return
    }

    ctx.body = {
      default: visibleDefault.defaultModel,
      default_provider: visibleDefault.defaultProvider,
      groups: visibleGroups,
      allProviders,
      model_aliases: modelAliases,
      model_visibility: modelVisibility,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function fetchProviderModelList(ctx: any) {
  try {
    const body = ctx.request.body as { base_url?: string; api_key?: string; freeOnly?: boolean }
    const baseUrl = String(body?.base_url || '').trim()
    const apiKey = String(body?.api_key || '').trim()
    const freeOnly = body?.freeOnly === true

    if (!baseUrl) {
      ctx.status = 400
      ctx.body = { error: 'Missing base_url' }
      return
    }

    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      ctx.status = 400
      ctx.body = { error: 'Invalid base_url' }
      return
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      ctx.status = 400
      ctx.body = { error: 'base_url must use http or https' }
      return
    }

    const base = baseUrl.replace(/\/+$/, '')
    const modelsUrl = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const res = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      ctx.status = 502
      ctx.body = { error: `Provider returned HTTP ${res.status}` }
      return
    }

    const data = await res.json() as { data?: Array<{ id?: unknown }> }
    if (!Array.isArray(data.data)) {
      ctx.status = 502
      ctx.body = { error: 'Provider returned unexpected format' }
      return
    }

    let models = data.data
      .map(m => String(m?.id || '').trim())
      .filter(Boolean)
    if (freeOnly) models = models.filter(m => m.endsWith(':free'))
    ctx.body = { models: Array.from(new Set(models)).sort() }
  } catch (err: any) {
    ctx.status = err?.name === 'TimeoutError' ? 504 : 502
    ctx.body = { error: err?.message || 'Failed to fetch provider models' }
  }
}


export async function setModelAlias(ctx: any) {
  const body = ctx.request.body
  const provider = body && typeof body === 'object' && !Array.isArray(body) ? body.provider : undefined
  const model = body && typeof body === 'object' && !Array.isArray(body) ? body.model : undefined
  const alias = body && typeof body === 'object' && !Array.isArray(body) ? body.alias : undefined

  if (typeof provider !== 'string' || typeof model !== 'string' || (alias !== undefined && typeof alias !== 'string')) {
    ctx.status = 400
    ctx.body = { error: 'Invalid provider, model, or alias' }
    return
  }

  const cleanProvider = provider.trim()
  const cleanModel = model.trim()
  const cleanAlias = (alias || '').trim()

  if (!isSafeAliasKey(cleanProvider) || !isSafeAliasKey(cleanModel)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid provider or model' }
    return
  }

  if (cleanAlias.length > 512) {
    ctx.status = 400
    ctx.body = { error: 'Alias is too long' }
    return
  }

  try {
    const appConfig = await readAppConfig()
    const modelAliases = normalizeAliases(appConfig.modelAliases)
    if (cleanAlias) {
      if (!Object.hasOwn(modelAliases, cleanProvider)) modelAliases[cleanProvider] = createAliasMap()
      modelAliases[cleanProvider][cleanModel] = cleanAlias
    } else {
      if (Object.hasOwn(modelAliases, cleanProvider)) delete modelAliases[cleanProvider][cleanModel]
      if (Object.hasOwn(modelAliases, cleanProvider) && Object.keys(modelAliases[cleanProvider]).length === 0) {
        delete modelAliases[cleanProvider]
      }
    }
    await writeAppConfig({ modelAliases })
    ctx.body = { success: true, model_aliases: modelAliases }
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
    await updateConfigYaml((config) => {
      config.model = {}
      config.model.default = defaultModel
      if (reqProvider) { config.model.provider = reqProvider }
      return config
    })
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/**
 * 设置模型上下文配置（UPSERT：存在则更新，不存在则插入）
 * 支持路径参数和查询参数两种方式
 */
export async function updateModelContext(ctx: any) {
  // 支持两种方式：
  // 1. 路径参数: /api/hermes/model-context/:provider/:model
  // 2. 查询参数: /api/hermes/model-context?provider=xxx&model=xxx
  let provider: string | undefined
  let model: string | undefined

  // 优先从路径参数获取
  if (ctx.params.provider && ctx.params.model) {
    provider = ctx.params.provider
    model = ctx.params.model
  } else {
    // 从查询参数获取
    const query = ctx.query as { provider?: string; model?: string }
    provider = query.provider
    model = query.model
  }

  // 如果没有参数，从请求体获取
  if (!provider || !model) {
    const body = ctx.request.body as { provider?: string; model?: string; context_limit?: number }
    provider = body.provider
    model = body.model
  }

  const { context_limit } = ctx.request.body as { context_limit: number }

  if (!provider || !model || !context_limit) {
    ctx.status = 400
    ctx.body = { error: 'Missing required fields: provider, model, context_limit' }
    return
  }

  if (typeof context_limit !== 'number' || context_limit <= 0) {
    ctx.status = 400
    ctx.body = { error: 'Context limit must be a positive number' }
    return
  }

  try {
    const db = getDb()
    if (!db) {
      ctx.status = 500
      ctx.body = { error: 'Database not available' }
      return
    }

    // 使用 REPLACE 实现 UPSERT：存在则替换，不存在则插入
    db.prepare(
      `REPLACE INTO ${MODEL_CONTEXT_TABLE} (provider, model, context_limit) VALUES (?, ?, ?)`
    ).run(provider, model, context_limit)

    // 查询并返回更新后的数据
    const row = db.prepare(
      `SELECT id, provider, model, context_limit FROM ${MODEL_CONTEXT_TABLE} WHERE provider = ? AND model = ?`
    ).get(provider, model) as { id: number; provider: string; model: string; context_limit: number }

    ctx.body = {
      success: true,
      data: row
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/**
 * 查询模型上下文配置
 */
export async function getModelContext(ctx: any) {
  // 支持两种方式：
  // 1. 路径参数: /api/hermes/model-context/:provider/:model
  // 2. 查询参数: /api/hermes/model-context?provider=xxx&model=xxx
  let provider: string | undefined
  let model: string | undefined

  // 优先从路径参数获取
  if (ctx.params.provider && ctx.params.model) {
    provider = ctx.params.provider
    model = ctx.params.model
  } else {
    // 从查询参数获取
    const query = ctx.query as { provider?: string; model?: string }
    provider = query.provider
    model = query.model
  }

  if (!provider || !model) {
    ctx.status = 400
    ctx.body = { error: 'Missing provider or model parameter' }
    return
  }

  try {
    const db = getDb()
    if (!db) {
      ctx.status = 500
      ctx.body = { error: 'Database not available' }
      return
    }

    const row = db.prepare(
      `SELECT id, provider, model, context_limit FROM ${MODEL_CONTEXT_TABLE} WHERE provider = ? AND model = ?`
    ).get(provider, model) as { id: number; provider: string; model: string; context_limit: number } | undefined

    if (!row) {
      ctx.status = 404
      ctx.body = { error: 'Model context not found' }
      return
    }

    ctx.body = { data: { ...row, limit: row.context_limit } }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}


export async function setModelVisibility(ctx: any) {
  const { provider, mode, models } = ctx.request.body as { provider?: string; mode?: string; models?: string[] }
  const providerKey = String(provider || '').trim()
  if (!providerKey) {
    ctx.status = 400
    ctx.body = { error: 'Missing provider' }
    return
  }
  if (mode !== 'all' && mode !== 'include') {
    ctx.status = 400
    ctx.body = { error: 'Invalid visibility mode' }
    return
  }
  const selectedModels = uniqueStrings(models)
  if (mode === 'include' && selectedModels.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'Select at least one model' }
    return
  }

  try {
    const appConfig = await readAppConfig()
    const modelVisibility = normalizeModelVisibility(appConfig.modelVisibility)
    if (mode === 'all') {
      delete modelVisibility[providerKey]
    } else {
      modelVisibility[providerKey] = { mode: 'include', models: selectedModels }
    }
    const saved = await writeAppConfig({ modelVisibility })
    ctx.body = { success: true, model_visibility: normalizeModelVisibility(saved.modelVisibility) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
