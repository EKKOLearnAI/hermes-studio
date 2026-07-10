import { createHash } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { withPersonalTwinDb } from './database'
import { projectObservation } from './projectors'
import {
  TwinConstraint, TwinConstraintInput, TwinConstraintListOptions,
  TwinEntity, TwinEntityInput, TwinEntityListOptions,
  TwinGoal, TwinGoalInput, TwinGoalListOptions,
  TwinIdentityConflictError, TwinRecordNotFoundError,
  TwinRelation, TwinRelationInput, TwinRelationListOptions,
  TwinEvent, TwinEventInput, TwinObservation, TwinObservationInput,
  TwinImmutableRecordConflictError, TwinProvenance,
} from './types'

type StablePart = string | number | boolean | null | undefined

interface EntityRow { id: string; type: string; label: string; attributes_json: string; source: string; source_id: string; created_at: string; updated_at: string }
interface RelationRow { id: string; subject_id: string; predicate: string; object_id: string; attributes_json: string; valid_from: string | null; valid_to: string | null; source: string; source_id: string; created_at: string; updated_at: string }
interface GoalRow { id: string; subject_id: string; domain: string; title: string; target_json: string; status: string; priority: number; starts_at: string | null; due_at: string | null; source: string; source_id: string; created_at: string; updated_at: string }
interface ConstraintRow { id: string; subject_id: string; domain: string; key: string; value_json: string; enforcement: 'hard' | 'advisory'; source: string; source_id: string; created_at: string; updated_at: string }
interface ObservationRow { id: string; entity_id: string; metric: string; value_json: string; unit: string | null; observed_at: string; ingested_at: string; source: string; source_id: string; actor: string; confidence: number; confirmation_state: TwinProvenance['confirmationState']; evidence_json: string; schema_version: number }
interface EventRow { id: string; event_type: string; subject_id: string | null; payload_json: string; occurred_at: string; ingested_at: string; source: string; source_id: string; actor: string; confidence: number; confirmation_state: TwinProvenance['confirmationState']; evidence_json: string; schema_version: number }

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

export function upsertTwinEntity(input: TwinEntityInput): TwinEntity {
  return withPersonalTwinDb(db => {
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
  })
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

export function recordTwinObservation(input: TwinObservationInput): TwinObservation {
  validateFactInput(input.source, input.sourceId, input.actor, input.confidence, input.observedAt)
  return withPersonalTwinDb(db => commitOrRollback(db, () => {
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
  }))
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
  return withPersonalTwinDb(db => commitOrRollback(db, () => {
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
