import { resolve, join } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync, statSync } from 'fs'

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
  limit?: ModelLimit
}

interface ProviderEntry {
  models?: Record<string, ModelEntry>
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

function getDefaultModel(profileDir: string): string | null {
  const configPath = join(profileDir, 'config.yaml')
  if (!existsSync(configPath)) return null
  try {
    const content = readFileSync(configPath, 'utf-8')
    const match = content.match(/^model:\s*\n\s+default:\s*(.+)$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

// --- Context lookup ---

function lookupContextFromCache(modelName: string): number | null {
  const data = loadModelsDevCache()
  if (!data) return null

  // Exact match first
  for (const prov of Object.values(data)) {
    const models = prov.models || {}
    const entry = models[modelName]
    if (entry?.limit?.context) return entry.limit.context
  }

  // Case-insensitive fallback
  const lower = modelName.toLowerCase()
  for (const prov of Object.values(data)) {
    const models = prov.models || {}
    for (const [name, entry] of Object.entries(models)) {
      if (name.toLowerCase() === lower && entry?.limit?.context) {
        return entry.limit.context
      }
    }
  }
  return null
}

/**
 * Get the context length for the current profile's default model.
 * Results are cached in memory (5min TTL) and invalidated by file mtime.
 */
export function getModelContextLength(profile?: string): number {
  const profileDir = getProfileDir(profile)
  const model = getDefaultModel(profileDir)
  if (!model) return DEFAULT_CONTEXT_LENGTH

  return lookupContextFromCache(model) || DEFAULT_CONTEXT_LENGTH
}
