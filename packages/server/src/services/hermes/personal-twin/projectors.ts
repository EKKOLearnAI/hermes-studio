import { DatabaseSync } from 'node:sqlite'
import { withPersonalTwinDb } from './database'
import { listTwinObservations } from './store'
import { TwinObservation, TwinProjection } from './types'

interface ProjectionRow { projection_key: string; subject_id: string; value_json: string; source_record_id: string; version: number; updated_at: string }

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function projectionFromRow(row: ProjectionRow): TwinProjection {
  return { key: row.projection_key, subjectId: row.subject_id, value: parseJson(row.value_json, {}), sourceRecordId: row.source_record_id, version: row.version, updatedAt: row.updated_at }
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
    const observations = listTwinObservations({ limit: 200 })
    const keys = [...new Set(observations.map(observation => `latest:${observation.metric}`))]
    if (keys.length > 0) db.prepare(`DELETE FROM twin_projections WHERE projection_key IN (${keys.map(() => '?').join(',')})`).run(...keys)
    for (const observation of observations.slice().sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || Date.parse(a.ingestedAt) - Date.parse(b.ingestedAt) || a.id.localeCompare(b.id))) projectObservation(db, observation)
  })
}

export function getTwinProjection(key: string, subjectId: string): TwinProjection | null {
  return withPersonalTwinDb(db => {
    const row = db.prepare('SELECT * FROM twin_projections WHERE projection_key = ? AND subject_id = ?').get(key, subjectId) as unknown as ProjectionRow | undefined
    return row ? projectionFromRow(row) : null
  })
}
