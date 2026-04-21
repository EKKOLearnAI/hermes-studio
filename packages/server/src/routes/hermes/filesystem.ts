import Router from '@koa/router'
import { readdir, readFile, stat, writeFile, mkdir, copyFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import YAML from 'js-yaml'
import { getActiveProfileDir, getActiveConfigPath, getActiveEnvPath, getActiveAuthPath } from '../../services/hermes/hermes-profile'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { logger } from '../../services/logger'

// --- Provider env var mapping (from hermes providers.py HERMES_OVERLAYS + config.py) ---
// Maps provider key → { api_key_envs: all env var aliases for API key, base_url_env: env var for base URL }
const PROVIDER_ENV_MAP: Record<string, { api_key_env: string; base_url_env: string }> = {
  openrouter: { api_key_env: 'OPENROUTER_API_KEY', base_url_env: '' },
  zai: { api_key_env: 'GLM_API_KEY', base_url_env: '' },
  'kimi-coding-cn': { api_key_env: 'KIMI_CN_API_KEY', base_url_env: '' },
  moonshot: { api_key_env: 'MOONSHOT_API_KEY', base_url_env: '' },
  minimax: { api_key_env: 'MINIMAX_API_KEY', base_url_env: '' },
  'minimax-cn': { api_key_env: 'MINIMAX_CN_API_KEY', base_url_env: '' },
  deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: '' },
  alibaba: { api_key_env: 'DASHSCOPE_API_KEY', base_url_env: '' },
  anthropic: { api_key_env: 'ANTHROPIC_API_KEY', base_url_env: '' },
  xai: { api_key_env: 'XAI_API_KEY', base_url_env: '' },
  xiaomi: { api_key_env: 'XIAOMI_API_KEY', base_url_env: '' },
  gemini: { api_key_env: 'GEMINI_API_KEY', base_url_env: '' },
  kilocode: { api_key_env: 'KILO_API_KEY', base_url_env: '' },
  'ai-gateway': { api_key_env: 'AI_GATEWAY_API_KEY', base_url_env: '' },
  'opencode-zen': { api_key_env: 'OPENCODE_API_KEY', base_url_env: '' },
  'opencode-go': { api_key_env: 'OPENCODE_API_KEY', base_url_env: '' },
  huggingface: { api_key_env: 'HF_TOKEN', base_url_env: '' },
  arcee: { api_key_env: 'ARCEE_API_KEY', base_url_env: '' },
  'openai-codex': { api_key_env: '', base_url_env: '' },
}

async function saveEnvValue(key: string, value: string): Promise<void> {
  const envPath = getActiveEnvPath()
  let raw: string
  try {
    raw = await readFile(envPath, 'utf-8')
  } catch {
    raw = ''
  }
  const remove = !value
  const lines = raw.split('\n')
  let found = false
  const result: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') && trimmed.startsWith(`# ${key}=`)) {
      if (!remove) result.push(`${key}=${value}`)
      found = true
    } else {
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx !== -1 && trimmed.slice(0, eqIdx).trim() === key) {
        if (!remove) result.push(`${key}=${value}`)
        found = true
      } else {
        result.push(line)
      }
    }
  }
  if (!found && !remove) {
    result.push(`${key}=${value}`)
  }
  let output = result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n'
  await writeFile(envPath, output, 'utf-8')
}

// --- Auth / Credential Pool ---

async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models'
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      logger.warn('available-models %s returned %d', baseUrl, res.status)
      return []
    }
    const data = await res.json() as { data?: Array<{ id: string }> }
    if (!Array.isArray(data.data)) {
      logger.warn('available-models %s returned unexpected format', baseUrl)
      return []
    }
    return data.data.map(m => m.id).sort()
  } catch (err: any) {
    logger.error(err, 'available-models %s failed', baseUrl)
    return []
  }
}

// --- Hardcoded model catalogs (single source: src/shared/providers.ts) ---
import { buildProviderModelMap } from '../../shared/providers'
const PROVIDER_MODEL_CATALOG = buildProviderModelMap()

export const fsRoutes = new Router()

const hermesDir = () => getActiveProfileDir()

// --- Types ---

interface SkillInfo {
  name: string
  description: string
  enabled: boolean
}

interface SkillCategory {
  name: string
  description: string
  skills: SkillInfo[]
}

// --- Helpers ---

