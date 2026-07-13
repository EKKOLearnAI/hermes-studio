import { createHash } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { isProxy } from 'node:util/types'
import { withPersonalTwinDb } from './database'
import { projectObservation } from './projectors'
import {
  TwinConstraint, TwinConstraintInput, TwinConstraintListOptions,
  TwinEntity, TwinEntityInput, TwinEntityListOptions,
  TwinGoal, TwinGoalInput, TwinGoalListOptions,
  TwinIdentityConflictError, TwinRecordNotFoundError,
  TwinRelation, TwinRelationInput, TwinRelationListOptions,
  TwinEvent, TwinEventInput, TwinObservation, TwinObservationInput,
  TwinImmutableRecordConflictError, TwinProvenance, TwinDomain, TWIN_DOMAINS,
  TwinPreference, TwinPreferenceDeleteOperation, TwinPreferenceExpectation, TwinPreferenceInput,
  TwinArtifact, TwinArtifactInput,
} from './types'

type StablePart = string | number | boolean | null | undefined

interface EntityRow { id: string; type: string; label: string; attributes_json: string; source: string; source_id: string; created_at: string; updated_at: string }
interface RelationRow { id: string; subject_id: string; predicate: string; object_id: string; attributes_json: string; valid_from: string | null; valid_to: string | null; source: string; source_id: string; created_at: string; updated_at: string }
interface GoalRow { id: string; subject_id: string; domain: string; title: string; target_json: string; status: string; priority: number; starts_at: string | null; due_at: string | null; source: string; source_id: string; created_at: string; updated_at: string }
interface ConstraintRow { id: string; subject_id: string; domain: string; key: string; value_json: string; enforcement: 'hard' | 'advisory'; source: string; source_id: string; created_at: string; updated_at: string }
interface ObservationRow { id: string; entity_id: string; metric: string; value_json: string; unit: string | null; observed_at: string; ingested_at: string; source: string; source_id: string; actor: string; confidence: number; confirmation_state: TwinProvenance['confirmationState']; evidence_json: string; schema_version: number }
interface EventRow { id: string; event_type: string; subject_id: string | null; payload_json: string; occurred_at: string; ingested_at: string; source: string; source_id: string; actor: string; confidence: number; confirmation_state: TwinProvenance['confirmationState']; evidence_json: string; schema_version: number }
interface PreferenceRow { id: string; subject_id: string; key: string; value_json: string; confidence: number; source: string; source_id: string; actor: string; version: number; created_at: string; updated_at: string }
interface PreferenceOperationRow { operation_id: string; material_digest: string; kind: 'set' | 'delete'; subject_id: string; domain: string; key: string; result_snapshot_json: string; result_digest: string; status: 'applied'; created_at: string; updated_at: string }
interface ArtifactRow { id: string; media_type: string; content_hash: string; relative_path: string; size_bytes: number; sensitivity: 'health' | 'general'; metadata_json: string; source: string; source_id: string; created_at: string }

export function stableTwinId(prefix: string, parts: StablePart[]): string {
  const encoded = parts.map(part => {
    if (part === undefined) return ['undefined']
    if (part === null) return ['null']
    return [typeof part, String(part)]
  })
  const hash = createHash('sha256').update(JSON.stringify(encoded)).digest('hex').slice(0, 16)
  return `${prefix}-${hash}`
}

function nowIso(): string { return new Date().toISOString() }
function jsonString(value: unknown): string { return JSON.stringify(value ?? null) }
function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}
function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50
  return Math.max(1, Math.min(200, Math.floor(value)))
}
function escapeLike(value: string): string { return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') }
function normalizedContextDomains(domains: TwinDomain[]): TwinDomain[] {
  if (!Array.isArray(domains) || domains.some(domain => !TWIN_DOMAINS.includes(domain))) {
    throw new Error('Twin context domains contain an unsupported value')
  }
  return [...new Set(domains)].sort()
}
function contextQuery(value: string | undefined): string | null {
  const query = value?.trim().toLowerCase()
  return query ? `%${escapeLike(query)}%` : null
}
function ensureIdentityAvailable(db: DatabaseSync, id: string, source: string, sourceId: string): void {
  const row = db.prepare('SELECT source, source_id FROM twin_entities WHERE id = ?').get(id) as { source: string; source_id: string } | undefined
  if (row && (row.source !== source || row.source_id !== sourceId)) throw new TwinIdentityConflictError(`Entity id ${id} is owned by another provenance record`)
}
function validateFactInput(source: string, sourceId: string, actor: string, confidence: number, timestamp: string): void {
  if (!source.trim() || !sourceId.trim() || !actor.trim()) throw new Error('Twin fact source, sourceId, and actor are required')
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Twin fact confidence must be between 0 and 1')
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`Invalid twin fact timestamp: ${timestamp}`)
}
function provenanceFromRow(row: { source: string; source_id: string; actor: string; confidence: number; confirmation_state: TwinProvenance['confirmationState']; evidence_json: string; schema_version: number }): TwinProvenance {
  return { source: row.source, sourceId: row.source_id, actor: row.actor, confidence: row.confidence, confirmationState: row.confirmation_state, evidence: parseJson(row.evidence_json, []), schemaVersion: row.schema_version }
}
function observationFromRow(row: ObservationRow): TwinObservation {
  return { id: row.id, entityId: row.entity_id, metric: row.metric, value: parseJson(row.value_json, null), unit: row.unit, observedAt: row.observed_at, ingestedAt: row.ingested_at, provenance: provenanceFromRow(row) }
}
function eventFromRow(row: EventRow): TwinEvent {
  return { id: row.id, eventType: row.event_type, subjectId: row.subject_id, payload: parseJson(row.payload_json, {}), occurredAt: row.occurred_at, ingestedAt: row.ingested_at, provenance: provenanceFromRow(row) }
}
function outboxId(topic: string, recordId: string): string { return stableTwinId('outbox', [topic, recordId]) }
function commitOrRollback<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = operation(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}
function entityFromRow(row: EntityRow): TwinEntity {
  return { id: row.id, type: row.type, label: row.label, attributes: parseJson(row.attributes_json, {}), source: row.source, sourceId: row.source_id, createdAt: row.created_at, updatedAt: row.updated_at }
}
function relationFromRow(row: RelationRow): TwinRelation {
  return { id: row.id, subjectId: row.subject_id, predicate: row.predicate, objectId: row.object_id, attributes: parseJson(row.attributes_json, {}), validFrom: row.valid_from, validTo: row.valid_to, source: row.source, sourceId: row.source_id, createdAt: row.created_at, updatedAt: row.updated_at }
}
function goalFromRow(row: GoalRow): TwinGoal {
  return { id: row.id, subjectId: row.subject_id, domain: row.domain, title: row.title, target: parseJson(row.target_json, {}), status: row.status, priority: row.priority, startsAt: row.starts_at, dueAt: row.due_at, source: row.source, sourceId: row.source_id, createdAt: row.created_at, updatedAt: row.updated_at }
}
function constraintFromRow(row: ConstraintRow): TwinConstraint {
  return { id: row.id, subjectId: row.subject_id, domain: row.domain, key: row.key, value: parseJson(row.value_json, null), enforcement: row.enforcement, source: row.source, sourceId: row.source_id, createdAt: row.created_at, updatedAt: row.updated_at }
}

