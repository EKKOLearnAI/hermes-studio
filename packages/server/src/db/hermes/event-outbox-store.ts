/**
 * Storage for the durable outbound event outbox.
 *
 * Three tables, deliberately separate:
 *   event_outbox              one row per event that happened
 *   outbound_webhook_endpoints one row per destination the user configured
 *   event_outbox_deliveries    one row per (event, endpoint) attempt chain
 *
 * Splitting the event from its deliveries is what lets the same event reach
 * several endpoints, each retrying on its own schedule, and what lets a restart
 * pick up exactly the deliveries that never landed.
 */

import { randomUUID, createHash } from 'crypto'
import { getDb } from '../index'
import {
  EVENT_OUTBOX_TABLE,
  EVENT_OUTBOX_DELIVERIES_TABLE,
  OUTBOUND_WEBHOOK_ENDPOINTS_TABLE,
} from './schemas'
import type { EventSubject, EventSummary, EventType } from '../../services/hermes/event-outbox/envelope'

export type DeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'dead'

export interface OutboxEventRecord {
  id: string
  type: EventType
  dedupe_key: string
  schema_version: number
  profile: string
  source: string
  subject: EventSubject
  summary: EventSummary
  occurred_at: number
  created_at: number
}

export interface WebhookEndpointRecord {
  id: string
  name: string
  url: string
  /** Never leaves the server: the API returns has_secret instead. */
  secret: string
  secret_env: string
  event_types: string[]
  profiles: string[]
  enabled: boolean
  max_attempts: number
  created_at: number
  updated_at: number
}

export interface DeliveryRecord {
  id: string
  event_id: string
  endpoint_id: string
  status: DeliveryStatus
  attempts: number
  next_attempt_at: number
  last_status_code: number
  last_error: string
  created_at: number
  updated_at: number
  delivered_at: number
}

function now(): number {
  return Date.now()
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function mapEvent(row: any): OutboxEventRecord {
  return {
    id: String(row.id),
    type: String(row.type) as EventType,
    dedupe_key: String(row.dedupe_key),
    schema_version: Number(row.schema_version) || 1,
    profile: String(row.profile || 'default'),
    source: String(row.source || ''),
    subject: parseJson<EventSubject>(row.subject_json, {}),
    summary: parseJson<EventSummary>(row.summary_json, {}),
    occurred_at: Number(row.occurred_at) || 0,
    created_at: Number(row.created_at) || 0,
  }
}

function mapEndpoint(row: any): WebhookEndpointRecord {
  return {
    id: String(row.id),
    name: String(row.name || ''),
    url: String(row.url || ''),
    secret: String(row.secret || ''),
    secret_env: String(row.secret_env || ''),
    event_types: parseJson<string[]>(row.event_types_json, []),
    profiles: parseJson<string[]>(row.profiles_json, []),
    enabled: Number(row.enabled) === 1,
    max_attempts: Number(row.max_attempts) || 8,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  }
}

function mapDelivery(row: any): DeliveryRecord {
  return {
    id: String(row.id),
    event_id: String(row.event_id),
    endpoint_id: String(row.endpoint_id),
    status: String(row.status || 'pending') as DeliveryStatus,
    attempts: Number(row.attempts) || 0,
    next_attempt_at: Number(row.next_attempt_at) || 0,
    last_status_code: Number(row.last_status_code) || 0,
    last_error: String(row.last_error || ''),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
    delivered_at: Number(row.delivered_at) || 0,
  }
}

// --- Endpoints ---------------------------------------------------------------

export interface EndpointInput {
  name: string
  url: string
  secret?: string
  secret_env?: string
  event_types?: string[]
  profiles?: string[]
  enabled?: boolean
  max_attempts?: number
}

export function listEndpoints(): WebhookEndpointRecord[] {
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(`SELECT * FROM ${OUTBOUND_WEBHOOK_ENDPOINTS_TABLE} ORDER BY created_at ASC`).all()
  return (rows as any[]).map(mapEndpoint)
}

export function getEndpoint(id: string): WebhookEndpointRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${OUTBOUND_WEBHOOK_ENDPOINTS_TABLE} WHERE id = ?`).get(id)
  return row ? mapEndpoint(row) : null
}

export function createEndpoint(input: EndpointInput): WebhookEndpointRecord | null {
  const db = getDb()
  if (!db) return null
  const id = randomUUID()
  const timestamp = now()
  db.prepare(
    `INSERT INTO ${OUTBOUND_WEBHOOK_ENDPOINTS_TABLE}
     (id, name, url, secret, secret_env, event_types_json, profiles_json, enabled, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.url,
    input.secret || '',
    input.secret_env || '',
    JSON.stringify(input.event_types || []),
    JSON.stringify(input.profiles || []),
    input.enabled === false ? 0 : 1,
    Number.isFinite(input.max_attempts) ? Number(input.max_attempts) : 8,
    timestamp,
    timestamp,
  )
  return getEndpoint(id)
}

