import { getDb } from '../index'
import { TTS_PROVIDER_SETTINGS_TABLE } from './schemas'
import { normalizeSafeTtsBaseUrl } from '../../services/hermes/tts-providers/url-safety'
import { validateMimoVoiceCloneDataUri } from '../../services/hermes/tts-providers/mimo'

export type StoredTtsProvider = 'openai' | 'custom' | 'edge' | 'mimo'

export interface StoredTtsProviderRow {
  provider: StoredTtsProvider
  settings: Record<string, unknown>
  secrets: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface StoredTtsProviderConfig {
  provider: StoredTtsProvider
  settings: Record<string, unknown>
  secrets: Record<string, string>
}

export class TtsSettingsValidationError extends Error {}

const PROVIDERS: StoredTtsProvider[] = ['openai', 'custom', 'edge', 'mimo']

const PROVIDER_LABELS: Record<StoredTtsProvider, string> = {
  openai: 'OpenAI',
  custom: 'Custom',
  edge: 'Edge',
  mimo: 'MiMo',
}

const SETTINGS_KEYS: Record<StoredTtsProvider, readonly string[]> = {
  openai: ['baseUrl', 'model', 'voice', 'rate', 'pitch'],
  custom: ['baseUrl', 'model', 'voice', 'rate', 'pitch'],
  edge: ['voice', 'rate', 'pitch'],
  mimo: ['baseUrl', 'authMode', 'model', 'voiceMode', 'voice', 'voiceDesignDesc', 'voiceCloneFormat', 'stylePrompt'],
}

const SECRET_KEYS: Record<StoredTtsProvider, readonly string[]> = {
  openai: ['apiKey'],
  custom: ['apiKey'],
  edge: [],
  mimo: ['apiKey', 'voiceCloneDataUri', 'voiceCloneFileName'],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
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

export function listStoredTtsSecretNames(provider: StoredTtsProvider): string[] {
  return [...SECRET_KEYS[provider]]
}

function assertKnownSecretName(provider: StoredTtsProvider, secretName: string): string {
  if (!SECRET_KEYS[provider].includes(secretName)) {
    throw new TtsSettingsValidationError('unknown TTS provider secret')
  }
  return secretName
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

function readStoredRow(userId: number, provider: StoredTtsProvider): {
  user_id: number
  provider: string
  settings_json: string
  secrets_json: string
  created_at: number
  updated_at: number
} | null {
  const db = getDb()
  if (!db) return null
  return db.prepare(
    `SELECT user_id, provider, settings_json, secrets_json, created_at, updated_at FROM ${TTS_PROVIDER_SETTINGS_TABLE} WHERE user_id = ? AND provider = ?`
  ).get(userId, provider) as any ?? null
}

function providerSettingsFromRow(row: {
  provider: string
  settings_json: string
  secrets_json: string
  created_at: number
  updated_at: number
}): StoredTtsProviderRow {
  const provider = assertStoredTtsProvider(row.provider)
  return {
    provider,
    settings: sanitizeStoredSettings(provider, parseJsonObject(row.settings_json)),
    secrets: maskSecrets(provider, sanitizeStoredSecrets(provider, parseJsonObject(row.secrets_json))),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  }
}

function providerConfigFromRow(row: {
  provider: string
  settings_json: string
  secrets_json: string
}): StoredTtsProviderConfig {
  const provider = assertStoredTtsProvider(row.provider)
  return {
    provider,
    settings: sanitizeStoredSettings(provider, parseJsonObject(row.settings_json)),
    secrets: sanitizeStoredSecrets(provider, parseJsonObject(row.secrets_json)),
  }
}

function sanitizeStoredSettings(provider: StoredTtsProvider, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const key of SETTINGS_KEYS[provider]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const value = input[key]

    if (key === 'baseUrl') {
      if (typeof value !== 'string') continue
      try {
        out.baseUrl = normalizeSafeTtsBaseUrl(value, PROVIDER_LABELS[provider])
      } catch (error) {
        throw new TtsSettingsValidationError(error instanceof Error ? error.message : String(error))
      }
      continue
    }

    if ((key === 'authMode' || key === 'voiceMode' || key === 'voiceCloneFormat') && typeof value === 'string') {
      const normalized = value.trim()
      if (!normalized) {
        out[key] = ''
        continue
      }

      if (key === 'authMode' && !['api-key', 'bearer', 'both'].includes(normalized)) {
        throw new TtsSettingsValidationError('MiMo TTS authMode is invalid')
      }
      if (key === 'voiceMode' && !['preset', 'voiceDesign', 'voiceClone'].includes(normalized)) {
        throw new TtsSettingsValidationError('MiMo TTS voiceMode is invalid')
      }
      if (key === 'voiceCloneFormat' && !['mp3', 'wav'].includes(normalized)) {
        throw new TtsSettingsValidationError('MiMo TTS voiceCloneFormat is invalid')
      }

      out[key] = normalized
      continue
    }

    if (typeof value === 'string') {
      out[key] = value.trim()
    }
  }

  return out
}

function sanitizeStoredSecrets(provider: StoredTtsProvider, input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}

  for (const key of Object.keys(input)) {
    assertKnownSecretName(provider, key)
  }

  for (const key of SECRET_KEYS[provider]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const rawValue = input[key]
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''

    if (!value) {
      continue
    }

    if (key === 'apiKey') {
      out.apiKey = value
      continue
    }

    if (key === 'voiceCloneDataUri') {
      validateMimoVoiceCloneDataUri(value)
      out.voiceCloneDataUri = value
      continue
    }

    if (key === 'voiceCloneFileName') {
      if (/[\\/]/.test(value)) {
        throw new TtsSettingsValidationError('MiMo TTS voiceCloneFileName must not contain path separators')
      }
      out.voiceCloneFileName = value
    }
  }

  return out
}

function mergeStoredValues<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  return { ...base, ...patch } as T
}