function canonicalArtifactMetadataJson(metadata: Record<string, unknown>): string {
  try {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid')
    return canonicalPreferenceJson(metadata, true)
  } catch {
    throw new Error('Twin artifact metadata is invalid or exceeds structural bounds')
  }
}

function artifactFromRow(row: ArtifactRow): TwinArtifact {
  const metadata = parseJson<unknown>(row.metadata_json, null)
  const material: TwinArtifactInput = {
    mediaType: row.media_type,
    contentHash: row.content_hash,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    sensitivity: row.sensitivity,
    metadata: metadata as Record<string, unknown>,
    source: row.source,
    sourceId: row.source_id,
  }
  const safeMetadataJson = validateArtifactInput(material).metadataJson
  return {
    id: row.id,
    ...material,
    metadata: JSON.parse(safeMetadataJson) as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

function preferenceStorageKey(domain: TwinDomain, key: string): string { return `${domain}:${key}` }
function preferenceFromRow(row: PreferenceRow): TwinPreference {
  const separator = row.key.indexOf(':')
  if (separator < 1) throw new Error('Twin preference has an invalid canonical key')
  return {
    id: row.id, subjectId: row.subject_id, domain: row.key.slice(0, separator) as TwinDomain,
    key: row.key.slice(separator + 1), value: parseJson(row.value_json, null),
    provenance: { source: row.source, sourceId: row.source_id, actor: row.actor, confidence: row.confidence },
    version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function canonicalPreferenceJson(value: unknown, rejectPoisonKeys = false): string {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): string => {
    nodes += 1
    if (nodes > 256 || depth > 6) throw new Error('Twin preference value exceeds structural bounds')
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'string') {
      if (isSensitivePreferenceText(item)) throw new Error('Twin preference value is sensitive')
      return JSON.stringify(item)
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Twin preference value must contain finite JSON numbers')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || item === null || isProxy(item)) throw new Error('Twin preference value must be schema-safe JSON')
    if (seen.has(item)) throw new Error('Twin preference value must not contain cycles')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('Twin preference value must be schema-safe JSON')
    }
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        if (item.length > 64) throw new Error('Twin preference value exceeds array bounds')
        const ownKeys = Reflect.ownKeys(item)
        if (ownKeys.some(key => typeof key === 'symbol'
          || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
          throw new Error('Twin preference value must be schema-safe JSON')
        }
        const values: string[] = []
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Twin preference value must be schema-safe JSON')
          values.push(visit(descriptor.value, depth + 1))
        }
        return `[${values.join(',')}]`
      }
      const record = item as Record<string, unknown>
      const ownKeys = Reflect.ownKeys(record)
      if (ownKeys.some(key => typeof key !== 'string')) throw new Error('Twin preference value must be schema-safe JSON')
      const keys = ownKeys.sort() as string[]
      if (keys.length > 64) throw new Error('Twin preference value exceeds object bounds')
      return `{${keys.map(key => {
        if (rejectPoisonKeys && (key === '__proto__' || key === 'constructor' || key === 'prototype')) {
          throw new Error('Twin preference value contains a poison key')
        }
        if (key.length > 160) throw new Error('Twin preference value key is too long')
        if (isSensitivePreferenceText(key)) throw new Error('Twin preference value key is sensitive')
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Twin preference value must be schema-safe JSON')
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`
      }).join(',')}}`
    } finally { seen.delete(item) }
  }
  const encoded = visit(value, 0)
  if (Buffer.byteLength(encoded, 'utf8') > 8_192) throw new Error('Twin preference value exceeds 8192 bytes')
  return encoded
}

function isSensitivePreferenceText(value: string): boolean {
  return /(?:password|passwd|secret|api.?key|credential|authorization|cookie|session|private.?key)/i.test(value)
    || /\btoken\s*[:=]/i.test(value)
    || /(?:^|\s)bearer\s+[a-z0-9._-]+/i.test(value)
    || /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/.test(value)
    || /\b(?:sk|pk)-[a-zA-Z0-9_-]{16,}\b/.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
}

function validatePreferenceAddress(subjectId: string, domain: TwinDomain, key: string): void {
  if (typeof subjectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i.test(subjectId)) {
    throw new Error('Twin preference subject ID is invalid')
  }
  if (!TWIN_DOMAINS.includes(domain)) throw new Error('Twin preference domain is unsupported')
  if (typeof key === 'string' && (key.startsWith('_') || /^(?:system|internal|admin)\./i.test(key))) {
    throw new Error('Twin preference key is reserved')
  }
  if (typeof key !== 'string' || key.length < 1 || key.length > 160 || !/^[a-z0-9][a-z0-9._-]*$/i.test(key)) {
    throw new Error('Twin preference key is invalid')
  }
  if (/(?:password|passwd|secret|token|api.?key|credential|authorization|cookie|session|private.?key)/i.test(key)) {
    throw new Error('Twin preference key is sensitive')
  }
}

function validatePreferenceOperation(operation: { source: string; sourceId: string; actor: string; operationId?: string }): void {
  if (!/^[a-z][a-z0-9._:-]{0,159}$/i.test(operation.source)
    || !/^[a-z][a-z0-9._:-]{0,159}$/i.test(operation.actor)) throw new Error('Twin preference source and actor are invalid')
  if (typeof operation.sourceId !== 'string' || operation.sourceId.length < 1 || operation.sourceId.length > 500
    || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(operation.sourceId) || isSensitivePreferenceText(operation.sourceId)) {
    throw new Error('Twin preference sourceId is invalid')
  }
  if (operation.operationId !== undefined && (operation.operationId.length < 1 || operation.operationId.length > 500
    || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(operation.operationId) || isSensitivePreferenceText(operation.operationId))) {
    throw new Error('Twin preference operationId is invalid')
  }
}

function preferenceOperationAggregate(source: string, operationToken: string): string {
  const digest = createHash('sha256').update(source, 'utf8').update('\0', 'utf8')
    .update(operationToken, 'utf8').digest('hex')
  return `preference-operation-${digest}`
}

function preferenceMaterialDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function preferenceSnapshot(preference: TwinPreference | null): Record<string, unknown> {
  return preference === null ? { state: 'absent' } : { state: 'present', preference }
}

function preferenceSnapshotDigest(preference: TwinPreference | null): string {
  return preferenceMaterialDigest(preferenceSnapshot(preference))
}

export function twinPreferenceExpectation(preference: TwinPreference | null): TwinPreferenceExpectation {
  return preference === null ? { state: 'absent' } : {
    state: 'present', version: preference.version, digest: preferenceSnapshotDigest(preference),
  }
}

function assertExpectedPreference(current: TwinPreference | null, expected: TwinPreferenceExpectation | undefined): void {
  if (expected === undefined) return
  if (expected.state !== 'absent' && (expected.state !== 'present' || !Number.isSafeInteger(expected.version)
    || expected.version < 1 || !/^[a-f0-9]{64}$/.test(expected.digest))) throw new Error('TWIN_PREFERENCE_EXPECTATION_INVALID')
  const matches = expected.state === 'absent'
    ? current === null
    : current !== null && current.version === expected.version && preferenceSnapshotDigest(current) === expected.digest
  if (!matches) throw new Error('TWIN_PREFERENCE_CONFLICT')
}

function parseOperationResult(row: PreferenceOperationRow): TwinPreference | null {
  const snapshot = parseJson<{ state?: unknown; preference?: unknown }>(row.result_snapshot_json, {})
  if (snapshot.state === 'absent') return null
  if (snapshot.state !== 'present' || !snapshot.preference || typeof snapshot.preference !== 'object') {
    throw new Error('TWIN_PREFERENCE_OPERATION_CORRUPT')
  }
  return snapshot.preference as TwinPreference
}

function replayPreferenceOperation(
  row: PreferenceOperationRow,
  materialDigest: string,
  current: TwinPreference | null,
): TwinPreference | null {
  if (row.material_digest !== materialDigest) throw new Error('TWIN_PREFERENCE_OPERATION_CONFLICT')
  const recorded = parseOperationResult(row)
  if (row.result_digest !== preferenceSnapshotDigest(recorded)
    || preferenceSnapshotDigest(current) !== row.result_digest) throw new Error('TWIN_PREFERENCE_OPERATION_STALE')
  return recorded
}

function insertPreferenceOperation(
  db: DatabaseSync,
  operationId: string,
  materialDigest: string,
  kind: 'set' | 'delete',
  address: { subjectId: string; domain: TwinDomain; key: string },
  result: TwinPreference | null,
  timestamp: string,
): void {
  const snapshot = JSON.stringify(preferenceSnapshot(result))
  if (Buffer.byteLength(snapshot, 'utf8') > 12_000) throw new Error('TWIN_PREFERENCE_OPERATION_RESULT_TOO_LARGE')
  db.prepare(`INSERT INTO twin_preference_operations(operation_id,material_digest,kind,subject_id,domain,key,
    result_snapshot_json,result_digest,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'applied',?,?)`).run(
    operationId, materialDigest, kind, address.subjectId, address.domain, address.key, snapshot,
    preferenceSnapshotDigest(result), timestamp, timestamp,
  )
}

export function getTwinPreference(subjectId: string, domain: TwinDomain, key: string): TwinPreference | null {
  validatePreferenceAddress(subjectId, domain, key)
  return withPersonalTwinDb(db => {
    const row = db.prepare('SELECT * FROM twin_preferences WHERE subject_id=? AND key=?')
      .get(subjectId, preferenceStorageKey(domain, key)) as PreferenceRow | undefined
    return row ? preferenceFromRow(row) : null
  })
}

export function setTwinPreference(input: TwinPreferenceInput): TwinPreference {
  validatePreferenceAddress(input.subjectId, input.domain, input.key)
  validatePreferenceOperation(input)
  const confidence = input.confidence ?? 1
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Twin preference confidence must be between 0 and 1')
  const valueJson = canonicalPreferenceJson(input.value)
  return withPersonalTwinDb(db => commitOrRollback(db, () => {
    requireEntity(db, input.subjectId)
    const storageKey = preferenceStorageKey(input.domain, input.key)
    const aggregateId = preferenceOperationAggregate(input.source, input.operationId ?? input.sourceId)
    const currentRow = db.prepare('SELECT * FROM twin_preferences WHERE subject_id=? AND key=?')
      .get(input.subjectId, storageKey) as PreferenceRow | undefined
    const current = currentRow ? preferenceFromRow(currentRow) : null
    const materialDigest = preferenceMaterialDigest({ subjectId: input.subjectId, domain: input.domain, key: input.key,
      valueJson, source: input.source, sourceId: input.sourceId, actor: input.actor, confidence,
      expectedCurrent: input.expectedCurrent ?? null })
    const operation = db.prepare('SELECT * FROM twin_preference_operations WHERE operation_id=?')
      .get(aggregateId) as unknown as PreferenceOperationRow | undefined
    if (operation) {
      const replay = replayPreferenceOperation(operation, materialDigest, current)
      if (!replay) throw new Error('TWIN_PREFERENCE_OPERATION_CORRUPT')
      return replay
    }
    assertExpectedPreference(current, input.expectedCurrent)
    const operationOwner = db.prepare('SELECT subject_id,key FROM twin_preferences WHERE source=? AND source_id=?')
      .get(input.source, input.sourceId) as { subject_id: string; key: string } | undefined
    if (operationOwner && (operationOwner.subject_id !== input.subjectId || operationOwner.key !== storageKey)) {
      throw new TwinImmutableRecordConflictError('Twin preference operation token is bound to different material')
    }
    const timestamp = nowIso()
    const id = currentRow?.id ?? stableTwinId('preference', [input.subjectId, storageKey])
    const version = (currentRow?.version ?? 0) + 1
    db.prepare(`INSERT INTO twin_preferences(id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,
      confidence=excluded.confidence,source=excluded.source,source_id=excluded.source_id,actor=excluded.actor,
      version=excluded.version,updated_at=excluded.updated_at`)
      .run(id, input.subjectId, storageKey, valueJson, confidence, input.source, input.sourceId,
        input.actor, version, currentRow?.created_at ?? timestamp, timestamp)
    const result = preferenceFromRow(db.prepare('SELECT * FROM twin_preferences WHERE id=?').get(id) as unknown as PreferenceRow)
    insertPreferenceOperation(db, aggregateId, materialDigest, 'set', input, result, timestamp)
    db.prepare(`INSERT INTO twin_outbox(id,topic,aggregate_id,payload_json,status,available_at,created_at)
      VALUES(?,?,?,?,'pending',?,?)`).run(
      outboxId('twin.preference.set', aggregateId), 'twin.preference.set', aggregateId,
      jsonString({ recordId: id, subjectId: input.subjectId, domain: input.domain, key: input.key,
        source: input.source, sourceId: input.sourceId, actor: input.actor, materialDigest }), timestamp, timestamp,
    )
    return result
  }))
}

export function deleteTwinPreference(
  subjectId: string,
  domain: TwinDomain,
  key: string,
  operation?: TwinPreferenceDeleteOperation,
): void {
  validatePreferenceAddress(subjectId, domain, key)
  if (operation) validatePreferenceOperation(operation)
  withPersonalTwinDb(db => commitOrRollback(db, () => {
    requireEntity(db, subjectId)
    const storageKey = preferenceStorageKey(domain, key)
    const currentRow = db.prepare('SELECT * FROM twin_preferences WHERE subject_id=? AND key=?')
      .get(subjectId, storageKey) as PreferenceRow | undefined
    const current = currentRow ? preferenceFromRow(currentRow) : null
    if (!current && !operation) return
    const actual = operation ?? { source: 'action-fabric' as const,
      sourceId: `delete:${subjectId}:${storageKey}:${current!.updatedAt}`, actor: 'action-fabric' as const }
    const aggregateId = preferenceOperationAggregate(actual.source, actual.sourceId)
    const materialDigest = preferenceMaterialDigest({ subjectId, domain, key, source: actual.source,
      sourceId: actual.sourceId, actor: actual.actor, expectedCurrent: actual.expectedCurrent ?? null })
    const existingOperation = db.prepare('SELECT * FROM twin_preference_operations WHERE operation_id=?')
      .get(aggregateId) as unknown as PreferenceOperationRow | undefined
    if (existingOperation) {
      replayPreferenceOperation(existingOperation, materialDigest, current)
      return
    }
    assertExpectedPreference(current, actual.expectedCurrent)
    db.prepare('DELETE FROM twin_preferences WHERE subject_id=? AND key=?').run(subjectId, storageKey)
    const timestamp = nowIso()
    insertPreferenceOperation(db, aggregateId, materialDigest, 'delete', { subjectId, domain, key }, null, timestamp)
    db.prepare(`INSERT INTO twin_outbox(id,topic,aggregate_id,payload_json,status,available_at,created_at)
      VALUES(?,?,?,?,'pending',?,?)`).run(
      outboxId('twin.preference.deleted', aggregateId), 'twin.preference.deleted', aggregateId,
      jsonString({ recordId: current?.id ?? null, subjectId, domain, key, source: actual.source, sourceId: actual.sourceId }),
      timestamp, timestamp,
    )
  }))
}

function validateArtifactInput(input: TwinArtifactInput): { contentHash: string; metadataJson: string } {
  if (typeof input.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.contentHash)) {
    throw new Error('Twin artifact content hash must be a lowercase SHA-256 digest')
  }
  if (typeof input.mediaType !== 'string' || input.mediaType.length > 129
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(input.mediaType)) {
    throw new Error('Twin artifact media type is invalid')
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > 10 * 1024 * 1024 * 1024) {
    throw new Error('Twin artifact size is invalid')
  }
  if (typeof input.relativePath !== 'string' || input.relativePath.length < 1
    || Buffer.byteLength(input.relativePath, 'utf8') > 512 || input.relativePath.includes('\\')
    || input.relativePath.startsWith('/') || input.relativePath.includes('//')) {
    throw new Error('Twin artifact relative path is invalid')
  }
  const pathSegments = input.relativePath.split('/')
  if (pathSegments.some(segment => segment === '.' || segment === '..' || segment.length > 128
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(segment))) {
    throw new Error('Twin artifact relative path is invalid')
  }
  if (input.sensitivity !== 'health' && input.sensitivity !== 'general') {
    throw new Error('Twin artifact sensitivity is invalid')
  }
  if (typeof input.source !== 'string' || !/^[a-z][a-z0-9._:-]{0,159}$/i.test(input.source)) {
    throw new Error('Twin artifact source is invalid')
  }
  if (typeof input.sourceId !== 'string' || input.sourceId.length < 1 || input.sourceId.length > 500
    || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(input.sourceId) || isSensitivePreferenceText(input.sourceId)) {
    throw new Error('Twin artifact sourceId is invalid')
  }
  return { contentHash: input.contentHash, metadataJson: canonicalArtifactMetadataJson(input.metadata) }
}

function artifactMatches(row: ArtifactRow, input: TwinArtifactInput, metadataJson: string): boolean {
  return row.media_type === input.mediaType
    && row.content_hash === input.contentHash
    && row.relative_path === input.relativePath
    && row.size_bytes === input.sizeBytes
    && row.sensitivity === input.sensitivity
    && row.metadata_json === metadataJson
    && row.source === input.source
    && row.source_id === input.sourceId
}

function preflightTwinArtifactInDb(
  db: DatabaseSync,
  input: TwinArtifactInput,
  metadataJson: string,
): TwinArtifact | null {
  const byHash = db.prepare('SELECT * FROM twin_artifacts WHERE content_hash = ?').get(input.contentHash) as unknown as ArtifactRow | undefined
  const sourceMatches = db.prepare('SELECT * FROM twin_artifacts WHERE source = ? AND source_id = ? ORDER BY id LIMIT 2')
    .all(input.source, input.sourceId) as unknown as ArtifactRow[]
  if (sourceMatches.length > 1) throw new TwinImmutableRecordConflictError('Twin artifact source identity is ambiguous')
  const bySource = sourceMatches[0]
  const existing = byHash ?? bySource
  if (!existing) return null
  if ((byHash && bySource && byHash.id !== bySource.id) || !artifactMatches(existing, input, metadataJson)) {
    throw new TwinImmutableRecordConflictError('Twin artifact identity already contains different material')
  }
  return artifactFromRow(existing)
}

export function preflightTwinArtifact(input: TwinArtifactInput): TwinArtifact | null {
  const { metadataJson } = validateArtifactInput(input)
  return withPersonalTwinDb(db => preflightTwinArtifactInDb(db, input, metadataJson))
}

export function upsertTwinArtifact(input: TwinArtifactInput): TwinArtifact {
  const { contentHash, metadataJson } = validateArtifactInput(input)
  return withPersonalTwinDb(db => commitOrRollback(db, () => {
    const existing = preflightTwinArtifactInDb(db, input, metadataJson)
    if (existing) return existing
    const id = `artifact-${contentHash}`
    const createdAt = nowIso()
    db.prepare(`
      INSERT INTO twin_artifacts
        (id,media_type,content_hash,relative_path,size_bytes,source,source_id,created_at,sensitivity,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, input.mediaType, contentHash, input.relativePath, input.sizeBytes, input.source, input.sourceId,
      createdAt, input.sensitivity, metadataJson)
    return artifactFromRow(db.prepare('SELECT * FROM twin_artifacts WHERE id = ?').get(id) as unknown as ArtifactRow)
  }))
}

