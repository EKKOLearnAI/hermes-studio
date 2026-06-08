import { getDb } from '../index'
import { TTS_PROVIDER_SETTINGS_TABLE } from './schemas'
import { normalizeSafeTtsBaseUrl } from '../../services/hermes/tts-providers/url-safety'

export type StoredTtsProvider = 'openai' | 'custom' | 'edge' | 'mimo'

const SETTINGS_KEYS = [
  'baseUrl',
  'baseUrlPresets',
  'model',
  'voice',
  'rate',
  'pitch',
  'authMode',
  'voiceMode',
  'voiceDesignDesc',
  'voiceCloneFormat',
  'stylePrompt',
] as const
const SECRET_KEYS = ['apiKey'] as const

type TtsSettingKey = (typeof SETTINGS_KEYS)[number]
type TtsSecretKey = (typeof SECRET_KEYS)[number]

export type TtsStoredSettings = Partial<Record<Exclude<TtsSettingKey, 'baseUrlPresets'>, string>> & { baseUrlPresets?: string[] }
export type TtsStoredSecrets = Partial<Record<TtsSecretKey, string>>

export interface StoredTtsProviderRow {
  userId: number
  provider: StoredTtsProvider
  settings: TtsStoredSettings
  secrets: TtsStoredSecrets
  createdAt: number
  updatedAt: number
}

export class TtsSettingsValidationError extends Error {}

const STORED_MARKER = '[stored]'
const MAX_TEXT_SETTING_LENGTH = 2000
const MAX_BASE_URL_PRESETS = 20
const PROVIDERS: StoredTtsProvider[] = ['custom', 'edge', 'mimo', 'openai']
const PROVIDER_SQL_PLACEHOLDERS = PROVIDERS.map(() => '?').join(', ')
const PROVIDER_LABELS: Record<StoredTtsProvider, string> = {
  openai: 'OpenAI TTS',
  custom: 'Custom TTS',
  edge: 'Edge TTS',
  mimo: 'MiMo TTS',
}

type StoredRow = {
  user_id: number
  provider: string
  settings_json: string
  secrets_json: string
  created_at: number
  updated_at: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return asObject(parsed)
  } catch {
    return {}
  }
}

function requireDb() {
  const db = getDb()
  if (!db) {
    throw new Error('TTS settings storage unavailable')
  }
  return db
}

function normalizeUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new TtsSettingsValidationError('invalid user id')
  }
  return userId
}

export function isStoredTtsProvider(provider: string): provider is StoredTtsProvider {
  return PROVIDERS.includes(provider as StoredTtsProvider)
}

export function assertStoredTtsProvider(provider: string): StoredTtsProvider {
  if (!isStoredTtsProvider(provider)) {
    throw new TtsSettingsValidationError('unknown TTS provider')
  }
  return provider
}

function assertKnownSecretName(secretName: string): TtsSecretKey {
  if (!SECRET_KEYS.includes(secretName as TtsSecretKey)) {
    throw new TtsSettingsValidationError('unknown TTS provider secret')
  }
  return secretName as TtsSecretKey
}

function readStoredRow(userId: number, provider: StoredTtsProvider): StoredRow | null {
  const db = getDb()
  if (!db) return null
  return db.prepare(
    `SELECT user_id, provider, settings_json, secrets_json, created_at, updated_at FROM ${TTS_PROVIDER_SETTINGS_TABLE} WHERE user_id = ? AND provider = ?`
  ).get(userId, provider) as StoredRow | null
}

function normalizeBaseUrlPresets(provider: StoredTtsProvider, input: unknown): string[] {
  const values = Array.isArray(input) ? input : []
  const out: string[] = []
  const seen = new Set<string>()

  for (const rawValue of values) {
    if (typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (!value) continue

    let normalized: string
    try {
      normalized = normalizeSafeTtsBaseUrl(value, PROVIDER_LABELS[provider])
    } catch (error) {
      throw new TtsSettingsValidationError(error instanceof Error ? error.message : String(error))
    }

    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= MAX_BASE_URL_PRESETS) break
  }

  return out
}

function appendBaseUrlPreset(provider: StoredTtsProvider, settings: TtsStoredSettings): TtsStoredSettings {
  if (!settings.baseUrl) return settings
  const presets = normalizeBaseUrlPresets(provider, settings.baseUrlPresets || [])
  if (!presets.includes(settings.baseUrl)) {
    presets.unshift(settings.baseUrl)
  }
  return { ...settings, baseUrlPresets: presets.slice(0, MAX_BASE_URL_PRESETS) }
}

function sanitizeStoredSettings(provider: StoredTtsProvider, input: Record<string, unknown>): TtsStoredSettings {
  const out: TtsStoredSettings = {}

  for (const key of SETTINGS_KEYS) {
    const rawValue = input[key]

    if (key === 'baseUrlPresets') {
      const presets = normalizeBaseUrlPresets(provider, rawValue)
      if (presets.length) out.baseUrlPresets = presets
      continue
    }

    if (typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (!value) continue

    if (key === 'baseUrl') {
      try {
        out.baseUrl = normalizeSafeTtsBaseUrl(value, PROVIDER_LABELS[provider])
      } catch (error) {
        throw new TtsSettingsValidationError(error instanceof Error ? error.message : String(error))
      }
      continue
    }

    out[key] = value.slice(0, MAX_TEXT_SETTING_LENGTH)
  }

  return out
}

function sanitizeStoredSecrets(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}

  for (const key of Object.keys(input)) {
    assertKnownSecretName(key)
  }

  const rawApiKey = input.apiKey
  if (typeof rawApiKey !== 'string') {
    return out
  }

  const apiKey = rawApiKey.trim()
  if (!apiKey || apiKey === STORED_MARKER) {
    return out
  }

  out.apiKey = apiKey
  return out
}

