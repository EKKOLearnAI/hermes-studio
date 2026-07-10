import { DatabaseSync } from 'node:sqlite'
import { withPersonalTwinDb } from './database'
import { TwinObservation, TwinProjection, TwinProvenance } from './types'

interface ProjectionRow { projection_key: string; subject_id: string; value_json: string; source_record_id: string; version: number; updated_at: string }
interface ObservationRow { id: string; entity_id: string; metric: string; value_json: string; unit: string | null; observed_at: string; ingested_at: string; source: string; source_id: string; actor: string; confidence: number; confirmation_state: TwinProvenance['confirmationState']; evidence_json: string; schema_version: number }

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function projectionFromRow(row: ProjectionRow): TwinProjection {
  return { key: row.projection_key, subjectId: row.subject_id, value: parseJson(row.value_json, {}), sourceRecordId: row.source_record_id, version: row.version, updatedAt: row.updated_at }
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

export function getTwinProjection(key: string, subjectId: string): TwinProjection | null {
  return withPersonalTwinDb(db => {
    const row = db.prepare('SELECT * FROM twin_projections WHERE projection_key = ? AND subject_id = ?').get(key, subjectId) as unknown as ProjectionRow | undefined
    return row ? projectionFromRow(row) : null
  })
}