export function getTwinArtifact(contentHash: string): TwinArtifact | null {
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error('Twin artifact content hash must be a lowercase SHA-256 digest')
  }
  return withPersonalTwinDb(db => {
    const row = db.prepare('SELECT * FROM twin_artifacts WHERE content_hash = ?').get(contentHash) as unknown as ArtifactRow | undefined
    return row ? artifactFromRow(row) : null
  })
}

export function upsertTwinEntity(input: TwinEntityInput): TwinEntity {
  return withPersonalTwinDb(db => upsertTwinEntityInDb(db, input))
}

function upsertTwinEntityInDb(db: DatabaseSync, input: TwinEntityInput): TwinEntity {
  if (!input.source.trim() || !input.sourceId.trim()) throw new Error('Twin entity source and sourceId are required')
  if (input.id === 'person:self' && (input.source !== 'system' || input.sourceId !== 'self')) throw new TwinIdentityConflictError('person:self is reserved for the canonical system identity')
  const existing = db.prepare('SELECT id, attributes_json FROM twin_entities WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as { id: string; attributes_json: string } | undefined
  const id = existing?.id || input.id || stableTwinId('entity', [input.source, input.sourceId])
  if (existing && input.id && existing.id !== input.id) throw new TwinIdentityConflictError(`Provenance ${input.source}/${input.sourceId} already owns ${existing.id}`)
  ensureIdentityAvailable(db, id, input.source, input.sourceId)
  const timestamp = nowIso()
  db.prepare(`
    INSERT INTO twin_entities (id, type, label, attributes_json, source, source_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      type = excluded.type, label = excluded.label, attributes_json = excluded.attributes_json, updated_at = excluded.updated_at
  `).run(
    id,
    input.type,
    input.label,
    input.attributes === undefined && existing ? existing.attributes_json : jsonString(input.attributes || {}),
    input.source,
    input.sourceId,
    timestamp,
    timestamp,
  )
  return entityFromRow(db.prepare('SELECT * FROM twin_entities WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as unknown as EntityRow)
}

export function getTwinEntity(id: string): TwinEntity | null {
  return withPersonalTwinDb(db => {
    const row = db.prepare('SELECT * FROM twin_entities WHERE id = ?').get(id) as EntityRow | undefined
    return row ? entityFromRow(row) : null
  })
}

export function listTwinEntities(options: TwinEntityListOptions = {}): TwinEntity[] {
  return withPersonalTwinDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.type !== undefined) { clauses.push('type = ?'); values.push(options.type) }
    if (options.source !== undefined) { clauses.push('source = ?'); values.push(options.source) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`SELECT * FROM twin_entities ${where} ORDER BY datetime(updated_at) DESC, id DESC LIMIT ?`).all(...values, clampLimit(options.limit)) as unknown as EntityRow[]).map(entityFromRow)
  })
}

