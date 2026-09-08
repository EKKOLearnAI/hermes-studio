import { getDb } from '../infrastructure/database'
import { SESSION_PIN_PREFERENCES_TABLE } from '../infrastructure/database/schemas'

const MAX_PINNED_SESSIONS = 1000
const MAX_SESSION_ID_LENGTH = 512

interface StoredSessionPinPreferencesRow {
  pinned_ids_json: string
}

function normalizeUserId(value: unknown): number {
  const userId = Number(value)
  return Number.isSafeInteger(userId) && userId > 0 ? userId : 0
}

function normalizeProfile(value: unknown): string {
  const profile = String(value || '').trim()
  return profile || 'default'
}

function normalizeSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const id = candidate.trim()
    if (!id || id.length > MAX_SESSION_ID_LENGTH || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    if (result.length >= MAX_PINNED_SESSIONS) break
  }
  return result
}

function readPinnedIds(value: string | undefined): string[] {
  if (!value) return []
  try {
    return normalizeSessionIds(JSON.parse(value))
  } catch {
    return []
  }
}

export function listSessionPins(userIdValue: unknown, profileValue: unknown): string[] {
  const db = getDb()
  if (!db) return []
  const row = db.prepare(
    `SELECT pinned_ids_json FROM ${SESSION_PIN_PREFERENCES_TABLE} WHERE user_id = ? AND profile = ?`,
  ).get(normalizeUserId(userIdValue), normalizeProfile(profileValue)) as StoredSessionPinPreferencesRow | undefined
  return readPinnedIds(row?.pinned_ids_json)
}

function writeSessionPins(userId: number, profile: string, pinnedIds: string[]): string[] {
  const db = getDb()
  if (!db) throw new Error('Session pin storage unavailable')
  const normalized = normalizeSessionIds(pinnedIds)
  db.prepare(
    `INSERT INTO ${SESSION_PIN_PREFERENCES_TABLE} (user_id, profile, pinned_ids_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, profile) DO UPDATE SET
       pinned_ids_json = excluded.pinned_ids_json,
       updated_at = excluded.updated_at`,
  ).run(userId, profile, JSON.stringify(normalized), Date.now())
  return normalized
}

export function mergeSessionPins(userIdValue: unknown, profileValue: unknown, pinnedIdsValue: unknown): string[] {
  const userId = normalizeUserId(userIdValue)
  const profile = normalizeProfile(profileValue)
  const current = listSessionPins(userId, profile)
  return writeSessionPins(userId, profile, [...current, ...normalizeSessionIds(pinnedIdsValue)])
}

export function setSessionPinned(
  userIdValue: unknown,
  profileValue: unknown,
  sessionIdValue: unknown,
  pinnedValue: unknown,
  mergePinnedIdsValue: unknown = [],
): string[] {
  const userId = normalizeUserId(userIdValue)
  const profile = normalizeProfile(profileValue)
  const sessionId = typeof sessionIdValue === 'string' ? sessionIdValue.trim() : ''
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new Error('Invalid session id')
  }
  if (typeof pinnedValue !== 'boolean') {
    throw new Error('Pinned must be a boolean')
  }
  const current = normalizeSessionIds([
    ...listSessionPins(userId, profile),
    ...normalizeSessionIds(mergePinnedIdsValue),
  ])
  const next = pinnedValue
    ? [...current, sessionId]
    : current.filter(id => id !== sessionId)
  return writeSessionPins(userId, profile, next)
}
