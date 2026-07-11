import { createHash, randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { withActionFabricDb } from './database'
import type {
  FabricAuditEvent,
  FabricAuditEventInput,
  FabricAuditListOptions,
  FabricJsonObject,
  FabricOutboxRecord,
} from './types'

const GENESIS_HASH = '0'.repeat(64)
const MAX_JSON_BYTES = 32_768
const MAX_DEPTH = 8
const MAX_ITEMS = 64
const MAX_STRING = 4_096
const MAX_LIST_LIMIT = 200
const REDACTED = '[REDACTED]'
const AUDIT_HEAD_KEY = 'audit_chain_head'
const SENSITIVE_KEY = /(?:^|[_-])(secret|token|password|credential|key|cookie|auth(?:orization|entication)?|path|file|directory|dir|url|uri|dsn|error|exception)(?:$|[_-])/i
const CONNECTION_STRING = /(?:\b(?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|oracle|cockroachdb|mongodb(?:\+srv)?|rediss?|amqps?|nats|kafka|snowflake):\/\/|\bsqlite:\/{1,3}|\bjdbc:[a-z][a-z0-9+.-]*:(?:\/\/)?)/i
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s("'=])(?:[a-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+)/i
const UNIX_ABSOLUTE_PATH = /(?:^|[\s("'=])\/(?:etc|home|Users|var|tmp|opt|root|srv|private|mnt|Volumes|proc|sys|dev)(?:\/[^\s"'<>]*)?/i
const FILE_URL = /\bfile:\/{2,3}[^\s"'<>]+/i
const CREDENTIAL_MARKER = /(?:\bBearer\s+[a-z0-9._~+/=-]+|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|credential|authorization|cookie)\s*[:=]\s*\S+)/i
const API_KEY_VALUE = /\b(?:sk-(?:live-|test-|proj-)?[a-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{20,})\b/i
const JWT_VALUE = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\b/i
const PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i

type AuditRow = {
  sequence: number; id: string; event_type: string; actor_user_id: string
  aggregate_type: FabricAuditEvent['aggregateType']; aggregate_id: string; payload_json: string
  occurred_at: string; previous_hash: string; hash: string
}

type OutboxRow = {
  id: string; topic: string; aggregate_id: string; payload_json: string
  status: FabricOutboxRecord['status']; attempts: number; available_at: string
  locked_until: string | null; created_at: string; published_at: string | null
}

export function appendFabricAuditEvent(db: DatabaseSync, input: FabricAuditEventInput): FabricAuditEvent {
  requireTransaction(db)
  validateText(input.eventType, 200, 'FABRIC_AUDIT_INVALID_EVENT_TYPE')
  validateText(input.actorUserId, 200, 'FABRIC_AUDIT_INVALID_ACTOR')
  validateText(input.aggregateId, 500, 'FABRIC_AUDIT_INVALID_AGGREGATE')
  const occurredAt = input.occurredAt ?? new Date().toISOString()
  if (!isCanonicalTimestamp(occurredAt)) throw new Error('FABRIC_AUDIT_INVALID_TIMESTAMP')
  const payload = sanitizePayload(input.payload)
  const prior = db.prepare(
    'SELECT sequence, hash FROM fabric_audit_events ORDER BY sequence DESC LIMIT 1',
  ).get() as { sequence: number; hash: string } | undefined
  assertStoredAuditHead(db, prior)
  const sequence = (prior?.sequence ?? 0) + 1
  const previousHash = prior?.hash ?? GENESIS_HASH
  const immutable = {
    sequence,
    eventType: input.eventType,
    actorUserId: input.actorUserId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload,
    occurredAt,
    previousHash,
  }
  const hash = digest(canonicalStringify(immutable))
  const id = `audit-${sequence}-${hash.slice(0, 24)}`
  db.prepare(`
    INSERT INTO fabric_audit_events(
      sequence, id, event_type, actor_user_id, aggregate_type, aggregate_id,
      payload_json, occurred_at, previous_hash, hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sequence, id, input.eventType, input.actorUserId, input.aggregateType,
    input.aggregateId, canonicalStringify(payload), occurredAt, previousHash, hash,
  )
  db.prepare(`
    INSERT INTO fabric_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(AUDIT_HEAD_KEY, canonicalStringify({ sequence, hash }))
  return { ...input, payload, occurredAt, sequence, id, previousHash, hash }
}

export function listFabricAuditEvents(options: FabricAuditListOptions = {}): FabricAuditEvent[] {
  const limit = boundedLimit(options.limit)
  const clauses: string[] = []
  const parameters: Array<string | number> = []
  if (options.aggregateType !== undefined) {
    clauses.push('aggregate_type = ?')
    parameters.push(options.aggregateType)
  }
  if (options.aggregateId !== undefined) {
    clauses.push('aggregate_id = ?')
    parameters.push(options.aggregateId)
  }
  if (options.eventType !== undefined) {
    clauses.push('event_type = ?')
    parameters.push(options.eventType)
  }
  if (options.afterSequence !== undefined) {
    if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
      throw new Error('FABRIC_AUDIT_INVALID_SEQUENCE')
    }
    clauses.push('sequence > ?')
    parameters.push(options.afterSequence)
  }
  parameters.push(limit)
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  return withActionFabricDb(db => (db.prepare(
    `SELECT * FROM fabric_audit_events ${where} ORDER BY sequence ASC LIMIT ?`,
  ).all(...parameters) as AuditRow[]).map(parseAuditRow))
}

export function verifyFabricAuditChain(): {
  valid: boolean
  checked: number
  firstInvalidSequence: number | null
} {
  return withActionFabricDb(db => {
    const rows = db.prepare('SELECT * FROM fabric_audit_events ORDER BY sequence ASC').all() as AuditRow[]
    let previousHash = GENESIS_HASH
    let expectedSequence = 1
    let checked = 0
    for (const row of rows) {
      let payload: FabricJsonObject
      try {
        payload = parseJsonObject(row.payload_json)
      } catch {
        return { valid: false, checked, firstInvalidSequence: row.sequence }
      }
      const calculated = digest(canonicalStringify({
        sequence: row.sequence,
        eventType: row.event_type,
        actorUserId: row.actor_user_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload,
        occurredAt: row.occurred_at,
        previousHash: row.previous_hash,
      }))
      const expectedId = `audit-${row.sequence}-${calculated.slice(0, 24)}`
      if (row.sequence !== expectedSequence || row.previous_hash !== previousHash
        || row.hash !== calculated || row.id !== expectedId) {
        return { valid: false, checked, firstInvalidSequence: row.sequence }
      }
      checked += 1
      expectedSequence += 1
      previousHash = row.hash
    }
    const headRow = db.prepare('SELECT value FROM fabric_meta WHERE key = ?').get(AUDIT_HEAD_KEY) as
      { value: string } | undefined
    if (rows.length === 0) {
      if (headRow !== undefined) return { valid: false, checked: 0, firstInvalidSequence: 1 }
      return { valid: true, checked: 0, firstInvalidSequence: null }
    }
    let head: { sequence?: unknown; hash?: unknown }
    try {
      head = JSON.parse(headRow?.value ?? '') as { sequence?: unknown; hash?: unknown }
    } catch {
      return { valid: false, checked, firstInvalidSequence: expectedSequence }
    }
    if (head.sequence !== rows.at(-1)!.sequence || head.hash !== rows.at(-1)!.hash) {
      return { valid: false, checked, firstInvalidSequence: expectedSequence }
    }
    return { valid: true, checked, firstInvalidSequence: null }
  })
}

export function appendFabricOutbox(
  db: DatabaseSync,
  topic: string,
  aggregateId: string,
  payloadInput: Record<string, unknown>,
): FabricOutboxRecord {
  requireTransaction(db)
  validateText(topic, 200, 'FABRIC_OUTBOX_INVALID_TOPIC')
  validateText(aggregateId, 500, 'FABRIC_OUTBOX_INVALID_AGGREGATE')
  const payload = sanitizePayload(payloadInput)
  const now = new Date().toISOString()
  const id = `outbox-${randomUUID()}`
  db.prepare(`
    INSERT INTO fabric_outbox(
      id, topic, aggregate_id, payload_json, status, attempts, available_at, created_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(id, topic, aggregateId, canonicalStringify(payload), now, now)
  return {
    id, topic, aggregateId, payload, status: 'pending', attempts: 0,
    availableAt: now, lockedUntil: null, createdAt: now, publishedAt: null,
  }
}

export function listPendingFabricOutbox(limit = 100): FabricOutboxRecord[] {
  const bounded = boundedLimit(limit)
  const now = new Date().toISOString()
  return withActionFabricDb(db => (db.prepare(`
    SELECT * FROM fabric_outbox
    WHERE status = 'pending' AND available_at <= ?
    ORDER BY created_at ASC, rowid ASC LIMIT ?
  `).all(now, bounded) as OutboxRow[]).map(parseOutboxRow))
}

export function markFabricOutboxPublished(id: string): void {
  validateText(id, 200, 'FABRIC_OUTBOX_INVALID_ID')
  withActionFabricDb(db => {
    db.prepare(`
      UPDATE fabric_outbox
      SET status = 'published', attempts = attempts + 1, published_at = ?, locked_until = NULL
      WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), id)
  })
}

function parseAuditRow(row: AuditRow): FabricAuditEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: parseJsonObject(row.payload_json),
    occurredAt: row.occurred_at,
    previousHash: row.previous_hash,
    hash: row.hash,
  }
}

function assertStoredAuditHead(
  db: DatabaseSync,
  prior: { sequence: number; hash: string } | undefined,
): void {
  const row = db.prepare('SELECT value FROM fabric_meta WHERE key = ?').get(AUDIT_HEAD_KEY) as
    { value: string } | undefined
  if (prior === undefined && row === undefined) return
  try {
    const head = JSON.parse(row?.value ?? '') as { sequence?: unknown; hash?: unknown }
    if (head.sequence === prior?.sequence && head.hash === prior?.hash) return
  } catch {
    // A stable error below avoids exposing the corrupt stored value.
  }
  throw new Error('FABRIC_AUDIT_CHAIN_CORRUPT')
}

function parseOutboxRow(row: OutboxRow): FabricOutboxRecord {
  return {
    id: row.id,
    topic: row.topic,
    aggregateId: row.aggregate_id,
    payload: parseJsonObject(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

function sanitizePayload(input: Record<string, unknown>): FabricJsonObject {
  validateStrictJson(input, new Set())
  const sanitized = sanitizeValue(input, 0, new Set()) as FabricJsonObject
  const canonical = canonicalStringify(sanitized)
  if (Buffer.byteLength(canonical, 'utf8') <= MAX_JSON_BYTES) return sanitized
  return {
    _truncated: true,
    _digest: digest(canonical),
    preview: canonical.slice(0, 1_024),
  }
}

function validateStrictJson(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('FABRIC_AUDIT_INVALID_JSON')
    return
  }
  if (value instanceof Error) return
  if (typeof value !== 'object') throw new Error('FABRIC_AUDIT_INVALID_JSON')
  if (seen.has(value)) throw new Error('FABRIC_AUDIT_INVALID_JSON')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.some(key => typeof key !== 'string'
        || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
        throw new Error('FABRIC_AUDIT_INVALID_JSON')
      }
      for (const item of value) validateStrictJson(item, seen)
      return
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('FABRIC_AUDIT_INVALID_JSON')
    }
    for (const [key, item] of Object.entries(value)) {
      if (!key) throw new Error('FABRIC_AUDIT_INVALID_JSON')
      validateStrictJson(item, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function sanitizeValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value instanceof Error) return REDACTED
  if (typeof value === 'string') {
    if (containsSensitiveString(value)) return `[REDACTED:SENSITIVE:${digest(value).slice(0, 16)}]`
    if (value.length <= MAX_STRING) return value
    return `${value.slice(0, MAX_STRING)}[TRUNCATED:${digest(value)}]`
  }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) throw new Error('FABRIC_AUDIT_INVALID_JSON')
  if (depth >= MAX_DEPTH) return { _truncated: true, _digest: digest(canonicalStringify(value)) }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map(item => sanitizeValue(item, depth + 1, seen))
      if (value.length > MAX_ITEMS) {
        items.push({ _truncated: true, _digest: digest(canonicalStringify(value.slice(MAX_ITEMS))) })
      }
      return items
    }
    const source = value as Record<string, unknown>
    const semanticName = ['key', 'name', 'type', 'kind'].map(key => source[key])
      .find(item => typeof item === 'string' && isSensitiveKey(item))
    const entries = Object.entries(source).sort(compareKeys)
    const output: FabricJsonObject = {}
    for (const [key, item] of entries.slice(0, MAX_ITEMS)) {
      const semanticValue = semanticName !== undefined && /^(value|content|data)$/i.test(key)
      output[key] = isSensitiveKey(key) || semanticValue ? REDACTED : sanitizeValue(item, depth + 1, seen)
    }
    if (entries.length > MAX_ITEMS) {
      output._truncated = true
      output._digest = digest(canonicalStringify(Object.fromEntries(entries.slice(MAX_ITEMS))))
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(compareKeys)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('FABRIC_AUDIT_INVALID_JSON')
  return encoded
}

function compareKeys([left]: [string, unknown], [right]: [string, unknown]): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isSensitiveKey(value: string): boolean {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SENSITIVE_KEY.test(normalized)
}

function containsSensitiveString(value: string): boolean {
  return CONNECTION_STRING.test(value)
    || URL_USERINFO.test(value)
    || WINDOWS_ABSOLUTE_PATH.test(value)
    || UNIX_ABSOLUTE_PATH.test(value)
    || FILE_URL.test(value)
    || CREDENTIAL_MARKER.test(value)
    || API_KEY_VALUE.test(value)
    || JWT_VALUE.test(value)
    || PRIVATE_KEY_MARKER.test(value)
}

function parseJsonObject(value: string): FabricJsonObject {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('FABRIC_AUDIT_INVALID_JSON')
  return parsed as FabricJsonObject
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('FABRIC_LIST_INVALID_LIMIT')
  return Math.min(value, MAX_LIST_LIMIT)
}

function requireTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('FABRIC_TRANSACTION_REQUIRED')
}

function validateText(value: string, max: number, code: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(code)
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