export function listTwinEntitiesForContext(options: { domains: TwinDomain[]; query?: string; limit?: number }): TwinEntity[] {
  return withPersonalTwinDb(db => {
    const domains = normalizedContextDomains(options.domains)
    if (domains.length === 0) return []
    const placeholders = domains.map(() => '?').join(', ')
    const query = contextQuery(options.query)
    const clauses = [`LOWER(type) IN (${placeholders})`]
    const values: Array<string | number> = [...domains]
    if (query) {
      clauses.push("LOWER(id || ' ' || label || ' ' || attributes_json) LIKE ? ESCAPE '\\'")
      values.push(query)
    }
    return (db.prepare(`
      SELECT * FROM twin_entities WHERE ${clauses.join(' AND ')}
      ORDER BY datetime(updated_at) DESC, id DESC LIMIT ?
    `).all(...values, clampLimit(options.limit)) as unknown as EntityRow[]).map(entityFromRow)
  })
}

function requireEntity(db: DatabaseSync, id: string): void {
  if (!db.prepare('SELECT 1 FROM twin_entities WHERE id = ?').get(id)) throw new TwinRecordNotFoundError(`Twin entity not found: ${id}`)
}

export function upsertTwinRelation(input: TwinRelationInput): TwinRelation {
  return withPersonalTwinDb(db => {
    requireEntity(db, input.subjectId); requireEntity(db, input.objectId)
    const existing = db.prepare('SELECT id FROM twin_relations WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as { id: string } | undefined
    const id = existing?.id || input.id || stableTwinId('relation', [input.source, input.sourceId])
    if (existing && input.id && existing.id !== input.id) throw new TwinIdentityConflictError(`Provenance ${input.source}/${input.sourceId} already owns ${existing.id}`)
    const byId = db.prepare('SELECT source, source_id FROM twin_relations WHERE id = ?').get(id) as { source: string; source_id: string } | undefined
    if (byId && (byId.source !== input.source || byId.source_id !== input.sourceId)) throw new TwinIdentityConflictError(`Relation id ${id} is owned by another provenance record`)
    const timestamp = nowIso()
    db.prepare(`
      INSERT INTO twin_relations (id, subject_id, predicate, object_id, attributes_json, valid_from, valid_to, source, source_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_id) DO UPDATE SET subject_id=excluded.subject_id, predicate=excluded.predicate, object_id=excluded.object_id, attributes_json=excluded.attributes_json, valid_from=excluded.valid_from, valid_to=excluded.valid_to, updated_at=excluded.updated_at
    `).run(id, input.subjectId, input.predicate, input.objectId, jsonString(input.attributes || {}), input.validFrom ?? null, input.validTo ?? null, input.source, input.sourceId, timestamp, timestamp)
    return relationFromRow(db.prepare('SELECT * FROM twin_relations WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as unknown as RelationRow)
  })
}

export function listTwinRelations(options: TwinRelationListOptions = {}): TwinRelation[] {
  return withPersonalTwinDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.subjectId !== undefined) { clauses.push('subject_id = ?'); values.push(options.subjectId) }
    if (options.predicate !== undefined) { clauses.push('predicate = ?'); values.push(options.predicate) }
    if (options.objectId !== undefined) { clauses.push('object_id = ?'); values.push(options.objectId) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`SELECT * FROM twin_relations ${where} ORDER BY datetime(updated_at) DESC, id DESC LIMIT ?`).all(...values, clampLimit(options.limit)) as unknown as RelationRow[]).map(relationFromRow)
  })
}

