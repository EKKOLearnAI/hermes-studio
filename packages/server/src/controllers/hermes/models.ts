import { readFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { getActiveEnvPath, getActiveAuthPath } from '../../services/hermes/hermes-profile'
import { readConfigYaml, writeConfigYaml, fetchProviderModels, buildModelGroups, PROVIDER_ENV_MAP } from '../../services/config-helpers'
import { buildProviderModelMap, PROVIDER_PRESETS } from '../../shared/providers'
import { getCopilotModelsDetailed, resolveCopilotOAuthToken, type CopilotModelMeta } from '../../services/hermes/copilot-models'
import { readAppConfig } from '../../services/app-config'
import { getDb } from '../../db'
import { MODEL_CONTEXT_TABLE } from '../../db/hermes/schemas'

const PROVIDER_MODEL_CATALOG = buildProviderModelMap()

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

    const groups: Array<{ provider: string; label: string; base_url: string; models: string[]; api_key: string; builtin?: boolean; model_meta?: Record<string, { preview?: boolean; disabled?: boolean }> }> = []
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
    const addGroup = (provider: string, label: string, base_url: string, models: string[], api_key: string, builtin?: boolean, model_meta?: Record<string, { preview?: boolean; disabled?: boolean }>) => {
      if (seenProviders.has(provider)) return
      seenProviders.add(provider)
      groups.push({ provider, label, base_url, models: [...models], api_key, ...(builtin ? { builtin: true } : {}), ...(model_meta ? { model_meta } : {}) })
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
      let modelMeta: Record<string, { preview?: boolean; disabled?: boolean }> | undefined
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
      } else if (providerKey === 'openrouter' || providerKey === 'cliproxyapi') {
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
        const bareKey = cp.name.trim().toLowerCase().replace(/ /g, '-')
        const builtinPreset = PROVIDER_PRESETS.find(p => p.value === bareKey)
        let models = builtinPreset?.models?.length ? [...builtinPreset.models] : [cp.model]
        // Skip dynamic fetch for builtin presets — their model list is maintained in providers.ts
        if (!builtinPreset && cp.api_key) {
          try { const fetched = await fetchProviderModels(baseUrl, cp.api_key); if (fetched.length > 0) models = [...new Set([cp.model, ...fetched])] } catch { }
        }
        const label = builtinPreset?.label || cp.name
        const presetBaseUrl = builtinPreset?.base_url || ''
        return { providerKey, label, base_url: presetBaseUrl || baseUrl, models, api_key: cp.api_key || '', builtin: !!builtinPreset }
      }),
    )

    for (const result of customFetches) {
      if (result.status === 'fulfilled' && result.value) {
        const { providerKey, label, base_url, models, api_key: cpApiKey, builtin: cpBuiltin } = result.value as any
        addGroup(providerKey, label, base_url, models, cpApiKey, cpBuiltin)
      }
    }

    for (const g of groups) { g.models = Array.from(new Set(g.models)) }

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

    if (groups.length === 0) {
      const fallback = buildModelGroups(config)
      ctx.body = { ...fallback, allProviders: allProvidersBase }
      return
    }

    ctx.body = { default: currentDefault, default_provider: currentDefaultProvider, groups, allProviders: allProvidersBase }
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
    config.model = {}
    config.model.default = defaultModel
    if (reqProvider) { config.model.provider = reqProvider }
    await writeConfigYaml(config)
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
