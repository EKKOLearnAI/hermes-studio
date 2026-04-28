import { resolve, join } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync, statSync } from 'fs'
import yaml from 'js-yaml'

const HERMES_BASE = resolve(homedir(), '.hermes')
const MODELS_DEV_CACHE = resolve(HERMES_BASE, 'models_dev_cache.json')
const DEFAULT_CONTEXT_LENGTH = 200_000

interface ModelLimit {
  context?: number
  output?: number
  input?: number
}

interface ModelEntry {
  id?: string
  name?: string
  limit?: ModelLimit
}

interface ProviderEntry {
  models?: Record<string, ModelEntry>
}

const MODEL_CACHE_PROVIDER_ALIASES: Record<string, string[]> = {
  gemini: ['google'],
  moonshot: ['moonshotai'],
  kilocode: ['kilo'],
  'ai-gateway': ['vercel'],
  'opencode-zen': ['opencode'],
  'opencode-go': ['opencode'],
  'glm-coding-plan': ['zai-coding-plan'],
  'kimi-coding': ['kimi-for-coding'],
  'kimi-coding-cn': ['kimi-for-coding'],
}

// --- Config YAML helpers (js-yaml) ---

function loadConfig(profileDir: string): any | null {
  const configPath = join(profileDir, 'config.yaml')
  if (!existsSync(configPath)) return null
  try {
    return yaml.load(readFileSync(configPath, 'utf-8')) as any
  } catch {
    return null
  }
}

// --- In-memory cache: parsed models_dev_cache (1.7MB), invalidated by mtime ---

let _cache: Record<string, ProviderEntry> | null = null
let _cacheMtime = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
let _cacheLoadedAt = 0

function loadModelsDevCache(): Record<string, ProviderEntry> | null {
  if (!existsSync(MODELS_DEV_CACHE)) return null
  try {
    const stat = statSync(MODELS_DEV_CACHE)
    const now = Date.now()
    // Return cached if file hasn't changed and within TTL
    if (_cache && stat.mtimeMs === _cacheMtime && now - _cacheLoadedAt < CACHE_TTL_MS) {
      return _cache
    }
    const raw = readFileSync(MODELS_DEV_CACHE, 'utf-8')
    _cache = JSON.parse(raw) as Record<string, ProviderEntry>
    _cacheMtime = stat.mtimeMs
    _cacheLoadedAt = now
    return _cache
  } catch {
    return _cache // return stale cache on error
  }
}

// --- Profile helpers ---

function getProfileDir(profile?: string): string {
  if (!profile || profile === 'default') return HERMES_BASE
  const dir = join(HERMES_BASE, 'profiles', profile)
  return existsSync(dir) ? dir : HERMES_BASE
}

function getDefaultModel(config: any): string | null {
  const model = config?.model
  if (!model || typeof model !== 'object') return null
  return typeof model.default === 'string' ? model.default.trim() || null : null
}

function getDefaultProvider(config: any): string | null {
  const model = config?.model
  if (!model || typeof model !== 'object') return null
  return typeof model.provider === 'string' ? model.provider.trim() || null : null
}

/**
 * Read context_length from config.yaml, only as a sibling of default.
 * e.g. model:\n  default: gpt-5.4\n  context_length: 200000
 */
function getConfigContextLength(config: any): number | null {
  const model = config?.model
  if (!model || typeof model !== 'object') return null
  const val = model.context_length
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null
  return val
}

/**
 * Lookup context_length from custom_providers in config.yaml.
 * - "custom:xxx" → strip prefix, match by name
 * - "custom" → match by model name
 */
function lookupCustomProviderContextLength(config: any, modelName: string, provider: string | null): number | null {
  const providers: any[] = Array.isArray(config?.custom_providers) ? config.custom_providers : []
  if (!provider || !provider.startsWith('custom')) return null

  let matched: any = null

  if (provider === 'custom') {
    matched = providers.find((cp: any) => cp.model === modelName)
  } else {
    const suffix = provider.slice('custom:'.length)
    matched = providers.find((cp: any) => cp.name === suffix)
  }

  if (!matched) return null

  const models = matched.models
  if (!models || typeof models !== 'object') return null

  const modelEntry = models[modelName]
  if (!modelEntry || typeof modelEntry !== 'object') return null

  const val = modelEntry.context_length
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null
  return val
}

