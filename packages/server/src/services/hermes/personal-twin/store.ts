import { createHash } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { withPersonalTwinDb } from './database'
import {
  TwinConstraint, TwinConstraintInput, TwinConstraintListOptions,
  TwinEntity, TwinEntityInput, TwinEntityListOptions,
  TwinGoal, TwinGoalInput, TwinGoalListOptions,
  TwinIdentityConflictError, TwinRecordNotFoundError,
  TwinRelation, TwinRelationInput, TwinRelationListOptions,
} from './types'

type StablePart = string | number | boolean | null | undefined

interface EntityRow { id: string; type: string; label: string; attributes_json: string; source: string; source_id: string; created_at: string; updated_at: string }
interface RelationRow { id: string; subject_id: string; predicate: string; object_id: string; attributes_json: string; valid_from: string | null; valid_to: string | null; source: string; source_id: string; created_at: string; updated_at: string }
interface GoalRow { id: string; subject_id: string; domain: string; title: string; target_json: string; status: string; priority: number; starts_at: string | null; due_at: string | null; source: string; source_id: string; created_at: string; updated_at: string }
interface ConstraintRow { id: string; subject_id: string; domain: string; key: string; value_json: string; enforcement: 'hard' | 'advisory'; source: string; source_id: string; created_at: string; updated_at: string }

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
function ensureIdentityAvailable(db: DatabaseSync, id: string, source: string, sourceId: string): void {
  const row = db.prepare('SELECT source, source_id FROM twin_entities WHERE id = ?').get(id) as { source: string; source_id: string } | undefined
  if (row && (row.source !== source || row.source_id !== sourceId)) throw new TwinIdentityConflictError(`Entity id ${id} is owned by another provenance record`)
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
    const existing = db.prepare('SELECT id FROM twin_entities WHERE source = ? AND source_id = ?').get(input.source, input.sourceId) as { id: string } | undefined
    const id = existing?.id || input.id || stableTwinId('entity', [input.source, input.sourceId])
    if (existing && input.id && existing.id !== input.id) throw new TwinIdentityConflictError(`Provenance ${input.source}/${input.sourceId} already owns ${existing.id}`)
    ensureIdentityAvailable(db, id, input.source, input.sourceId)
    const timestamp = nowIso()
    db.prepare(`
      INSERT INTO twin_entities (id, type, label, attributes_json, source, source_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_id) DO UPDATE SET
        type = excluded.type, label = excluded.label, attributes_json = excluded.attributes_json, updated_at = excluded.updated_at
    `).run(id, input.type, input.label, jsonString(input.attributes || {}), input.source, input.sourceId, timestamp, timestamp)
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