export function listTwinRelationsForContext(options: { domains: TwinDomain[]; query?: string; limit?: number }): TwinRelation[] {
  return withPersonalTwinDb(db => {
    const domains = normalizedContextDomains(options.domains)
    if (domains.length === 0) return []
    const domainClauses = domains.map(() => "LOWER(r.predicate) LIKE ? ESCAPE '\\'")
    const values: Array<string | number> = domains.map(domain => `${escapeLike(domain)}.%`)
    const entityPlaceholders = domains.map(() => '?').join(', ')
    domainClauses.push(`LOWER(COALESCE(subject.type, '')) IN (${entityPlaceholders})`)
    values.push(...domains)
    domainClauses.push(`LOWER(COALESCE(object.type, '')) IN (${entityPlaceholders})`)
    values.push(...domains)
    const clauses = [`(${domainClauses.join(' OR ')})`]
    const query = contextQuery(options.query)
    if (query) {
      clauses.push("LOWER(r.id || ' ' || r.predicate || ' ' || r.attributes_json || ' ' || COALESCE(subject.label, '') || ' ' || COALESCE(object.label, '')) LIKE ? ESCAPE '\\'")
      values.push(query)
    }
    return (db.prepare(`
      SELECT r.* FROM twin_relations r
      LEFT JOIN twin_entities subject ON subject.id = r.subject_id
      LEFT JOIN twin_entities object ON object.id = r.object_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY datetime(r.updated_at) DESC, r.id DESC LIMIT ?
    `).all(...values, clampLimit(options.limit)) as unknown as RelationRow[]).map(relationFromRow)
  })
}