// --- Context lookup ---

function getCachedContext(entry: ModelEntry | undefined): number | null {
  const context = entry?.limit?.context
  return typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : null
}

function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase()
}

function getProviderCandidates(provider: string): string[] {
  const normalized = normalizeProviderKey(provider)
  return [normalized, ...(MODEL_CACHE_PROVIDER_ALIASES[normalized] || [])]
}

function getProviderEntry(data: Record<string, ProviderEntry>, provider: string): ProviderEntry | null {
  const candidates = getProviderCandidates(provider)

  for (const candidate of candidates) {
    const exact = data[candidate]
    if (exact) return exact
  }

  const entries = Object.entries(data)
  for (const candidate of candidates) {
    const match = entries.find(([name]) => name.toLowerCase() === candidate)
    if (match) return match[1]
  }

  return null
}

function findModelEntry(models: Record<string, ModelEntry>, modelName: string): ModelEntry | undefined {
  const exact = models[modelName]
  if (exact) return exact

  const lower = modelName.toLowerCase()
  for (const [name, entry] of Object.entries(models)) {
    if (name.toLowerCase() === lower) return entry
    if (entry.id?.toLowerCase() === lower) return entry
    if (entry.name?.toLowerCase() === lower) return entry
  }

  const suffix = `/${lower}`
  for (const [name, entry] of Object.entries(models)) {
    if (name.toLowerCase().endsWith(suffix)) return entry
    if (entry.id?.toLowerCase().endsWith(suffix)) return entry
  }

  return undefined
}

function lookupContextInProvider(provider: ProviderEntry | null, modelName: string): number | null {
  const models = provider?.models || {}
  return getCachedContext(findModelEntry(models, modelName))
}

function lookupContextGloballyByModelName(data: Record<string, ProviderEntry>, modelName: string): number | null {
  for (const prov of Object.values(data)) {
    const context = getCachedContext(prov.models?.[modelName])
    if (context) return context
  }

  const lower = modelName.toLowerCase()
  for (const prov of Object.values(data)) {
    const models = prov.models || {}
    for (const [name, entry] of Object.entries(models)) {
      if (name.toLowerCase() === lower) {
        const context = getCachedContext(entry)
        if (context) return context
      }
    }
  }

  return null
}

function lookupContextFromCache(modelName: string, provider: string | null): number | null {
  const data = loadModelsDevCache()
  if (!data) return null

  if (provider) {
    return lookupContextInProvider(getProviderEntry(data, provider), modelName)
  }

  // Legacy configs may omit model.provider; preserve the old global exact/CI lookup semantics.
  return lookupContextGloballyByModelName(data, modelName)
}

/**
 * Get the context length for the current profile's default model.
 * Resolution order:
 *   1. config.yaml model.context_length (highest priority, user override)
 *   2. custom_providers models.<model>.context_length
 *   3. models_dev_cache.json, scoped to model.provider when configured
 *   4. DEFAULT_CONTEXT_LENGTH (200K hardcoded fallback)
 */
export function getModelContextLength(profile?: string): number {
  const profileDir = getProfileDir(profile)
  const config = loadConfig(profileDir)
  if (!config) return DEFAULT_CONTEXT_LENGTH

  const model = getDefaultModel(config)
  if (!model) return DEFAULT_CONTEXT_LENGTH

  // 1. Global context_length override in config.yaml
  const configCtx = getConfigContextLength(config)
  if (configCtx && configCtx > 0) return configCtx

  // 2. Custom provider context_length
  const provider = getDefaultProvider(config)
  const customCtx = lookupCustomProviderContextLength(config, model, provider)
  if (customCtx && customCtx > 0) return customCtx

  // 3. models_dev_cache.json
  const cached = lookupContextFromCache(model, provider)
  if (cached) return cached

  // 4. Fallback
  return DEFAULT_CONTEXT_LENGTH
}