function extractDescription(content: string): string {
  const lines = content.split('\n')
  let inFrontmatter = false
  let bodyStarted = false

  for (const line of lines) {
    if (!bodyStarted && line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      } else {
        inFrontmatter = false
        bodyStarted = true
        continue
      }
    }
    if (inFrontmatter) continue
    if (line.trim() === '') continue
    if (line.startsWith('#')) continue
    return line.trim().slice(0, 80)
  }
  return ''
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function safeStat(filePath: string): Promise<{ mtime: number } | null> {
  try {
    const s = await stat(filePath)
    return { mtime: Math.round(s.mtimeMs) }
  } catch {
    return null
  }
}

// --- Config YAML helpers ---

const configPath = () => getActiveConfigPath()

async function readConfigYaml(): Promise<Record<string, any>> {
  const raw = await safeReadFile(configPath())
  if (!raw) return {}
  return (YAML.load(raw) as Record<string, any>) || {}
}

async function writeConfigYaml(config: Record<string, any>): Promise<void> {
  const cp = configPath()
  await copyFile(cp, cp + '.bak')
  const yamlStr = YAML.dump(config, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  })
  await writeFile(cp, yamlStr, 'utf-8')
}

// --- Skills Routes ---

// List all skills grouped by category
fsRoutes.get('/api/hermes/skills', async (ctx) => {
  const skillsDir = join(hermesDir(), 'skills')

  try {
    // Read disabled skills list from config.yaml
    const config = await readConfigYaml()
    const disabledList: string[] = config.skills?.disabled || []

    const entries = await readdir(skillsDir, { withFileTypes: true })
    const categories: SkillCategory[] = []

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue

      const catDir = join(skillsDir, entry.name)
      const catDesc = await safeReadFile(join(catDir, 'DESCRIPTION.md'))
      const catDescription = catDesc ? catDesc.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) : ''

      const skillEntries = await readdir(catDir, { withFileTypes: true })
      const skills: SkillInfo[] = []

      for (const se of skillEntries) {
        if (!se.isDirectory()) continue
        const skillMd = await safeReadFile(join(catDir, se.name, 'SKILL.md'))
        if (skillMd) {
          skills.push({
            name: se.name,
            description: extractDescription(skillMd),
            enabled: !disabledList.includes(se.name),
          })
        }
      }

      if (skills.length > 0) {
        categories.push({ name: entry.name, description: catDescription, skills })
      }
    }

    categories.sort((a, b) => a.name.localeCompare(b.name))
    for (const cat of categories) {
      cat.skills.sort((a, b) => a.name.localeCompare(b.name))
    }

    ctx.body = { categories }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skills directory: ${err.message}` }
  }
})

// Toggle skill enabled/disabled via config.yaml skills.disabled
fsRoutes.put('/api/hermes/skills/toggle', async (ctx) => {
  const { name, enabled } = ctx.request.body as { name?: string; enabled?: boolean }

  if (!name || typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or enabled flag' }
    return
  }

  try {
    const config = await readConfigYaml()
    if (!config.skills) config.skills = {}
    if (!Array.isArray(config.skills.disabled)) config.skills.disabled = []

    const disabled = config.skills.disabled as string[]
    const idx = disabled.indexOf(name)

    if (enabled) {
      // Enable: remove from disabled list
      if (idx !== -1) disabled.splice(idx, 1)
    } else {
      // Disable: add to disabled list
      if (idx === -1) disabled.push(name)
    }

    await writeConfigYaml(config)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// List files in a skill directory
async function listFilesRecursive(dir: string, prefix: string): Promise<{ path: string; name: string }[]> {
  const result: { path: string; name: string }[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push(...await listFilesRecursive(join(dir, entry.name), relPath))
    } else {
      result.push({ path: relPath, name: entry.name })
    }
  }
  return result
}

fsRoutes.get('/api/hermes/skills/:category/:skill/files', async (ctx) => {
  const { category, skill } = ctx.params
  const skillDir = join(hermesDir(), 'skills', category, skill)

  try {
    const allFiles = await listFilesRecursive(skillDir, '')
    const files = allFiles.filter(f => f.path !== 'SKILL.md')
    ctx.body = { files }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// Read a specific file under skills/ (must be registered after the /files route)
fsRoutes.get('/api/hermes/skills/{*path}', async (ctx) => {
  const filePath = (ctx.params as any).path
  const hd = hermesDir()
  const fullPath = resolve(join(hd, 'skills', filePath))

  if (!fullPath.startsWith(join(hd, 'skills'))) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  const content = await safeReadFile(fullPath)
  if (content === null) {
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }

  ctx.body = { content }
})

// --- Memory Routes ---

fsRoutes.get('/api/hermes/memory', async (ctx) => {
  const hd = hermesDir()
  const memoryPath = join(hd, 'memories', 'MEMORY.md')
  const userPath = join(hd, 'memories', 'USER.md')
  const soulPath = join(hd, 'SOUL.md')

  const [memory, user, soul, memoryStat, userStat, soulStat] = await Promise.all([
    safeReadFile(memoryPath),
    safeReadFile(userPath),
    safeReadFile(soulPath),
    safeStat(memoryPath),
    safeStat(userPath),
    safeStat(soulPath),
  ])

  ctx.body = {
    memory: memory || '',
    user: user || '',
    soul: soul || '',
    memory_mtime: memoryStat?.mtime || null,
    user_mtime: userStat?.mtime || null,
    soul_mtime: soulStat?.mtime || null,
  }
})

fsRoutes.post('/api/hermes/memory', async (ctx) => {
  const { section, content } = ctx.request.body as { section: string; content: string }

  if (!section || !content) {
    ctx.status = 400
    ctx.body = { error: 'Missing section or content' }
    return
  }

  if (section !== 'memory' && section !== 'user' && section !== 'soul') {
    ctx.status = 400
    ctx.body = { error: 'Section must be "memory", "user", or "soul"' }
    return
  }

  let filePath: string
  if (section === 'soul') {
    filePath = join(hermesDir(), 'SOUL.md')
  } else {
    const fileName = section === 'memory' ? 'MEMORY.md' : 'USER.md'
    filePath = join(hermesDir(), 'memories', fileName)
  }

  try {
    await writeFile(filePath, content, 'utf-8')
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// --- Config Model Routes ---

interface ModelInfo {
  id: string
  label: string
}

interface ModelGroup {
  provider: string
  models: ModelInfo[]
}

// Build model list from user's actual config.yaml using js-yaml
function buildModelGroups(config: Record<string, any>): { default: string; groups: ModelGroup[] } {
  let defaultModel = ''
  const groups: ModelGroup[] = []
  const allModelIds = new Set<string>()

  // 1. Extract current model
  const modelSection = config.model
  if (typeof modelSection === 'object' && modelSection !== null) {
    defaultModel = String(modelSection.default || '').trim()
  } else if (typeof modelSection === 'string') {
    defaultModel = modelSection.trim()
  }

  // 2. Extract custom_providers section
  const customProviders = config.custom_providers
  if (Array.isArray(customProviders)) {
    const customModels: ModelInfo[] = []
    for (const entry of customProviders) {
      if (entry && typeof entry === 'object') {
        const cName = String(entry.name || '').trim()
        const cModel = String(entry.model || '').trim()
        if (cName && cModel) {
          customModels.push({ id: cModel, label: `${cName}: ${cModel}` })
          allModelIds.add(cModel)
        }
      }
    }
    if (customModels.length > 0) {
      groups.push({ provider: 'Custom', models: customModels })
    }
  }

  return { default: defaultModel, groups }
}

// GET /api/available-models — resolve models from .env authorized providers + credential pool + custom providers
fsRoutes.get('/api/hermes/available-models', async (ctx) => {
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

    // 1. Read .env to discover authorized providers via PROVIDER_ENV_MAP
    let envContent = ''
    try {
      envContent = await readFile(getActiveEnvPath(), 'utf-8')
    } catch { }

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

    // Import PROVIDER_PRESETS for label + base_url lookup
    const { PROVIDER_PRESETS } = await import('../../shared/providers')

    // 1. Authorized providers from .env + OAuth-based providers (no api_key_env)
    // Check OAuth auth (e.g. openai-codex) via auth.json
    const isOAuthAuthorized = (providerKey: string): boolean => {
      try {
        const authPath = getActiveAuthPath()
        if (!existsSync(authPath)) return false
        const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
        return !!auth.providers?.[providerKey]?.tokens?.access_token
      } catch {
        return false
      }
    }

    for (const [providerKey, envMapping] of Object.entries(PROVIDER_ENV_MAP)) {
      // Skip providers that require API key but don't have one configured
      if (envMapping.api_key_env && !envHasValue(envMapping.api_key_env)) continue
      // Skip OAuth providers that haven't been authenticated
      if (!envMapping.api_key_env && !isOAuthAuthorized(providerKey)) continue
      const preset = PROVIDER_PRESETS.find(p => p.value === providerKey)
      const label = preset?.label || providerKey.replace(/^custom:/, '')
      const baseUrl = preset?.base_url || ''
      const catalogModels = PROVIDER_MODEL_CATALOG[providerKey]
      if (catalogModels && catalogModels.length > 0) {
        const apiKey = envMapping.api_key_env ? envGetValue(envMapping.api_key_env) : ''
        addGroup(providerKey, label, baseUrl, catalogModels, apiKey)
      }
    }

    // 2. Custom providers from config.yaml — dynamically fetch models
    const customProviders = Array.isArray(config.custom_providers)
      ? config.custom_providers as Array<{ name: string; base_url: string; model: string; api_key?: string }>
      : []

    const customFetches = await Promise.allSettled(
      customProviders.map(async cp => {
        if (!cp.base_url) return null
        const providerKey = `custom:${cp.name.trim().toLowerCase().replace(/ /g, '-')}`
        const baseUrl = cp.base_url.replace(/\/+$/, '')
        let models = [cp.model] // always include the statically configured model
        if (cp.api_key) {
          try {
            const fetched = await fetchProviderModels(baseUrl, cp.api_key)
            if (fetched.length > 0) models = fetched
          } catch { }
        }
        return { providerKey, label: cp.name, base_url: baseUrl, models, api_key: cp.api_key || '' }
      }),
    )

    for (const result of customFetches) {
      if (result.status === 'fulfilled' && result.value) {
        const { providerKey, label, base_url, models, api_key: cpApiKey } = result.value
        const existing = groups.find(g => g.base_url.replace(/\/+$/, '') === base_url)
        if (existing) {
          for (const m of models) {
            if (!existing.models.includes(m)) existing.models.push(m)
          }
        } else {
          addGroup(providerKey, label, base_url, models, cpApiKey)
        }
      }
    }

    // Deduplicate models within each group
    for (const g of groups) {
      g.models = Array.from(new Set(g.models))
    }

    // Fallback: if still no providers, fall back to config.yaml parsing
    if (groups.length === 0) {
      const fallback = buildModelGroups(config)
      const allProviders = PROVIDER_PRESETS.map(p => ({
        provider: p.value,
        label: p.label,
        base_url: p.base_url,
        models: p.models,
      }))
      ctx.body = { ...fallback, allProviders }
      return
    }

    const allProviders = PROVIDER_PRESETS.map(p => ({
      provider: p.value,
      label: p.label,
      base_url: p.base_url,
      models: p.models,
    }))

    ctx.body = { default: currentDefault, default_provider: currentDefaultProvider, groups, allProviders }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// GET /api/config/models
fsRoutes.get('/api/hermes/config/models', async (ctx) => {
  try {
    const config = await readConfigYaml()
    ctx.body = buildModelGroups(config)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// PUT /api/config/model
fsRoutes.put('/api/hermes/config/model', async (ctx) => {
  const { default: defaultModel, provider: reqProvider } = ctx.request.body as {
    default: string
    provider?: string
  }

  if (!defaultModel) {
    ctx.status = 400
    ctx.body = { error: 'Missing default model' }
    return
  }

  try {
    const config = await readConfigYaml()

    if (typeof config.model !== 'object' || config.model === null) {
      config.model = {}
    }

    config.model.default = defaultModel
    if (reqProvider) {
      config.model.provider = reqProvider
    }

    await writeConfigYaml(config)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/config/providers
fsRoutes.post('/api/hermes/config/providers', async (ctx) => {
  const { name, base_url, api_key, model, providerKey } = ctx.request.body as {
    name: string
    base_url: string
    api_key: string
    model: string
    providerKey?: string | null
  }

  if (!name || !base_url || !model) {
    ctx.status = 400
    ctx.body = { error: 'Missing name, base_url, or model' }
    return
  }

  if (!api_key) {
    ctx.status = 400
    ctx.body = { error: 'Missing API key' }
    return
  }

  try {
    // Determine if this is a built-in provider or a custom one
    const poolKey = providerKey
      || `custom:${name.trim().toLowerCase().replace(/ /g, '-')}`
    const isBuiltin = poolKey in PROVIDER_ENV_MAP

    if (!isBuiltin) {
      // Custom provider: write to config.yaml custom_providers
      const config = await readConfigYaml()
      if (!Array.isArray(config.custom_providers)) {
        config.custom_providers = []
      }
      config.custom_providers.push({ name, base_url, api_key, model })
      await writeConfigYaml(config)
    }

    // Write API key to .env (built-in providers only)
    const envMapping = PROVIDER_ENV_MAP[poolKey] || PROVIDER_ENV_MAP[providerKey || '']
    if (envMapping) {
      await saveEnvValue(envMapping.api_key_env, api_key)
      if (envMapping.base_url_env) {
        await saveEnvValue(envMapping.base_url_env, base_url)
      }
    }

    // Auto-switch model to the newly added provider
    const config2 = await readConfigYaml()
    if (typeof config2.model !== 'object' || config2.model === null) {
      config2.model = {}
    }
    config2.model.default = model
    config2.model.provider = poolKey
    await writeConfigYaml(config2)

    // Restart gateway to pick up .env and config.yaml changes
    try {
      await hermesCli.restartGateway()
    } catch (e: any) {
      logger.error(e, 'Gateway restart failed')
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// PUT /api/config/providers/:poolKey — update existing provider
fsRoutes.put('/api/hermes/config/providers/:poolKey', async (ctx) => {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  const { name, base_url, api_key, model } = ctx.request.body as {
    name?: string
    base_url?: string
    api_key?: string
    model?: string
  }

  try {
    const isCustom = poolKey.startsWith('custom:')

    if (isCustom) {
      // Update custom provider in config.yaml
      const config = await readConfigYaml()
      if (!Array.isArray(config.custom_providers)) {
        ctx.status = 404
        ctx.body = { error: `Custom provider "${poolKey}" not found` }
        return
      }
      const entry = (config.custom_providers as any[]).find((e: any) => {
        const key = `custom:${e.name.trim().toLowerCase().replace(/ /g, '-')}`
        return key === poolKey
      })
      if (!entry) {
        ctx.status = 404
        ctx.body = { error: `Custom provider "${poolKey}" not found` }
        return
      }
      if (name !== undefined) entry.name = name
      if (base_url !== undefined) entry.base_url = base_url
      if (api_key !== undefined) entry.api_key = api_key
      if (model !== undefined) entry.model = model
      await writeConfigYaml(config)
    } else {
      // Built-in provider: update API key in .env
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping?.api_key_env) {
        // OAuth provider — cannot update key
        ctx.status = 400
        ctx.body = { error: `Cannot update credentials for "${poolKey}"` }
        return
      }
      if (api_key !== undefined) {
        await saveEnvValue(envMapping.api_key_env, api_key)
      }
    }

    // Restart gateway to pick up changes
    try {
      await hermesCli.restartGateway()
    } catch (e: any) {
      logger.error(e, 'Gateway restart failed')
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// DELETE /api/config/providers/:poolKey
fsRoutes.delete('/api/hermes/config/providers/:poolKey', async (ctx) => {
  const poolKey = decodeURIComponent(ctx.params.poolKey)

  try {
    const config = await readConfigYaml()
    const isCustom = poolKey.startsWith('custom:')

    if (isCustom) {
      // Delete from config.yaml custom_providers
      const idx = Array.isArray(config.custom_providers)
        ? (config.custom_providers as any[]).findIndex((e: any) => {
          const key = `custom:${e.name.trim().toLowerCase().replace(/ /g, '-')}`
          return key === poolKey
        })
        : -1
      if (idx === -1) {
        ctx.status = 404
        ctx.body = { error: `Custom provider "${poolKey}" not found` }
        return
      }
      (config.custom_providers as any[]).splice(idx, 1)
      await writeConfigYaml(config)
    } else {
      // Built-in provider: remove API key from .env
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (envMapping?.api_key_env) {
        await saveEnvValue(envMapping.api_key_env, '')
      } else if (!envMapping?.api_key_env) {
        // OAuth provider (e.g. openai-codex): clear tokens from auth.json
        try {
          const authPath = getActiveAuthPath()
          if (existsSync(authPath)) {
            const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
            if (auth.providers?.[poolKey]) {
              delete auth.providers[poolKey]
            }
            if (auth.credential_pool?.[poolKey]) {
              delete auth.credential_pool[poolKey]
            }
            const { writeFile: wfs } = await import('fs/promises')
            await wfs(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
          }
        } catch (err: any) {
          logger.error(err, 'Failed to clear OAuth tokens for %s', poolKey)
        }
      }
    }

    // If was the current provider, switch to first remaining
    const currentProvider = config.model?.provider
    const isCurrent = currentProvider === poolKey
    if (isCurrent) {
      // Find fallback from .env authorized providers or remaining custom_providers
      const freshConfig = await readConfigYaml()
      const remaining = Array.isArray(freshConfig.custom_providers) ? freshConfig.custom_providers as any[] : []
      const fallbackCp = remaining[0]
      if (fallbackCp) {
        const fallbackKey = `custom:${fallbackCp.name.trim().toLowerCase().replace(/ /g, '-')}`
        if (typeof freshConfig.model !== 'object' || freshConfig.model === null) {
          freshConfig.model = {}
        }
        freshConfig.model.default = fallbackCp.model
        freshConfig.model.provider = fallbackKey
        await writeConfigYaml(freshConfig)
      }
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})
