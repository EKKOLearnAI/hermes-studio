import { readFile, writeFile, copyFile, chmod } from 'fs/promises'
import { readdir, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import YAML from 'js-yaml'
import { getActiveProfileDir, getActiveConfigPath, getActiveEnvPath, getActiveAuthPath } from './hermes/hermes-profile'
import { logger } from './logger'

// --- Provider env var mapping (from hermes providers.py HERMES_OVERLAYS + config.py) ---
export const PROVIDER_ENV_MAP: Record<string, { api_key_env: string; base_url_env: string }> = {
  openrouter: { api_key_env: 'OPENROUTER_API_KEY', base_url_env: '' },
  'glm-coding-plan': { api_key_env: '', base_url_env: '' },
  zai: { api_key_env: 'GLM_API_KEY', base_url_env: '' },
  'kimi-coding-cn': { api_key_env: 'KIMI_CN_API_KEY', base_url_env: '' },
  moonshot: { api_key_env: 'MOONSHOT_API_KEY', base_url_env: '' },
  minimax: { api_key_env: 'MINIMAX_API_KEY', base_url_env: '' },
  'minimax-cn': { api_key_env: 'MINIMAX_CN_API_KEY', base_url_env: '' },
  deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: '' },
  alibaba: { api_key_env: 'DASHSCOPE_API_KEY', base_url_env: '' },
  'alibaba-coding-plan': { api_key_env: 'ALIBABA_CODING_PLAN_API_KEY', base_url_env: 'ALIBABA_CODING_PLAN_BASE_URL' },
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
  stepfun: { api_key_env: 'STEPFUN_API_KEY', base_url_env: '' },
  nous: { api_key_env: '', base_url_env: '' },
  'openai-codex': { api_key_env: '', base_url_env: '' },
  copilot: { api_key_env: '', base_url_env: '' },
}

// --- Types ---

export interface SkillInfo {
  name: string
  description: string
  enabled: boolean
}

export interface SkillCategory {
  name: string
  description: string
  skills: SkillInfo[]
}

export interface ModelInfo {
  id: string
  label: string
}

export interface ModelGroup {
  provider: string
  models: ModelInfo[]
}

// --- Config YAML helpers ---

const configPath = () => getActiveConfigPath()

export async function readConfigYaml(): Promise<Record<string, any>> {
  const raw = await safeReadFile(configPath())
  if (!raw) return {}
  return (YAML.load(raw) as Record<string, any>) || {}
}

export async function writeConfigYaml(config: Record<string, any>): Promise<void> {
  const cp = configPath()
  await copyFile(cp, cp + '.bak')
  const yamlStr = YAML.dump(config, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  })
  await writeFile(cp, yamlStr, 'utf-8')
}

// --- .env helpers ---

export async function saveEnvValue(key: string, value: string): Promise<void> {
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
  try { await chmod(envPath, 0o600) } catch { /* ignore */ }
}

// --- File helpers ---

export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function safeStat(filePath: string): Promise<{ mtime: number } | null> {
  try {
    const s = await stat(filePath)
    return { mtime: Math.round(s.mtimeMs) }
  } catch {
    return null
  }
}

// --- Skill helpers ---

export function extractDescription(content: string): string {
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

export async function listFilesRecursive(dir: string, prefix: string): Promise<{ path: string; name: string }[]> {
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

// --- Provider model helpers ---

export async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const modelsUrl = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      logger.warn('available-models %s returned %d', modelsUrl, res.status)
      return []
    }
    const data = await res.json() as { data?: Array<{ id: string }> }
    if (!Array.isArray(data.data)) {
      logger.warn('available-models %s returned unexpected format', modelsUrl)
      return []
    }
    return data.data.map(m => m.id).sort()
  } catch (err: any) {
    logger.error(err, 'available-models %s failed', modelsUrl)
    return []
  }
}

export function buildModelGroups(config: Record<string, any>): { default: string; groups: ModelGroup[] } {
  let defaultModel = ''
  const groups: ModelGroup[] = []

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
        }
      }
    }
    if (customModels.length > 0) {
      groups.push({ provider: 'Custom', models: customModels })
    }
  }

  return { default: defaultModel, groups }
}

// --- Profile directory helper ---

export const getHermesDir = () => getActiveProfileDir()