function maskSecrets(secrets: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  if (secrets.apiKey) masked.apiKey = STORED_MARKER
  return masked
}

function rowToResult(row: StoredRow, includeSecrets: boolean): StoredTtsProviderRow {
  const provider = assertStoredTtsProvider(row.provider)
  const settings = sanitizeStoredSettings(provider, parseJsonObject(row.settings_json))
  const secrets = sanitizeStoredSecrets(parseJsonObject(row.secrets_json))

  return {
    userId: Number(row.user_id),
    provider,
    settings,
    secrets: includeSecrets ? secrets : maskSecrets(secrets),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  }
}

export function listTtsProviderSettings(userId: number): StoredTtsProviderRow[] {
  const id = normalizeUserId(userId)
  const db = getDb()
  if (!db) return []

  const rows = db.prepare(
    `SELECT user_id, provider, settings_json, secrets_json, created_at, updated_at
     FROM ${TTS_PROVIDER_SETTINGS_TABLE}
     WHERE user_id = ? AND provider IN (${PROVIDER_SQL_PLACEHOLDERS})
     ORDER BY provider ASC`
  ).all(id, ...PROVIDERS) as StoredRow[]

  return rows.map(row => rowToResult(row, false))
}

export function getTtsProviderSetting(
  userId: number,
  provider: StoredTtsProvider,
  options?: { includeSecrets?: boolean },
): StoredTtsProviderRow | null {
  const id = normalizeUserId(userId)
  const storedProvider = assertStoredTtsProvider(provider)
  const row = readStoredRow(id, storedProvider)
  return row ? rowToResult(row, options?.includeSecrets === true) : null
}

export function saveTtsProviderSetting(
  userId: number,
  provider: StoredTtsProvider,
  input: { settings?: unknown; secrets?: unknown },
): StoredTtsProviderRow {
  const id = normalizeUserId(userId)
  const storedProvider = assertStoredTtsProvider(provider)
  const db = requireDb()
  const existing = readStoredRow(id, storedProvider)
  const existingSettings = existing ? sanitizeStoredSettings(storedProvider, parseJsonObject(existing.settings_json)) : {}
  const existingSecrets = existing ? sanitizeStoredSecrets(parseJsonObject(existing.secrets_json)) : {}
  const nextSettings = sanitizeStoredSettings(storedProvider, asObject(input.settings))
  const nextSecretsObject = asObject(input.secrets)

  for (const key of Object.keys(nextSecretsObject)) {
    assertKnownSecretName(key)
  }

  const nextSecrets = sanitizeStoredSecrets(nextSecretsObject)
  const mergedSettings = appendBaseUrlPreset(storedProvider, { ...existingSettings, ...nextSettings })
  const mergedSecrets = { ...existingSecrets, ...nextSecrets }
  const now = Date.now()

  db.prepare(
    `INSERT INTO ${TTS_PROVIDER_SETTINGS_TABLE} (user_id, provider, settings_json, secrets_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       settings_json = excluded.settings_json,
       secrets_json = excluded.secrets_json,
       updated_at = excluded.updated_at`
  ).run(id, storedProvider, JSON.stringify(mergedSettings), JSON.stringify(mergedSecrets), existing?.created_at || now, now)

  return getTtsProviderSetting(id, storedProvider) as StoredTtsProviderRow
}

export function removeTtsBaseUrlPreset(
  userId: number,
  provider: StoredTtsProvider,
  url: string,
): StoredTtsProviderRow | null {
  const id = normalizeUserId(userId)
  const storedProvider = assertStoredTtsProvider(provider)
  const normalizedUrl = normalizeSafeTtsBaseUrl(url, PROVIDER_LABELS[storedProvider])
  const db = requireDb()
  const existing = readStoredRow(id, storedProvider)
  if (!existing) return null

  const settings = sanitizeStoredSettings(storedProvider, parseJsonObject(existing.settings_json))
  const secrets = sanitizeStoredSecrets(parseJsonObject(existing.secrets_json))
  const nextPresets = normalizeBaseUrlPresets(storedProvider, settings.baseUrlPresets || [])
    .filter(preset => preset !== normalizedUrl)

  if (settings.baseUrl === normalizedUrl) {
    delete settings.baseUrl
  }

  if (nextPresets.length) {
    settings.baseUrlPresets = nextPresets
  } else {
    delete settings.baseUrlPresets
  }

  const now = Date.now()
  db.prepare(
    `UPDATE ${TTS_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE user_id = ? AND provider = ?`
  ).run(JSON.stringify(settings), JSON.stringify(secrets), now, id, storedProvider)

  return getTtsProviderSetting(id, storedProvider)
}

export function clearStoredTtsSecret(
  userId: number,
  provider: StoredTtsProvider,
  secretName: string,
): StoredTtsProviderRow | null {
  const id = normalizeUserId(userId)
  const storedProvider = assertStoredTtsProvider(provider)
  const secretKey = assertKnownSecretName(secretName)
  const db = requireDb()
  const existing = readStoredRow(id, storedProvider)
  if (!existing) return null

  const settings = sanitizeStoredSettings(storedProvider, parseJsonObject(existing.settings_json))
  const secrets = sanitizeStoredSecrets(parseJsonObject(existing.secrets_json))
  delete secrets[secretKey]
  const now = Date.now()

  db.prepare(
    `UPDATE ${TTS_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE user_id = ? AND provider = ?`
  ).run(JSON.stringify(settings), JSON.stringify(secrets), now, id, storedProvider)

  return getTtsProviderSetting(id, storedProvider)
}