export function updateEndpoint(id: string, input: Partial<EndpointInput>): WebhookEndpointRecord | null {
  const db = getDb()
  if (!db) return null
  const current = getEndpoint(id)
  if (!current) return null
  db.prepare(
    `UPDATE ${OUTBOUND_WEBHOOK_ENDPOINTS_TABLE}
     SET name = ?, url = ?, secret = ?, secret_env = ?, event_types_json = ?, profiles_json = ?,
         enabled = ?, max_attempts = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name ?? current.name,
    input.url ?? current.url,
    // An omitted secret keeps the stored one; an explicit empty string clears it.
    input.secret === undefined ? current.secret : input.secret,
    input.secret_env === undefined ? current.secret_env : input.secret_env,
    JSON.stringify(input.event_types ?? current.event_types),
    JSON.stringify(input.profiles ?? current.profiles),
    (input.enabled ?? current.enabled) ? 1 : 0,
    Number.isFinite(input.max_attempts) ? Number(input.max_attempts) : current.max_attempts,
    now(),
    id,
  )
  return getEndpoint(id)
}

export function deleteEndpoint(id: string): boolean {
  const db = getDb()
  if (!db) return false
  db.prepare(`DELETE FROM ${EVENT_OUTBOX_DELIVERIES_TABLE} WHERE endpoint_id = ?`).run(id)
  const result = db.prepare(`DELETE FROM ${OUTBOUND_WEBHOOK_ENDPOINTS_TABLE} WHERE id = ?`).run(id)
  return Number(result.changes) > 0
}

/**
 * An endpoint receives an event when it is enabled and neither of its filters
 * excludes it. An empty filter list means "everything", which is the least
 * surprising default for someone who just added a URL.
 */
export function endpointAcceptsEvent(endpoint: WebhookEndpointRecord, type: string, profile: string): boolean {
  if (!endpoint.enabled) return false
  if (endpoint.event_types.length > 0 && !endpoint.event_types.includes(type)) return false
  if (endpoint.profiles.length > 0 && !endpoint.profiles.includes(profile)) return false
  return true
}

// --- Events ------------------------------------------------------------------

export interface AppendEventInput {
  type: EventType
  dedupeKey: string
  profile: string
  source: string
  subject: EventSubject
  summary: EventSummary
  occurredAt?: number
  schemaVersion?: number
}

export interface AppendEventResult {
  event: OutboxEventRecord
  created: boolean
  deliveries: DeliveryRecord[]
}

export function stableEventId(dedupeKey: string): string {
  // A deterministic id keeps a replayed run pointing at the same event row, so
  // receivers can dedupe on `id` alone.
  return createHash('sha256').update(dedupeKey).digest('hex').slice(0, 32)
}

export function getEvent(id: string): OutboxEventRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${EVENT_OUTBOX_TABLE} WHERE id = ?`).get(id)
  return row ? mapEvent(row) : null
}

