import { DatabaseSync } from 'node:sqlite'
import { isProxy } from 'node:util/types'
import { withPersonalTwinDb } from './database'
import { TwinObservation, TwinProjection, TwinProjectionWrite, TwinProvenance, TwinRecordNotFoundError } from './types'

interface ProjectionRow { projection_key: string; subject_id: string; value_json: string; source_record_id: string; version: number; updated_at: string }
interface ObservationRow { id: string; entity_id: string; metric: string; value_json: string; unit: string | null; observed_at: string; ingested_at: string; source: string; source_id: string; actor: string; confidence: number; confirmation_state: TwinProvenance['confirmationState']; evidence_json: string; schema_version: number }

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function projectionFromRow(row: ProjectionRow): TwinProjection {
  const value = projectionValueFromJson(row.value_json, !row.projection_key.startsWith('latest:'))
  return { key: row.projection_key, subjectId: row.subject_id, value, sourceRecordId: row.source_record_id, version: row.version, updatedAt: row.updated_at }
}

const PROJECTION_POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function assertProjectionPoisonFree(value: Record<string, unknown>): void {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (!item || typeof item !== 'object') continue
    for (const key of Object.keys(item)) {
      if (PROJECTION_POISON_KEYS.has(key)) throw new Error('Twin projection value contains a poison key')
      pending.push((item as Record<string, unknown>)[key])
    }
  }
}

function projectionValueFromJson(valueJson: string, strictCustomBounds: boolean): Record<string, unknown> {
  try {
    const value = JSON.parse(valueJson) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root')
    assertProjectionPoisonFree(value as Record<string, unknown>)
    if (!strictCustomBounds) return value as Record<string, unknown>
    return JSON.parse(canonicalProjectionJson(value)) as Record<string, unknown>
  } catch {
    throw new Error('Twin projection value is invalid or exceeds structural bounds')
  }
}