function mergeStoredSecrets(
  provider: StoredTtsProvider,
  existingSecrets: Record<string, string>,
  nextSecrets: Record<string, string>,
  preserveExistingSecrets: boolean,
): Record<string, string> {
  if (!preserveExistingSecrets) {
    return nextSecrets
  }

  const merged: Record<string, string> = { ...existingSecrets }
  for (const key of SECRET_KEYS[provider]) {
    if (!Object.prototype.hasOwnProperty.call(nextSecrets, key)) continue
    const value = nextSecrets[key]
    if (value) {
      merged[key] = value
    } else {
      delete merged[key]
    }
  }
  return merged
}

function maskApiKeyPreview(apiKey: string): string {
  if (!apiKey) return ''
  return apiKey.length <= 4 ? '••••' : `••••${apiKey.slice(-4)}`
}

function maskSecrets(provider: StoredTtsProvider, secrets: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const key of SECRET_KEYS[provider]) {
    const value = secrets[key]
    if (!value) continue
    masked[key] = key === 'apiKey' ? maskApiKeyPreview(value) : '[stored]'
  }
  return masked
}

export function listTtsProviderSettings(userId: number): StoredTtsProviderRow[] {
  const id = normalizeUserId(userId)
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(
    `SELECT provider, settings_json, secrets_json, created_at, updated_at FROM ${TTS_PROVIDER_SETTINGS_TABLE} WHERE user_id = ? ORDER BY provider ASC`
  ).all(id) as Array<{
    provider: string
    settings_json: string
    secrets_json: string
    created_at: number
    updated_at: number
  }>
  return rows.map(providerSettingsFromRow)
}

export function getTtsProviderPublicSettings(userId: number, provider: StoredTtsProvider): StoredTtsProviderRow | null {
  const id = normalizeUserId(userId)
  const row = readStoredRow(id, provider)
  return row ? providerSettingsFromRow(row) : null
}

export function getTtsProviderConfigForSynthesis(userId: number, provider: StoredTtsProvider): StoredTtsProviderConfig | null {
  const id = normalizeUserId(userId)
  const row = readStoredRow(id, provider)
  return row ? providerConfigFromRow(row) : null
}

export function upsertTtsProviderSettings(
  userId: number,
  provider: StoredTtsProvider,
  input: {
    settings?: unknown
    secrets?: unknown
    preserveExistingSecrets?: boolean
  },
): StoredTtsProviderRow {
  const id = normalizeUserId(userId)
  const db = requireDb()
  const existing = readStoredRow(id, provider)
  const existingSettings = existing ? sanitizeStoredSettings(provider, parseJsonObject(existing.settings_json)) : {}
  const existingSecrets = existing ? sanitizeStoredSecrets(provider, parseJsonObject(existing.secrets_json)) : {}
  const settingsPatch = sanitizeStoredSettings(provider, asObject(input.settings))
  const secretsPatch = sanitizeStoredSecrets(provider, asObject(input.secrets))
  const mergedSettings = mergeStoredValues(existingSettings, settingsPatch)
  const mergedSecrets = mergeStoredSecrets(provider, existingSecrets, secretsPatch, input.preserveExistingSecrets === true)
  const now = Date.now()

  if (existing) {
    db.prepare(
      `UPDATE ${TTS_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE user_id = ? AND provider = ?`
    ).run(JSON.stringify(mergedSettings), JSON.stringify(mergedSecrets), now, id, provider)
  } else {
    db.prepare(
      `INSERT INTO ${TTS_PROVIDER_SETTINGS_TABLE} (user_id, provider, settings_json, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, provider, JSON.stringify(mergedSettings), JSON.stringify(mergedSecrets), now, now)
  }

  return getTtsProviderPublicSettings(id, provider) as StoredTtsProviderRow
}

export function clearTtsProviderSecret(userId: number, provider: StoredTtsProvider, secretName: string): StoredTtsProviderRow | null {
  const id = normalizeUserId(userId)
  const db = requireDb()
  assertKnownSecretName(provider, secretName)
  const existing = readStoredRow(id, provider)
  if (!existing) {
    return null
  }

  const settings = sanitizeStoredSettings(provider, parseJsonObject(existing.settings_json))
  const secrets = sanitizeStoredSecrets(provider, parseJsonObject(existing.secrets_json))
  delete secrets[secretName]
  const now = Date.now()

  db.prepare(
    `UPDATE ${TTS_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE user_id = ? AND provider = ?`
  ).run(JSON.stringify(settings), JSON.stringify(secrets), now, id, provider)

  return getTtsProviderPublicSettings(id, provider)
}
