import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getTwinArtifact, withPersonalTwinDb } from '../personal-twin'

const ARTIFACT_ID = /^artifact-([0-9a-f]{64})$/
const DIGEST = /^[0-9a-f]{64}$/
const TOKEN = /^[0-9a-f]{64}$/
const PURPOSES = ['measurement', 'posture', 'skin', 'diet', 'internal_health'] as const
const RETENTIONS = ['no_retention', 'session', '24_hours'] as const
const MANIFEST_KEYS = ['artifactIds', 'processor', 'purpose', 'selectedRegions', 'requestedFields', 'retention'] as const
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const DEFAULT_TTL_MS = 5 * 60 * 1000
const MAX_TTL_MS = 15 * 60 * 1000
const MAX_MANIFEST_BYTES = 7000
const MAX_SCOPE_BYTES = 8192

export interface HealthProcessingManifest {
  artifactIds: string[]
  processor: string
  purpose: typeof PURPOSES[number]
  selectedRegions: string[]
  requestedFields: string[]
  retention: string
}

export type HealthConsentErrorCode =
  | 'HEALTH_CONSENT_MANIFEST_INVALID'
  | 'HEALTH_CONSENT_ARTIFACT_INVALID'
  | 'HEALTH_CONSENT_TTL_INVALID'
  | 'HEALTH_CONSENT_ACTIVE'
  | 'HEALTH_CONSENT_INVALID'
  | 'HEALTH_CONSENT_EXPIRED'
  | 'HEALTH_CONSENT_REVOKED'
  | 'HEALTH_CONSENT_REPLAYED'
  | 'HEALTH_CONSENT_NOT_FOUND'
  | 'HEALTH_CONSENT_STORAGE_FAILED'

export class HealthConsentError extends Error {
  readonly code: HealthConsentErrorCode

  constructor(code: HealthConsentErrorCode) {
    super(code)
    this.name = 'HealthConsentError'
    this.code = code
  }
}

export interface HealthConsentGrant {
  consentId: string
  manifestDigest: string
  token: string
  manifest: HealthProcessingManifest
  issuedAt: string
  expiresAt: string
}

export interface HealthConsentConsumption {
  consentId: string
  manifestDigest: string
  consumedAt: string
}

export interface HealthConsentRevocation {
  consentId: string
  revokedAt: string
}

export interface HealthConsentBrokerOptions {
  allowedProcessors: readonly string[]
  clock?: () => Date
  defaultTtlMs?: number
  maxTtlMs?: number
}

export interface HealthConsentBroker {
  issue(manifest: HealthProcessingManifest, options?: { ttlMs?: number }): Promise<HealthConsentGrant>
  consume(token: string, manifest: HealthProcessingManifest): Promise<HealthConsentConsumption>
  revoke(consentId: string): Promise<HealthConsentRevocation>
}

interface ConsentRow {
  manifest_digest: string
  processor: string
  scope_json: string
  issued_at: string
  expires_at: string
  consumed_at: string | null
  revoked_at: string | null
}

interface GrantEnvelope {
  manifestDigest: string
  manifest: HealthProcessingManifest
  processor: string
  issuedAt: string
  expiresAt: string
  ttlMs: number
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function safeString(value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || Buffer.byteLength(value, 'utf8') > maxLength * 4
    || value.normalize('NFC') !== value || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')) || !pattern.test(value)) {
    throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  }
  return value
}

function assertSafeGraph(value: unknown): void {
  const seen = new Set<object>()
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    nodes += 1
    if (nodes > 512 || depth > 5) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    if (current === null || typeof current !== 'object') return
    if (seen.has(current)) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    seen.add(current)
    const prototype = Object.getPrototypeOf(current)
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    }
    const descriptors = Object.getOwnPropertyDescriptors(current)
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || POISON_KEYS.has(key)) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
      const descriptor = descriptors[key]
      if ('get' in descriptor || 'set' in descriptor) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
      if (key !== 'length') visit(descriptor.value, depth + 1)
    }
  }
  try {
    visit(value, 0)
  } catch (error) {
    if (error instanceof HealthConsentError) throw error
    throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  }
}