export function upsertTwinGoal(input: TwinGoalInput): TwinGoal {
  return withPersonalTwinDb(db => {
    requireEntity(db, input.subjectId)
    const existing = db.prepare('SELECT id FROM twin_goals WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as { id: string } | undefined
    const id = existing?.id || input.id || stableTwinId('goal', [input.source, input.sourceId])
    if (existing && input.id && existing.id !== input.id) throw new TwinIdentityConflictError(`Provenance ${input.source}/${input.sourceId} already owns ${existing.id}`)
    const timestamp = nowIso()
    db.prepare(`
      INSERT INTO twin_goals (id, subject_id, domain, title, target_json, status, priority, starts_at, due_at, source, source_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_id) DO UPDATE SET subject_id=excluded.subject_id, domain=excluded.domain, title=excluded.title, target_json=excluded.target_json, status=excluded.status, priority=excluded.priority, starts_at=excluded.starts_at, due_at=excluded.due_at, updated_at=excluded.updated_at
    `).run(id, input.subjectId, input.domain, input.title, jsonString(input.target), input.status, input.priority, input.startsAt ?? null, input.dueAt ?? null, input.source, input.sourceId, timestamp, timestamp)
    return goalFromRow(db.prepare('SELECT * FROM twin_goals WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as unknown as GoalRow)
  })
}

export function listTwinGoals(options: TwinGoalListOptions = {}): TwinGoal[] {
  return withPersonalTwinDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.subjectId !== undefined) { clauses.push('subject_id = ?'); values.push(options.subjectId) }
    if (options.domain !== undefined) { clauses.push('domain = ?'); values.push(options.domain) }
    if (options.status !== undefined) { clauses.push('status = ?'); values.push(options.status) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`SELECT * FROM twin_goals ${where} ORDER BY priority DESC, datetime(updated_at) DESC, id DESC LIMIT ?`).all(...values, clampLimit(options.limit)) as unknown as GoalRow[]).map(goalFromRow)
  })
}