function canonicalProjectionJson(value: unknown): string {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): string => {
    nodes += 1
    if (nodes > 512 || depth > 8) throw new Error('bounds')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('number')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || isProxy(item) || seen.has(item)) throw new Error('shape')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error('shape')
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        if (item.length > 128) throw new Error('bounds')
        const ownKeys = Reflect.ownKeys(item)
        if (ownKeys.some(key => typeof key === 'symbol' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
          throw new Error('shape')
        }
        return `[${Array.from({ length: item.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('shape')
          return visit(descriptor.value, depth + 1)
        }).join(',')}]`
      }
      const record = item as Record<string, unknown>
      const keys = Reflect.ownKeys(record)
      if (keys.some(key => typeof key !== 'string') || keys.length > 128) throw new Error('shape')
      return `{${(keys as string[]).sort().map(key => {
        if (PROJECTION_POISON_KEYS.has(key)) throw new Error('poison')
        if (key.length < 1 || key.length > 160) throw new Error('key')
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('shape')
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`
      }).join(',')}}`
    } finally {
      seen.delete(item)
    }
  }
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root')
    const encoded = visit(value, 0)
    if (Buffer.byteLength(encoded, 'utf8') > 16_384) throw new Error('size')
    return encoded
  } catch {
    throw new Error('Twin projection value is invalid or exceeds structural bounds')
  }
}

function validateProjectionKey(key: string, allowPrefix: boolean): void {
  const pattern = allowPrefix
    ? /^[a-z][a-z0-9_-]{0,63}(?:[.:][a-z0-9][a-z0-9_-]{0,63})*[.:]?$/
    : /^[a-z][a-z0-9_-]{0,63}(?:[.:][a-z0-9][a-z0-9_-]{0,63})+$/
  if (typeof key !== 'string' || key.length > 256 || !/[.:]/.test(key) || !pattern.test(key)) {
    throw new Error(`Twin projection ${allowPrefix ? 'prefix' : 'key'} is invalid`)
  }
}

function validateProjectionWrite(input: TwinProjectionWrite): string {
  validateProjectionKey(input.key, false)
  if (input.key.startsWith('latest:')) throw new Error('Twin projection key is reserved for observation projectors')
  if (typeof input.sourceRecordId !== 'string' || input.sourceRecordId.length < 1 || input.sourceRecordId.length > 500
    || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(input.sourceRecordId)) {
    throw new Error('Twin projection source record ID is invalid')
  }
  if (typeof input.updatedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.updatedAt)
    || Number.isNaN(Date.parse(input.updatedAt))) {
    throw new Error('Twin projection updatedAt is invalid')
  }
  if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)) {
    throw new Error('Twin projection expected version is invalid')
  }
  return canonicalProjectionJson(input.value)
}

function requireProjectionSubject(db: DatabaseSync, subjectId: string): void {
  if (!db.prepare('SELECT 1 FROM twin_entities WHERE id = ?').get(subjectId)) {
    throw new TwinRecordNotFoundError(`Twin entity not found: ${subjectId}`)
  }
}

function observationFromRow(row: ObservationRow): TwinObservation {
  return {
    id: row.id,
    entityId: row.entity_id,
    metric: row.metric,
    value: parseJson(row.value_json, null),
    unit: row.unit,
    observedAt: row.observed_at,
    ingestedAt: row.ingested_at,
    provenance: {
      source: row.source,
      sourceId: row.source_id,
      actor: row.actor,
      confidence: row.confidence,
      confirmationState: row.confirmation_state,
      evidence: parseJson(row.evidence_json, []),
      schemaVersion: row.schema_version,
    },
  }
}

function isNewer(candidate: TwinObservation, current: ProjectionRow | undefined): boolean {
  if (!current) return true
  const value = current.value_json ? parseJson<{ observedAt?: string; ingestedAt?: string; id?: string }>(current.value_json, {}) : {}
  const candidateTime = Date.parse(candidate.observedAt)
  const currentTime = Date.parse(value.observedAt || '')
  if (candidateTime !== currentTime) return candidateTime > currentTime
  const candidateIngested = Date.parse(candidate.ingestedAt)
  const currentIngested = Date.parse(value.ingestedAt || '')
  if (candidateIngested !== currentIngested) return candidateIngested > currentIngested
  return candidate.id > (value.id || '')
}

export function projectObservation(db: DatabaseSync, observation: TwinObservation): void {
  const key = `latest:${observation.metric}`
  const current = db.prepare('SELECT * FROM twin_projections WHERE projection_key = ? AND subject_id = ?').get(key, observation.entityId) as unknown as ProjectionRow | undefined
  const currentValue = current ? parseJson<Record<string, unknown>>(current.value_json, {}) : undefined
  if (current && !isNewer(observation, { ...current, value_json: JSON.stringify(currentValue) })) return
  const now = observation.ingestedAt
  const value = {
    id: observation.id,
    metric: observation.metric,
    value: observation.value,
    unit: observation.unit,
    observedAt: observation.observedAt,
    ingestedAt: observation.ingestedAt,
    source: observation.provenance.source,
    sourceId: observation.provenance.sourceId,
    confidence: observation.provenance.confidence,
    confirmationState: observation.provenance.confirmationState,
  }
  db.prepare(`
    INSERT INTO twin_projections (projection_key, subject_id, value_json, source_record_id, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(projection_key, subject_id) DO UPDATE SET value_json=excluded.value_json, source_record_id=excluded.source_record_id, version=excluded.version, updated_at=excluded.updated_at
  `).run(key, observation.entityId, JSON.stringify(value), observation.id, (current?.version || 0) + 1, now)
}

export function rebuildTwinProjections(): void {
  withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const observations = (db.prepare(`
        SELECT * FROM twin_observations
        ORDER BY julianday(observed_at) ASC, julianday(ingested_at) ASC, id ASC
      `).all() as unknown as ObservationRow[]).map(observationFromRow)
      const deleteProjection = db.prepare('DELETE FROM twin_projections WHERE projection_key = ?')
      for (const key of new Set(observations.map(observation => `latest:${observation.metric}`))) deleteProjection.run(key)
      for (const observation of observations) projectObservation(db, observation)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

export function writeTwinProjectionBatch(inputs: TwinProjectionWrite[]): TwinProjection[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 128) {
    throw new Error('Twin projection batch must contain between 1 and 128 writes')
  }
  const addresses = new Set<string>()
  const prepared = inputs.map(input => {
    const address = `${input.subjectId}\0${input.key}`
    if (addresses.has(address)) throw new Error('Twin projection batch contains a duplicate address')
    addresses.add(address)
    return { input, valueJson: validateProjectionWrite(input) }
  })
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const currentByAddress = new Map<string, ProjectionRow | undefined>()
      for (const { input } of prepared) {
        requireProjectionSubject(db, input.subjectId)
        const current = db.prepare('SELECT * FROM twin_projections WHERE projection_key = ? AND subject_id = ?')
          .get(input.key, input.subjectId) as unknown as ProjectionRow | undefined
        currentByAddress.set(`${input.subjectId}\0${input.key}`, current)
        if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0)) {
          throw new Error('TWIN_PROJECTION_CONFLICT')
        }
      }
      const write = db.prepare(`
          INSERT INTO twin_projections (projection_key, subject_id, value_json, source_record_id, version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(projection_key, subject_id) DO UPDATE SET
            value_json=excluded.value_json, source_record_id=excluded.source_record_id,
            version=excluded.version, updated_at=excluded.updated_at
        `)
      for (const { input, valueJson } of prepared) {
        const current = currentByAddress.get(`${input.subjectId}\0${input.key}`)
        write.run(input.key, input.subjectId, valueJson, input.sourceRecordId, (current?.version ?? 0) + 1, input.updatedAt)
      }
      const result = prepared.map(({ input }) => db.prepare('SELECT * FROM twin_projections WHERE projection_key = ? AND subject_id = ?')
        .get(input.key, input.subjectId) as unknown as ProjectionRow)
      db.exec('COMMIT')
      return result.map(projectionFromRow)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

export function writeTwinProjection(input: TwinProjectionWrite): TwinProjection {
  return writeTwinProjectionBatch([input])[0]
}

export function listTwinProjections(prefix: string, subjectId: string): TwinProjection[] {
  validateProjectionKey(prefix, true)
  return withPersonalTwinDb(db => {
    requireProjectionSubject(db, subjectId)
    const escapedPrefix = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    return (db.prepare(`
      SELECT * FROM twin_projections
      WHERE subject_id = ? AND projection_key LIKE ? ESCAPE '\\'
      ORDER BY projection_key ASC
    `).all(subjectId, `${escapedPrefix}%`) as unknown as ProjectionRow[]).map(projectionFromRow)
  })
}

export function getTwinProjection(key: string, subjectId: string): TwinProjection | null {
  if (typeof key !== 'string' || (key.startsWith('latest:') ? key.length <= 'latest:'.length : false)) {
    throw new Error('Twin projection key is invalid')
  }
  if (!key.startsWith('latest:')) validateProjectionKey(key, false)
  return withPersonalTwinDb(db => {
    requireProjectionSubject(db, subjectId)
    const row = db.prepare('SELECT * FROM twin_projections WHERE projection_key = ? AND subject_id = ?').get(key, subjectId) as unknown as ProjectionRow | undefined
    return row ? projectionFromRow(row) : null
  })
}