function ownData(object: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !('value' in descriptor)) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  return descriptor.value
}

function canonicalSet(value: unknown, pattern: RegExp, itemMax: number, countMax: number, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > countMax || (!allowEmpty && value.length === 0)) {
    throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  }
  if (Object.keys(value).length !== value.length) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  return [...new Set(value.map(item => safeString(item, pattern, itemMax)))].sort(utf8Compare)
}

function canonicalManifest(input: HealthProcessingManifest, allowedProcessors: ReadonlySet<string>, verifyArtifacts: boolean): HealthProcessingManifest {
  try {
    assertSafeGraph(input)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    const keys = Object.getOwnPropertyNames(input).sort(utf8Compare)
    if (keys.length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some(key => !keys.includes(key))) {
      throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    }
    const record = input as unknown as Record<string, unknown>
    const artifactIds = canonicalSet(ownData(record, 'artifactIds'), ARTIFACT_ID, 73, 16, false)
    const processor = safeString(ownData(record, 'processor'), /^[a-z][a-z0-9._:-]*$/, 80)
    if (!allowedProcessors.has(processor)) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    const purpose = ownData(record, 'purpose')
    if (typeof purpose !== 'string' || !(PURPOSES as readonly string[]).includes(purpose)) {
      throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    }
    const selectedRegions = canonicalSet(ownData(record, 'selectedRegions'), /^[\p{L}\p{N}._:/-]+$/u, 160, 64, true)
    const requestedFields = canonicalSet(ownData(record, 'requestedFields'), /^[a-z][a-z0-9._:-]*$/, 100, 128, false)
    const retention = ownData(record, 'retention')
    if (typeof retention !== 'string' || !(RETENTIONS as readonly string[]).includes(retention)) {
      throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    }
    const normalized: HealthProcessingManifest = {
      artifactIds, processor, purpose: purpose as HealthProcessingManifest['purpose'], selectedRegions, requestedFields, retention,
    }
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_MANIFEST_BYTES) {
      throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
    }
    if (verifyArtifacts) {
      for (const artifactId of artifactIds) {
        const match = ARTIFACT_ID.exec(artifactId)
        const artifact = match ? getTwinArtifact(match[1]) : null
        if (!artifact || artifact.id !== artifactId || artifact.sensitivity !== 'health') {
          throw new HealthConsentError('HEALTH_CONSENT_ARTIFACT_INVALID')
        }
      }
    }
    return normalized
  } catch (error) {
    if (error instanceof HealthConsentError) throw error
    throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  }
}

function manifestDigest(manifest: HealthProcessingManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function grantEnvelope(
  manifest: HealthProcessingManifest,
  digest: string,
  issuedAt: string,
  expiresAt: string,
  ttlMs: number,
): GrantEnvelope {
  return { manifestDigest: digest, manifest, processor: manifest.processor, issuedAt, expiresAt, ttlMs }
}

function grantBinding(token: string, envelope: GrantEnvelope): Buffer {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(JSON.stringify(envelope)).digest()
}

function strictUtcMillis(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null
  return milliseconds
}

function safeNow(clock: () => Date): { date: Date; iso: string } {
  try {
    const date = clock()
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('invalid clock')
    return { date, iso: date.toISOString() }
  } catch {
    throw new HealthConsentError('HEALTH_CONSENT_STORAGE_FAILED')
  }
}

function transaction<T>(callback: (db: DatabaseSync) => T): T {
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

function storedGrant(
  row: ConsentRow,
  allowedProcessors: ReadonlySet<string>,
  maxTtlMs: number,
): { tokenDigest: Buffer; grantBinding: Buffer; envelope: GrantEnvelope } | null {
  try {
    if (Buffer.byteLength(row.scope_json, 'utf8') > MAX_SCOPE_BYTES) return null
    const scope = JSON.parse(row.scope_json) as Record<string, unknown>
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || Object.getOwnPropertyNames(scope).sort(utf8Compare).join(',') !== 'expiresAt,grantBinding,issuedAt,manifest,tokenDigest,ttlMs') return null
    const storedManifest = canonicalManifest(scope.manifest as HealthProcessingManifest, allowedProcessors, false)
    if (manifestDigest(storedManifest) !== row.manifest_digest || storedManifest.processor !== row.processor
      || typeof scope.tokenDigest !== 'string' || !DIGEST.test(scope.tokenDigest)
      || typeof scope.grantBinding !== 'string' || !DIGEST.test(scope.grantBinding)
      || scope.issuedAt !== row.issued_at || scope.expiresAt !== row.expires_at
      || !Number.isSafeInteger(scope.ttlMs) || (scope.ttlMs as number) < 1 || (scope.ttlMs as number) > maxTtlMs) return null
    const issued = strictUtcMillis(scope.issuedAt)
    const expires = strictUtcMillis(scope.expiresAt)
    if (issued === null || expires === null || issued > expires || expires - issued !== scope.ttlMs) return null
    const envelope = grantEnvelope(storedManifest, row.manifest_digest, row.issued_at, row.expires_at, scope.ttlMs as number)
    return {
      tokenDigest: Buffer.from(scope.tokenDigest, 'hex'),
      grantBinding: Buffer.from(scope.grantBinding, 'hex'),
      envelope,
    }
  } catch {
    return null
  }
}

function runStorage<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof HealthConsentError) throw error
    throw new HealthConsentError('HEALTH_CONSENT_STORAGE_FAILED')
  }
}