export function listTwinGoalsForContext(options: { domains: TwinDomain[]; query?: string; limit?: number }): TwinGoal[] {
  return withPersonalTwinDb(db => {
    const domains = normalizedContextDomains(options.domains)
    if (domains.length === 0) return []
    const clauses = [`LOWER(domain) IN (${domains.map(() => '?').join(', ')})`]
    const values: Array<string | number> = [...domains]
    const query = contextQuery(options.query)
    if (query) {
      clauses.push("LOWER(title || ' ' || target_json || ' ' || status) LIKE ? ESCAPE '\\'")
      values.push(query)
    }
    return (db.prepare(`
      SELECT * FROM twin_goals WHERE ${clauses.join(' AND ')}
      ORDER BY priority DESC, datetime(updated_at) DESC, id DESC LIMIT ?
    `).all(...values, clampLimit(options.limit)) as unknown as GoalRow[]).map(goalFromRow)
  })
}

export function upsertTwinConstraint(input: TwinConstraintInput): TwinConstraint {
  return withPersonalTwinDb(db => {
    requireEntity(db, input.subjectId)
    const existing = db.prepare('SELECT id FROM twin_constraints WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as { id: string } | undefined
    const id = existing?.id || input.id || stableTwinId('constraint', [input.source, input.sourceId])
    if (existing && input.id && existing.id !== input.id) throw new TwinIdentityConflictError(`Provenance ${input.source}/${input.sourceId} already owns ${existing.id}`)
    const timestamp = nowIso()
    db.prepare(`
      INSERT INTO twin_constraints (id, subject_id, domain, key, value_json, enforcement, source, source_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_id) DO UPDATE SET subject_id=excluded.subject_id, domain=excluded.domain, key=excluded.key, value_json=excluded.value_json, enforcement=excluded.enforcement, updated_at=excluded.updated_at
    `).run(id, input.subjectId, input.domain, input.key, jsonString(input.value), input.enforcement, input.source, input.sourceId, timestamp, timestamp)
    return constraintFromRow(db.prepare('SELECT * FROM twin_constraints WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as unknown as ConstraintRow)
  })
}

export function listTwinConstraints(options: TwinConstraintListOptions = {}): TwinConstraint[] {
  return withPersonalTwinDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.subjectId !== undefined) { clauses.push('subject_id = ?'); values.push(options.subjectId) }
    if (options.domain !== undefined) { clauses.push('domain = ?'); values.push(options.domain) }
    if (options.key !== undefined) { clauses.push('key = ?'); values.push(options.key) }
    if (options.enforcement !== undefined) { clauses.push('enforcement = ?'); values.push(options.enforcement) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`SELECT * FROM twin_constraints ${where} ORDER BY datetime(updated_at) DESC, id DESC LIMIT ?`).all(...values, clampLimit(options.limit)) as unknown as ConstraintRow[]).map(constraintFromRow)
  })
}

export function listTwinConstraintsForContext(options: { domains: TwinDomain[]; query?: string; limit?: number }): TwinConstraint[] {
  return withPersonalTwinDb(db => {
    const domains = normalizedContextDomains(options.domains)
    if (domains.length === 0) return []
    const clauses = [`LOWER(domain) IN (${domains.map(() => '?').join(', ')})`]
    const values: Array<string | number> = [...domains]
    const query = contextQuery(options.query)
    if (query) {
      clauses.push("LOWER(key || ' ' || value_json || ' ' || enforcement) LIKE ? ESCAPE '\\'")
      values.push(query)
    }
    return (db.prepare(`
      SELECT * FROM twin_constraints WHERE ${clauses.join(' AND ')}
      ORDER BY datetime(updated_at) DESC, id DESC LIMIT ?
    `).all(...values, clampLimit(options.limit)) as unknown as ConstraintRow[]).map(constraintFromRow)
  })
}

export function recordTwinObservation(input: TwinObservationInput): TwinObservation {
  validateFactInput(input.source, input.sourceId, input.actor, input.confidence, input.observedAt)
  return withPersonalTwinDb(db => commitOrRollback(db, () => recordTwinObservationInDb(db, input)))
}

function recordTwinObservationInDb(db: DatabaseSync, input: TwinObservationInput): TwinObservation {
  validateFactInput(input.source, input.sourceId, input.actor, input.confidence, input.observedAt)
  requireEntity(db, input.entityId)
  const id = stableTwinId('observation', [input.source, input.sourceId, input.metric])
  const ingestedAt = nowIso()
  const evidence = input.evidence || []
  const result = db.prepare(`
    INSERT INTO twin_observations (id, entity_id, metric, value_json, unit, observed_at, ingested_at, source, source_id, actor, confidence, confirmation_state, evidence_json, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id, metric) DO NOTHING
  `).run(id, input.entityId, input.metric, jsonString(input.value), input.unit ?? null, input.observedAt, ingestedAt, input.source, input.sourceId, input.actor, input.confidence, input.confirmationState, jsonString(evidence), 1)
  const existing = db.prepare('SELECT * FROM twin_observations WHERE source = ? AND source_id = ? AND metric = ?').get(input.source, input.sourceId, input.metric) as unknown as ObservationRow
  if (Number(result.changes) === 0 && (
    existing.entity_id !== input.entityId || existing.value_json !== jsonString(input.value) || existing.unit !== (input.unit ?? null) || existing.observed_at !== input.observedAt || existing.actor !== input.actor || existing.confidence !== input.confidence || existing.confirmation_state !== input.confirmationState || existing.evidence_json !== jsonString(evidence)
  )) throw new TwinImmutableRecordConflictError(`Observation ${input.source}/${input.sourceId}/${input.metric} already contains different data`)
  if (Number(result.changes) === 1) {
    db.prepare(`INSERT INTO twin_outbox (id, topic, aggregate_id, payload_json, status, available_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
      .run(outboxId('twin.observation.recorded', id), 'twin.observation.recorded', id, jsonString({ recordId: id, metric: input.metric, source: input.source, sourceId: input.sourceId }), ingestedAt, ingestedAt)
  }
  const observation = observationFromRow(existing)
  if (Number(result.changes) === 1) projectObservation(db, observation)
  return observation
}

export function listTwinObservations(options: { entityId?: string; metric?: string; metricPrefixes?: string[]; query?: string; limit?: number } = {}): TwinObservation[] {
  return withPersonalTwinDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.entityId !== undefined) { clauses.push('o.entity_id = ?'); values.push(options.entityId) }
    if (options.metric !== undefined) { clauses.push('o.metric = ?'); values.push(options.metric) }
    if (options.metricPrefixes?.length) {
      clauses.push(`(${options.metricPrefixes.map(() => "o.metric LIKE ? ESCAPE '\\'").join(' OR ')})`)
      values.push(...options.metricPrefixes.map(prefix => `${escapeLike(prefix)}%`))
    }
    const query = options.query?.trim()
    if (query) {
      clauses.push("LOWER(COALESCE(e.label, '') || ' ' || o.metric || ' ' || o.value_json) LIKE ? ESCAPE '\\'")
      values.push(`%${escapeLike(query.toLowerCase())}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`
      SELECT o.* FROM twin_observations o
      LEFT JOIN twin_entities e ON e.id = o.entity_id
      ${where}
      ORDER BY julianday(o.observed_at) DESC, julianday(o.ingested_at) DESC, o.id DESC LIMIT ?
    `).all(...values, clampLimit(options.limit)) as unknown as ObservationRow[]).map(observationFromRow)
  })
}