export function getEventByDedupeKey(dedupeKey: string): OutboxEventRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${EVENT_OUTBOX_TABLE} WHERE dedupe_key = ?`).get(dedupeKey)
  return row ? mapEvent(row) : null
}

/**
 * Record an event and fan it out to every endpoint that accepts it.
 *
 * The insert and the delivery rows go in one transaction: either the event is
 * recorded with its work queued, or nothing is. Re-appending the same
 * `dedupeKey` returns the existing event with `created: false` and queues
 * nothing new.
 */
export function appendEvent(input: AppendEventInput): AppendEventResult | null {
  const db = getDb()
  if (!db) return null

  const existing = getEventByDedupeKey(input.dedupeKey)
  if (existing) {
    return { event: existing, created: false, deliveries: listDeliveriesForEvent(existing.id) }
  }

  const timestamp = now()
  const occurredAt = Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : timestamp
  const id = stableEventId(input.dedupeKey)
  const targets = listEndpoints().filter(endpoint => endpointAcceptsEvent(endpoint, input.type, input.profile))

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO ${EVENT_OUTBOX_TABLE}
       (id, type, dedupe_key, schema_version, profile, source, subject_json, summary_json, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.type,
      input.dedupeKey,
      Number(input.schemaVersion) || 1,
      input.profile || 'default',
      input.source || '',
      JSON.stringify(input.subject || {}),
      JSON.stringify(input.summary || {}),
      occurredAt,
      timestamp,
    )
    for (const endpoint of targets) {
      db.prepare(
        `INSERT INTO ${EVENT_OUTBOX_DELIVERIES_TABLE}
         (id, event_id, endpoint_id, status, attempts, next_attempt_at, last_status_code, last_error, created_at, updated_at, delivered_at)
         VALUES (?, ?, ?, 'pending', 0, ?, 0, '', ?, ?, 0)`,
      ).run(randomUUID(), id, endpoint.id, timestamp, timestamp, timestamp)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    // A concurrent writer that won the unique index is not an error: the event
    // exists, which is all the caller wanted.
    const raced = getEventByDedupeKey(input.dedupeKey)
    if (raced) return { event: raced, created: false, deliveries: listDeliveriesForEvent(raced.id) }
    throw error
  }

  const event = getEvent(id)
  if (!event) return null
  return { event, created: true, deliveries: listDeliveriesForEvent(id) }
}

// --- Deliveries --------------------------------------------------------------

export function listDeliveriesForEvent(eventId: string): DeliveryRecord[] {
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(`SELECT * FROM ${EVENT_OUTBOX_DELIVERIES_TABLE} WHERE event_id = ?`).all(eventId)
  return (rows as any[]).map(mapDelivery)
}

export function listRecentDeliveries(endpointId: string, limit = 20): DeliveryRecord[] {
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(
    `SELECT * FROM ${EVENT_OUTBOX_DELIVERIES_TABLE} WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(endpointId, Math.max(1, Math.min(200, limit)))
  return (rows as any[]).map(mapDelivery)
}

export function getDelivery(id: string): DeliveryRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${EVENT_OUTBOX_DELIVERIES_TABLE} WHERE id = ?`).get(id)
  return row ? mapDelivery(row) : null
}

/**
 * Deliveries that are due now. `delivering` rows are included when they are
 * older than the stale window: that is how a delivery interrupted by a restart
 * or a crash comes back instead of sitting claimed forever.
 */
export function claimDueDeliveries(limit = 20, staleMs = 5 * 60_000): DeliveryRecord[] {
  const db = getDb()
  if (!db) return []
  const timestamp = now()
  const rows = db.prepare(
    `SELECT * FROM ${EVENT_OUTBOX_DELIVERIES_TABLE}
     WHERE (status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'delivering' AND updated_at <= ?)
     ORDER BY next_attempt_at ASC
     LIMIT ?`,
  ).all(timestamp, timestamp - staleMs, Math.max(1, Math.min(100, limit)))

  const claimed: DeliveryRecord[] = []
  for (const row of rows as any[]) {
    const result = db.prepare(
      `UPDATE ${EVENT_OUTBOX_DELIVERIES_TABLE}
       SET status = 'delivering', updated_at = ?
       WHERE id = ? AND status = ?`,
    ).run(timestamp, row.id, row.status)
    if (Number(result.changes) > 0) claimed.push(mapDelivery({ ...row, status: 'delivering', updated_at: timestamp }))
  }
  return claimed
}

export function markDelivered(id: string, statusCode: number): void {
  const db = getDb()
  if (!db) return
  const timestamp = now()
  db.prepare(
    `UPDATE ${EVENT_OUTBOX_DELIVERIES_TABLE}
     SET status = 'delivered', attempts = attempts + 1, last_status_code = ?, last_error = '',
         updated_at = ?, delivered_at = ?
     WHERE id = ?`,
  ).run(statusCode, timestamp, timestamp, id)
}

export function markRetry(id: string, nextAttemptAt: number, statusCode: number, error: string): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `UPDATE ${EVENT_OUTBOX_DELIVERIES_TABLE}
     SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?, last_status_code = ?,
         last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextAttemptAt, statusCode, error.slice(0, 500), now(), id)
}

export function markDead(id: string, statusCode: number, error: string): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `UPDATE ${EVENT_OUTBOX_DELIVERIES_TABLE}
     SET status = 'dead', attempts = attempts + 1, last_status_code = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(statusCode, error.slice(0, 500), now(), id)
}

export function countPendingDeliveries(): number {
  const db = getDb()
  if (!db) return 0
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM ${EVENT_OUTBOX_DELIVERIES_TABLE} WHERE status IN ('pending', 'delivering')`,
  ).get() as { count?: number } | undefined
  return Number(row?.count || 0)
}