export function createHealthConsentBroker(options: HealthConsentBrokerOptions): HealthConsentBroker {
  if (!options || !Array.isArray(options.allowedProcessors) || options.allowedProcessors.length < 1 || options.allowedProcessors.length > 32) {
    throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  }
  const allowedProcessors = new Set(options.allowedProcessors.map(value => safeString(value, /^[a-z][a-z0-9._:-]*$/, 80)))
  if (allowedProcessors.size !== options.allowedProcessors.length) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')
  const clock = options.clock ?? (() => new Date())
  const maxTtlMs = options.maxTtlMs ?? MAX_TTL_MS
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1 || maxTtlMs > MAX_TTL_MS
    || !Number.isSafeInteger(defaultTtlMs) || defaultTtlMs < 1 || defaultTtlMs > maxTtlMs) {
    throw new HealthConsentError('HEALTH_CONSENT_TTL_INVALID')
  }

  return {
    async issue(input, issueOptions = {}): Promise<HealthConsentGrant> {
      const manifest = canonicalManifest(input, allowedProcessors, true)
      const digest = manifestDigest(manifest)
      const ttlMs = issueOptions.ttlMs ?? defaultTtlMs
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtlMs) {
        throw new HealthConsentError('HEALTH_CONSENT_TTL_INVALID')
      }
      const { date, iso: issuedAt } = safeNow(clock)
      const expiresAt = new Date(date.getTime() + ttlMs).toISOString()
      const token = randomBytes(32).toString('hex')
      const digestHex = tokenDigest(token).toString('hex')
      const bindingHex = grantBinding(token, grantEnvelope(manifest, digest, issuedAt, expiresAt, ttlMs)).toString('hex')
      const scopeJson = JSON.stringify({ manifest, issuedAt, expiresAt, ttlMs, tokenDigest: digestHex, grantBinding: bindingHex })
      if (Buffer.byteLength(scopeJson, 'utf8') > MAX_SCOPE_BYTES) throw new HealthConsentError('HEALTH_CONSENT_MANIFEST_INVALID')

      runStorage(() => transaction(db => {
        const existing = db.prepare('SELECT * FROM twin_artifact_consents WHERE manifest_digest=?').get(digest) as unknown as ConsentRow | undefined
        if (!existing) {
          db.prepare(`INSERT INTO twin_artifact_consents
            (manifest_digest,processor,scope_json,issued_at,expires_at,consumed_at,revoked_at)
            VALUES(?,?,?,?,?,NULL,NULL)`).run(digest, manifest.processor, scopeJson, issuedAt, expiresAt)
          return
        }
        const terminal = existing.consumed_at !== null || existing.revoked_at !== null || existing.expires_at <= issuedAt
        if (!terminal) throw new HealthConsentError('HEALTH_CONSENT_ACTIVE')
        const result = db.prepare(`UPDATE twin_artifact_consents SET processor=?,scope_json=?,issued_at=?,expires_at=?,consumed_at=NULL,revoked_at=NULL
          WHERE manifest_digest=? AND (consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at<=?)`)
          .run(manifest.processor, scopeJson, issuedAt, expiresAt, digest, issuedAt)
        if (result.changes !== 1) throw new HealthConsentError('HEALTH_CONSENT_ACTIVE')
      }))
      return { consentId: digest, manifestDigest: digest, token, manifest, issuedAt, expiresAt }
    },

    async consume(token, input): Promise<HealthConsentConsumption> {
      const manifest = canonicalManifest(input, allowedProcessors, false)
      const digest = manifestDigest(manifest)
      const { iso: consumedAt } = safeNow(clock)
      const tokenValid = typeof token === 'string' && TOKEN.test(token)
      const suppliedDigest = tokenValid ? tokenDigest(token) : tokenDigest('invalid')
      return runStorage(() => transaction(db => {
        const row = db.prepare('SELECT * FROM twin_artifact_consents WHERE manifest_digest=?').get(digest) as unknown as ConsentRow | undefined
        const stored = row ? storedGrant(row, allowedProcessors, maxTtlMs) : null
        const comparableDigest = stored?.tokenDigest ?? Buffer.alloc(32)
        const suppliedBinding = grantBinding(tokenValid ? token : '0'.repeat(64), stored?.envelope
          ?? grantEnvelope(manifest, digest, consumedAt, consumedAt, 1))
        const comparableBinding = stored?.grantBinding ?? Buffer.alloc(32)
        const digestAuthenticated = timingSafeEqual(comparableDigest, suppliedDigest)
        const bindingAuthenticated = timingSafeEqual(comparableBinding, suppliedBinding)
        if (!row || !stored || !tokenValid || !digestAuthenticated || !bindingAuthenticated) {
          throw new HealthConsentError('HEALTH_CONSENT_INVALID')
        }
        if (row.revoked_at !== null) throw new HealthConsentError('HEALTH_CONSENT_REVOKED')
        if (row.consumed_at !== null) throw new HealthConsentError('HEALTH_CONSENT_REPLAYED')
        if (row.expires_at <= consumedAt) throw new HealthConsentError('HEALTH_CONSENT_EXPIRED')
        const result = db.prepare(`UPDATE twin_artifact_consents SET consumed_at=?
          WHERE manifest_digest=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
          .run(consumedAt, digest, consumedAt)
        if (result.changes !== 1) throw new HealthConsentError('HEALTH_CONSENT_INVALID')
        return { consentId: digest, manifestDigest: digest, consumedAt }
      }))
    },

    async revoke(consentId): Promise<HealthConsentRevocation> {
      if (typeof consentId !== 'string' || !DIGEST.test(consentId)) throw new HealthConsentError('HEALTH_CONSENT_NOT_FOUND')
      const { iso: revokedAt } = safeNow(clock)
      return runStorage(() => transaction(db => {
        const row = db.prepare('SELECT * FROM twin_artifact_consents WHERE manifest_digest=?').get(consentId) as unknown as ConsentRow | undefined
        if (!row) throw new HealthConsentError('HEALTH_CONSENT_NOT_FOUND')
        if (row.consumed_at !== null) throw new HealthConsentError('HEALTH_CONSENT_REPLAYED')
        if (row.revoked_at !== null) return { consentId, revokedAt: row.revoked_at }
        const result = db.prepare('UPDATE twin_artifact_consents SET revoked_at=? WHERE manifest_digest=? AND consumed_at IS NULL AND revoked_at IS NULL')
          .run(revokedAt, consentId)
        if (result.changes !== 1) throw new HealthConsentError('HEALTH_CONSENT_INVALID')
        return { consentId, revokedAt }
      }))
    },
  }
}
