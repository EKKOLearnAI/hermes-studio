import { createHash, createHmac, randomUUID } from 'crypto'
import { dirname } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { getActionFabricDbPath, withActionFabricDb } from './database'
import { FabricAuditKeyProvider } from './audit-key'
import type {
  FabricAuditEvent,
  FabricAuditEventInput,
  FabricAuditListOptions,
  FabricJsonObject,
  FabricClaimedOutboxRecord,
  FabricOutboxRecord,
} from './types'

const GENESIS_HASH = '0'.repeat(64)
const AUDIT_FORMAT = 'hmac-sha256-v1'
const AUDIT_FORMAT_KEY = 'audit_format'
const MAX_JSON_BYTES = 32_768
const MAX_DEPTH = 8
const MAX_ITEMS = 64
const MAX_STRING_BYTES = 8_192
const MAX_INPUT_BYTES = 65_536
const MAX_VISITED_NODES = 4_096
const MAX_LIST_LIMIT = 200
const REDACTED = '[REDACTED]'
const AUDIT_HEAD_KEY = 'audit_chain_head'
const SENSITIVE_KEY = /(?:^|[_-])(secret|token|password|credential|cookie|auth(?:orization|entication)?|path|file|directory|dir|url|uri|dsn|error|exception)(?:$|[_-])/i
const SENSITIVE_COMPOUND_KEY = /(?:^|[_-])(?:api|private|secret|access|client|encryption|signing|service|account)[_-]key(?:$|[_-])/i
const CONNECTION_STRING = /(?:\b(?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|oracle|cockroachdb|mongodb(?:\+srv)?|rediss?|amqps?|nats|kafka|snowflake):\/\/|\bsqlite:\/{1,3}|\bjdbc:[a-z][a-z0-9+.-]*:(?:\/\/)?)/i
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s("'=])(?:[a-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+)/i
const UNIX_ABSOLUTE_PATH = /(?:^|[\s("'=])\/(?:etc|home|Users|usr|app|workspace|data|var|tmp|opt|root|srv|private|mnt|Volumes|proc|sys|dev)(?:\/[^\s"'<>]*)?/i
const EMBEDDED_SENSITIVE_PATH = /(?:^|[\s("'=])\/(?:[^\s/"'<>]+\/)*(?:[^\s/"'<>]*\.(?:db|sqlite|sqlite3|pem|key|env)|credentials?(?:\.[^\s/"'<>]+)?)(?:$|[\s,;:)"])/i
const FILE_URL = /\bfile:\/{2,3}[^\s"'<>]+/i
const CREDENTIAL_MARKER = /(?:\bBearer\s+[a-z0-9._~+/=-]+|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|credential|authorization|cookie)\s*[:=]\s*\S+)/i
const API_KEY_VALUE = /\b(?:sk-(?:live-|test-|proj-)?[a-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{20,})\b/i
const JWT_VALUE = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\b/i
const PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i
const auditKeyProviders = new Map<string, FabricAuditKeyProvider>()

type AuditRow = {
  sequence: number; id: string; event_type: string; actor_user_id: string
  aggregate_type: FabricAuditEvent['aggregateType']; aggregate_id: string; payload_json: string
  occurred_at: string; previous_hash: string; hash: string
}

type OutboxRow = {
  id: string; topic: string; aggregate_id: string; payload_json: string
  status: FabricOutboxRecord['status']; attempts: number; available_at: string
  locked_until: string | null; created_at: string; published_at: string | null
  claim_token: string | null
}

export interface FabricOutboxClaimOptions {
  limit?: number
  leaseMs?: number
  now?: string
}

export function appendFabricAuditEvent(db: DatabaseSync, input: FabricAuditEventInput): FabricAuditEvent {
  requireTransaction(db)
  const auditKey = getAuditKey()
  ensureAuditFormat(db, auditKey)
  validateText(input.eventType, 200, 'FABRIC_AUDIT_INVALID_EVENT_TYPE')
  validateText(input.actorUserId, 200, 'FABRIC_AUDIT_INVALID_ACTOR')
  validateText(input.aggregateId, 500, 'FABRIC_AUDIT_INVALID_AGGREGATE')
  const occurredAt = input.occurredAt ?? new Date().toISOString()
  if (!isCanonicalTimestamp(occurredAt)) throw new Error('FABRIC_AUDIT_INVALID_TIMESTAMP')
  const payload = sanitizePayload(input.payload)
  const prior = db.prepare(
    'SELECT sequence, hash FROM fabric_audit_events ORDER BY sequence DESC LIMIT 1',
  ).get() as { sequence: number; hash: string } | undefined
  assertStoredAuditHead(db, prior, auditKey)
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
  const hash = mac(auditKey, canonicalStringify(immutable))
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
    const format = db.prepare('SELECT value FROM fabric_meta WHERE key = ?').get(AUDIT_FORMAT_KEY) as
      { value: string } | undefined
    if (format === undefined) return verifyChain(db, legacyDigest)
    if (format.value !== AUDIT_FORMAT) return { valid: false, checked: 0, firstInvalidSequence: 1 }
    const auditKey = getAuditKey()
    return verifyChain(db, value => mac(auditKey, value))
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

/**
 * Claims eligible rows for at-least-once publication. Consumers must deduplicate by immutable outbox ID.
 */
export function claimPendingFabricOutbox(
  options: FabricOutboxClaimOptions = {},
): FabricClaimedOutboxRecord[] {
  const limit = boundedLimit(options.limit)
  const leaseMs = options.leaseMs ?? 30_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) {
    throw new Error('FABRIC_OUTBOX_INVALID_LEASE')
  }
  const now = options.now ?? new Date().toISOString()
  if (!isCanonicalTimestamp(now)) throw new Error('FABRIC_OUTBOX_INVALID_TIME')
  const lockedUntil = new Date(new Date(now).getTime() + leaseMs).toISOString()
  return withActionFabricDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const candidates = db.prepare(`
        SELECT id FROM fabric_outbox
        WHERE status = 'pending' AND available_at <= ?
          AND (locked_until IS NULL OR locked_until <= ?)
        ORDER BY created_at ASC, rowid ASC LIMIT ?
      `).all(now, now, limit) as Array<{ id: string }>
      const claimed: FabricClaimedOutboxRecord[] = []
      for (const candidate of candidates) {
        const claimToken = randomUUID()
        const result = db.prepare(`
          UPDATE fabric_outbox SET locked_until = ?, claim_token = ?
          WHERE id = ? AND status = 'pending' AND available_at <= ?
            AND (locked_until IS NULL OR locked_until <= ?)
        `).run(lockedUntil, claimToken, candidate.id, now, now)
        if (result.changes !== 1) continue
        const row = db.prepare('SELECT * FROM fabric_outbox WHERE id = ?').get(candidate.id) as OutboxRow
        claimed.push({ ...parseOutboxRow(row), claimToken })
      }
      db.exec('COMMIT')
      return claimed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

export function markFabricOutboxPublished(id: string, claimToken: string, now = new Date().toISOString()): boolean {
  validateText(id, 200, 'FABRIC_OUTBOX_INVALID_ID')
  validateText(claimToken, 200, 'FABRIC_OUTBOX_INVALID_CLAIM')
  if (!isCanonicalTimestamp(now)) throw new Error('FABRIC_OUTBOX_INVALID_TIME')
  return withActionFabricDb(db => {
    const result = db.prepare(`
      UPDATE fabric_outbox
      SET status = 'published', attempts = attempts + 1, published_at = ?,
        locked_until = NULL, claim_token = NULL
      WHERE id = ? AND status = 'pending' AND claim_token = ? AND locked_until > ?
    `).run(now, id, claimToken, now)
    return result.changes === 1
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
  auditKey: Buffer,
): void {
  const row = db.prepare('SELECT value FROM fabric_meta WHERE key = ?').get(AUDIT_HEAD_KEY) as
    { value: string } | undefined
  if (prior === undefined && row === undefined) return
  try {
    const head = JSON.parse(row?.value ?? '') as { sequence?: unknown; hash?: unknown }
    if (head.sequence === prior?.sequence && head.hash === prior?.hash) {
      if (prior === undefined) return
      const last = db.prepare('SELECT * FROM fabric_audit_events WHERE sequence = ?').get(prior.sequence) as AuditRow
      const calculated = mac(auditKey, canonicalStringify({
        sequence: last.sequence,
        eventType: last.event_type,
        actorUserId: last.actor_user_id,
        aggregateType: last.aggregate_type,
        aggregateId: last.aggregate_id,
        payload: parseJsonObject(last.payload_json),
        occurredAt: last.occurred_at,
        previousHash: last.previous_hash,
      }))
      if (calculated === prior.hash && last.id === `audit-${last.sequence}-${calculated.slice(0, 24)}`) return
    }
  } catch {
    // A stable error below avoids exposing the corrupt stored value.
  }
  throw new Error('FABRIC_AUDIT_CHAIN_CORRUPT')
}

function ensureAuditFormat(db: DatabaseSync, auditKey: Buffer): void {
  const row = db.prepare('SELECT value FROM fabric_meta WHERE key = ?').get(AUDIT_FORMAT_KEY) as
    { value: string } | undefined
  if (row?.value === AUDIT_FORMAT) return
  if (row !== undefined) throw new Error('FABRIC_AUDIT_FORMAT_MIGRATION_REQUIRED')
  const count = db.prepare('SELECT COUNT(*) AS count FROM fabric_audit_events').get() as { count: number }
  if (count.count > 0) {
    const verification = verifyChain(db, legacyDigest)
    if (!verification.valid) throw new Error('FABRIC_AUDIT_LEGACY_INVALID')
    let previousHash = GENESIS_HASH
    let finalSequence = 0
    const update = db.prepare(`UPDATE fabric_audit_events
      SET id = ?, previous_hash = ?, hash = ? WHERE sequence = ?`)
    for (const row of db.prepare(
      'SELECT * FROM fabric_audit_events ORDER BY sequence ASC',
    ).iterate() as IterableIterator<AuditRow>) {
      const payload = parseJsonObject(row.payload_json)
      const hash = mac(auditKey, canonicalStringify(immutableAuditFields(row, payload, previousHash)))
      update.run(`audit-${row.sequence}-${hash.slice(0, 24)}`, previousHash, hash, row.sequence)
      previousHash = hash
      finalSequence = row.sequence
    }
    db.prepare('UPDATE fabric_meta SET value = ? WHERE key = ?')
      .run(canonicalStringify({ sequence: finalSequence, hash: previousHash }), AUDIT_HEAD_KEY)
  }
  db.prepare('INSERT INTO fabric_meta(key, value) VALUES (?, ?)').run(AUDIT_FORMAT_KEY, AUDIT_FORMAT)
}

function verifyChain(
  db: DatabaseSync,
  calculate: (canonical: string) => string,
): { valid: boolean; checked: number; firstInvalidSequence: number | null } {
  let previousHash = GENESIS_HASH
  let expectedSequence = 1
  let checked = 0
  let finalSequence = 0
  for (const row of db.prepare(
    'SELECT * FROM fabric_audit_events ORDER BY sequence ASC',
  ).iterate() as IterableIterator<AuditRow>) {
    let payload: FabricJsonObject
    try {
      payload = parseJsonObject(row.payload_json)
    } catch {
      return { valid: false, checked, firstInvalidSequence: row.sequence }
    }
    const calculated = calculate(canonicalStringify(immutableAuditFields(row, payload, row.previous_hash)))
    const expectedId = `audit-${row.sequence}-${calculated.slice(0, 24)}`
    if (row.sequence !== expectedSequence || row.previous_hash !== previousHash
      || row.hash !== calculated || row.id !== expectedId) {
      return { valid: false, checked, firstInvalidSequence: row.sequence }
    }
    checked += 1
    expectedSequence += 1
    finalSequence = row.sequence
    previousHash = row.hash
  }
  const headRow = db.prepare('SELECT value FROM fabric_meta WHERE key = ?').get(AUDIT_HEAD_KEY) as
    { value: string } | undefined
  if (checked === 0) {
    if (headRow !== undefined) return { valid: false, checked: 0, firstInvalidSequence: 1 }
    return { valid: true, checked: 0, firstInvalidSequence: null }
  }
  try {
    const head = JSON.parse(headRow?.value ?? '') as { sequence?: unknown; hash?: unknown }
    if (head.sequence !== finalSequence || head.hash !== previousHash) {
      return { valid: false, checked, firstInvalidSequence: expectedSequence }
    }
  } catch {
    return { valid: false, checked, firstInvalidSequence: expectedSequence }
  }
  return { valid: true, checked, firstInvalidSequence: null }
}

function immutableAuditFields(row: AuditRow, payload: FabricJsonObject, previousHash: string): FabricJsonObject {
  return {
    sequence: row.sequence,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload,
    occurredAt: row.occurred_at,
    previousHash,
  }
}

function legacyDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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
  const sanitized = sanitizeValue(input, 0, new Set(), { nodes: 0, bytes: 0 }) as FabricJsonObject
  const canonical = canonicalStringify(sanitized)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_JSON_BYTES) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
  return sanitized
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
  budget: { nodes: number; bytes: number },
): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_VISITED_NODES) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
  if (value !== null && typeof value === 'object' && depth >= MAX_DEPTH) return { _truncated: true }
  if (value instanceof Error) return REDACTED
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_BYTES) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_STRING_BYTES) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
    budget.bytes += bytes
    if (budget.bytes > MAX_INPUT_BYTES) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
    return containsSensitiveString(value) ? REDACTED : value
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('FABRIC_AUDIT_INVALID_JSON')
    return value
  }
  if (typeof value !== 'object') throw new Error('FABRIC_AUDIT_INVALID_JSON')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('FABRIC_AUDIT_INVALID_JSON')
  }
  if (seen.has(value)) throw new Error('FABRIC_AUDIT_INVALID_JSON')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.some(key => typeof key !== 'string'
        || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
        throw new Error('FABRIC_AUDIT_INVALID_JSON')
      }
      return value.map(item => sanitizeValue(item, depth + 1, seen, budget))
    }
    const source = value as Record<string, unknown>
    const semanticName = ['key', 'name', 'type', 'kind'].map(key => source[key])
      .find(item => typeof item === 'string' && isSensitiveKey(item))
    const keys = Object.keys(source)
    if (keys.length > MAX_ITEMS) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
    for (const key of keys) {
      if (!key) throw new Error('FABRIC_AUDIT_INVALID_JSON')
      budget.bytes += Buffer.byteLength(key, 'utf8')
      if (budget.bytes > MAX_INPUT_BYTES) throw new Error('FABRIC_AUDIT_INPUT_LIMIT')
    }
    const entries = keys.sort().map(key => [key, source[key]] as [string, unknown])
    const output: FabricJsonObject = {}
    for (const [key, item] of entries) {
      const semanticValue = semanticName !== undefined && /^(value|content|data)$/i.test(key)
      output[key] = isSensitiveKey(key) || semanticValue
        ? REDACTED
        : sanitizeValue(item, depth + 1, seen, budget)
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
  return SENSITIVE_KEY.test(normalized) || SENSITIVE_COMPOUND_KEY.test(normalized)
}

function containsSensitiveString(value: string): boolean {
  const trimmed = value.trim()
  const wholeUnixPath = /^\/\S+$/.test(trimmed) && !/^\/api(?:\/|$)/i.test(trimmed)
  return CONNECTION_STRING.test(value)
    || URL_USERINFO.test(value)
    || WINDOWS_ABSOLUTE_PATH.test(value)
    || UNIX_ABSOLUTE_PATH.test(value)
    || wholeUnixPath
    || EMBEDDED_SENSITIVE_PATH.test(value)
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

function getAuditKey(): Buffer {
  const directory = dirname(getActionFabricDbPath())
  let provider = auditKeyProviders.get(directory)
  if (provider === undefined) {
    provider = new FabricAuditKeyProvider({ directory })
    auditKeyProviders.set(directory, provider)
  }
  return provider.getKey()
}

function mac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex')
}
