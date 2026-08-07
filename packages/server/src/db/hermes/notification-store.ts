import { randomUUID } from 'crypto'
import { getDb } from '../index'
import { NOTIFICATIONS_TABLE } from './schemas'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

export interface NotificationSource {
  kind: 'session' | 'room' | 'workflow' | 'cron' | 'system'
  id: string
  runId?: string
  route?: { name: string; params?: Record<string, string>; query?: Record<string, string> }
}

export interface NotificationRecord {
  id: string
  ownerId: number
  profile: string
  dedupeKey: string
  type: string
  severity: NotificationSeverity
  title: string
  body: string
  source: NotificationSource
  unread: boolean
  readAt: number | null
  createdAt: number
  updatedAt: number
}

export interface CreateNotificationInput {
  ownerId: number
  profile: string
  dedupeKey: string
  type: string
  severity: NotificationSeverity
  title: string
  body: string
  source: NotificationSource
  now?: number
}

interface NotificationRow {
  id: string
  owner_id: number
  profile: string
  dedupe_key: string
  type: string
  severity: NotificationSeverity
  title: string
  body: string
  source_json: string
  read_at: number | null
  created_at: number
  updated_at: number
}

function database() {
  const db = getDb()
  if (!db) throw new Error('Notifications require SQLite')
  return db
}

function mapRow(row: NotificationRow): NotificationRecord {
  let source: NotificationSource = { kind: 'system', id: '' }
  try { source = JSON.parse(row.source_json) as NotificationSource } catch { /* retain safe fallback */ }
  return {
    id: row.id,
    ownerId: row.owner_id,
    profile: row.profile,
    dedupeKey: row.dedupe_key,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    source,
    unread: row.read_at == null,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getOwned(ownerId: number, profile: string, id: string): NotificationRecord | null {
  const row = database().prepare(
    `SELECT * FROM ${NOTIFICATIONS_TABLE} WHERE id = ? AND owner_id = ? AND profile = ?`,
  ).get(id, ownerId, profile) as unknown as NotificationRow | undefined
  return row ? mapRow(row) : null
}

export function createNotification(input: CreateNotificationInput): { notification: NotificationRecord; created: boolean } {
  const db = database()
  const now = input.now ?? Date.now()
  const existing = db.prepare(
    `SELECT * FROM ${NOTIFICATIONS_TABLE} WHERE owner_id = ? AND profile = ? AND dedupe_key = ?`,
  ).get(input.ownerId, input.profile, input.dedupeKey) as unknown as NotificationRow | undefined
  if (existing) return { notification: mapRow(existing), created: false }

  const id = randomUUID()
  db.prepare(
    `INSERT INTO ${NOTIFICATIONS_TABLE}
      (id, owner_id, profile, dedupe_key, type, severity, title, body, source_json, read_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, input.ownerId, input.profile, input.dedupeKey, input.type, input.severity,
    input.title, input.body, JSON.stringify(input.source), now, now)
  return { notification: getOwned(input.ownerId, input.profile, id)!, created: true }
}

export function listNotifications(input: { ownerId: number; profile: string; limit?: number; unreadOnly?: boolean }) {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100))
  const unreadClause = input.unreadOnly ? ' AND read_at IS NULL' : ''
  const rows = database().prepare(
    `SELECT * FROM ${NOTIFICATIONS_TABLE} WHERE owner_id = ? AND profile = ?${unreadClause}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(input.ownerId, input.profile, limit) as unknown as NotificationRow[]
  const count = database().prepare(
    `SELECT COUNT(*) AS count FROM ${NOTIFICATIONS_TABLE} WHERE owner_id = ? AND profile = ? AND read_at IS NULL`,
  ).get(input.ownerId, input.profile) as unknown as { count: number }
  return { notifications: rows.map(mapRow), unreadCount: Number(count.count || 0) }
}

export function markNotificationRead(input: { ownerId: number; profile: string; id: string; now?: number }): NotificationRecord | null {
  const now = input.now ?? Date.now()
  database().prepare(
    `UPDATE ${NOTIFICATIONS_TABLE} SET read_at = COALESCE(read_at, ?), updated_at = ?
     WHERE id = ? AND owner_id = ? AND profile = ?`,
  ).run(now, now, input.id, input.ownerId, input.profile)
  return getOwned(input.ownerId, input.profile, input.id)
}

export function markNotificationReadByDedupeKey(input: { ownerId: number; profile: string; dedupeKey: string; now?: number }): boolean {
  const now = input.now ?? Date.now()
  const result = database().prepare(
    `UPDATE ${NOTIFICATIONS_TABLE} SET read_at = COALESCE(read_at, ?), updated_at = ?
     WHERE owner_id = ? AND profile = ? AND dedupe_key = ?`,
  ).run(now, now, input.ownerId, input.profile, input.dedupeKey)
  return Number(result.changes) > 0
}

export function markAllNotificationsRead(input: { ownerId: number; profile: string; now?: number }): number {
  const now = input.now ?? Date.now()
  const result = database().prepare(
    `UPDATE ${NOTIFICATIONS_TABLE} SET read_at = ?, updated_at = ?
     WHERE owner_id = ? AND profile = ? AND read_at IS NULL`,
  ).run(now, now, input.ownerId, input.profile)
  return Number(result.changes)
}

export function deleteNotification(input: { ownerId: number; profile: string; id: string }): boolean {
  const result = database().prepare(
    `DELETE FROM ${NOTIFICATIONS_TABLE} WHERE id = ? AND owner_id = ? AND profile = ?`,
  ).run(input.id, input.ownerId, input.profile)
  return Number(result.changes) > 0
}