export function recordTwinEvent(input: TwinEventInput): TwinEvent {
  validateFactInput(input.source, input.sourceId, input.actor, input.confidence, input.occurredAt)
  return withPersonalTwinDb(db => commitOrRollback(db, () => recordTwinEventInDb(db, input)))
}

function recordTwinEventInDb(db: DatabaseSync, input: TwinEventInput): TwinEvent {
  validateFactInput(input.source, input.sourceId, input.actor, input.confidence, input.occurredAt)
  if (input.subjectId) requireEntity(db, input.subjectId)
  const id = stableTwinId('event', [input.source, input.sourceId, input.eventType])
  const ingestedAt = nowIso()
  const evidence = input.evidence || []
  const payload = input.payload || {}
  const result = db.prepare(`
    INSERT INTO twin_events (id, event_type, subject_id, payload_json, occurred_at, ingested_at, source, source_id, actor, confidence, confirmation_state, evidence_json, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id, event_type) DO NOTHING
  `).run(id, input.eventType, input.subjectId ?? null, jsonString(payload), input.occurredAt, ingestedAt, input.source, input.sourceId, input.actor, input.confidence, input.confirmationState, jsonString(evidence), 1)
  const existing = db.prepare('SELECT * FROM twin_events WHERE source = ? AND source_id = ? AND event_type = ?').get(input.source, input.sourceId, input.eventType) as unknown as EventRow
  if (Number(result.changes) === 0 && (
    existing.subject_id !== (input.subjectId ?? null) || existing.payload_json !== jsonString(payload) || existing.occurred_at !== input.occurredAt || existing.actor !== input.actor || existing.confidence !== input.confidence || existing.confirmation_state !== input.confirmationState || existing.evidence_json !== jsonString(evidence)
  )) throw new TwinImmutableRecordConflictError(`Event ${input.source}/${input.sourceId}/${input.eventType} already contains different data`)
  if (Number(result.changes) === 1) {
    db.prepare(`INSERT INTO twin_outbox (id, topic, aggregate_id, payload_json, status, available_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
      .run(outboxId('twin.event.recorded', id), 'twin.event.recorded', id, jsonString({ recordId: id, eventType: input.eventType, source: input.source, sourceId: input.sourceId }), ingestedAt, ingestedAt)
  }
  return eventFromRow(existing)
}

export interface TwinFactBatchInput {
  ensureCanonicalSelf?: boolean
  observations?: TwinObservationInput[]
  events?: TwinEventInput[]
}

/** Atomically records a bounded group of immutable facts without exposing the database handle. */
export function recordTwinFactBatch(input: TwinFactBatchInput): {
  observations: TwinObservation[]
  events: TwinEvent[]
} {
  const observations = input.observations ?? []
  const events = input.events ?? []
  if (!Array.isArray(observations) || !Array.isArray(events) || observations.length + events.length > 128) {
    throw new Error('Twin fact batch must contain at most 128 records')
  }
  return withPersonalTwinDb(db => commitOrRollback(db, () => {
    if (input.ensureCanonicalSelf) {
      const self = db.prepare('SELECT source, source_id FROM twin_entities WHERE id = ?').get('person:self') as {
        source: string; source_id: string
      } | undefined
      if (!self) {
        upsertTwinEntityInDb(db, { id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
      } else if (self.source !== 'system' || self.source_id !== 'self') {
        throw new TwinIdentityConflictError('person:self is not owned by the canonical system identity')
      }
    }
    return {
      observations: observations.map(observation => recordTwinObservationInDb(db, observation)),
      events: events.map(event => recordTwinEventInDb(db, event)),
    }
  }))
}

export function listTwinEvents(options: { subjectId?: string; eventType?: string; eventTypePrefixes?: string[]; query?: string; limit?: number } = {}): TwinEvent[] {
  return withPersonalTwinDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.subjectId !== undefined) { clauses.push('v.subject_id = ?'); values.push(options.subjectId) }
    if (options.eventType !== undefined) { clauses.push('v.event_type = ?'); values.push(options.eventType) }
    if (options.eventTypePrefixes?.length) {
      clauses.push(`(${options.eventTypePrefixes.map(() => "v.event_type LIKE ? ESCAPE '\\'").join(' OR ')})`)
      values.push(...options.eventTypePrefixes.map(prefix => `${escapeLike(prefix)}%`))
    }
    const query = options.query?.trim()
    if (query) {
      clauses.push("LOWER(COALESCE(e.label, '') || ' ' || v.event_type || ' ' || v.payload_json) LIKE ? ESCAPE '\\'")
      values.push(`%${escapeLike(query.toLowerCase())}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`
      SELECT v.* FROM twin_events v
      LEFT JOIN twin_entities e ON e.id = v.subject_id
      ${where}
      ORDER BY julianday(v.occurred_at) DESC, julianday(v.ingested_at) DESC, v.id DESC LIMIT ?
    `).all(...values, clampLimit(options.limit)) as unknown as EventRow[]).map(eventFromRow)
  })
}
