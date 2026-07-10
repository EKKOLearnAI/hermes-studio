import { createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import { getHealthOverview, getHealthStateDbPath } from '../health-state'
import { getPersonalStateDbPath, getPersonalStateOverview } from '../personal-state'
import { getHermesBaseDir, listProfileNamesFromDisk } from '../hermes-profile'
import { withPersonalTwinDb } from './database'
import {
  TwinLegacyImportResult, TwinEntity, TwinEventInput, TwinObservationInput,
} from './types'
import { ensurePrimarySubject } from './service'
import { recordTwinEvent, recordTwinObservation, upsertTwinConstraint, upsertTwinEntity, upsertTwinGoal } from './store'

const IMPORTER_VERSION = 1

function nowIso(): string { return new Date().toISOString() }
function stableId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16) }
function legacySource(profile: string, collection: string, id: unknown): string { return `health-state:${profile}:${collection}:${String(id)}` }
function personalSource(profile: string, collection: string, id: unknown): string { return `personal-state:${profile}:${collection}:${String(id)}` }
function numericEntries(value: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(value).flatMap(([key, item]) => typeof item === 'number' && Number.isFinite(item) ? [[key, item]] : [])
}
function profileStats(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, exists: false }
  const stats = statSync(path)
  return { path, exists: true, size: stats.size, mtimeMs: stats.mtimeMs }
}
function normalizeProfiles(profiles?: string[]): string[] {
  const known = new Set(listProfileNamesFromDisk())
  if (!profiles || profiles.length === 0) return [...known].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b))
  return [...new Set(profiles.map(profile => profile.trim()).filter(profile => known.has(profile)))].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b))
}
function fingerprint(profiles: string[]): string {
  const sources = profiles.flatMap(profile => [profileStats(getHealthStateDbPath(profile)), profileStats(getPersonalStateDbPath(profile))])
  return stableId(JSON.stringify({ importerVersion: IMPORTER_VERSION, profiles, sources }))
}
function observation(input: Omit<TwinObservationInput, 'actor' | 'confidence' | 'confirmationState'>): void {
  recordTwinObservation({ ...input, actor: 'legacy-import', confidence: 1, confirmationState: 'reported' })
}
function event(input: Omit<TwinEventInput, 'actor' | 'confidence' | 'confirmationState'>): void {
  recordTwinEvent({ ...input, actor: 'legacy-import', confidence: 1, confirmationState: 'reported' })
}

export function syncLegacyTwinSources(options: { profiles?: string[] } = {}): TwinLegacyImportResult {
  const profiles = normalizeProfiles(options.profiles)
  const sourceFingerprint = fingerprint(profiles)
  const existing = withPersonalTwinDb(db => db.prepare('SELECT * FROM twin_import_runs WHERE source = ? AND source_fingerprint = ? AND status = ?').get('legacy-personal-os', sourceFingerprint, 'completed') as Record<string, unknown> | undefined)
  if (existing) return {
    runId: String(existing.id), profiles, status: 'completed', counts: JSON.parse(String(existing.counts_json)),
    startedAt: String(existing.started_at), completedAt: String(existing.completed_at),
  }

  const runId = `legacy-import-${sourceFingerprint}`
  const startedAt = nowIso()
  const counts = { entities: 0, observations: 0, events: 0, goals: 0, constraints: 0 }
  try {
    const subject = ensurePrimarySubject(); counts.entities += 1
    const body: TwinEntity = upsertTwinEntity({ id: 'body:self', type: 'body', label: 'Body', source: 'system', sourceId: 'body:self' }); counts.entities += body.id ? 1 : 0
    for (const profile of profiles) {
      const health = getHealthOverview({ profile, includeRecords: true })
      const personal = getPersonalStateOverview({ profile, limit: 10000 })
      const profileSource = `health-state:${profile}`
      if (typeof health.healthProfile.heightCm === 'number') { observation({ entityId: subject.id, metric: 'profile.height_cm', value: health.healthProfile.heightCm, unit: 'cm', observedAt: health.generatedAt, source: profileSource, sourceId: 'profile:height' }); counts.observations += 1 }
      if (typeof health.healthProfile.weightKg === 'number') { observation({ entityId: subject.id, metric: 'profile.weight_kg', value: health.healthProfile.weightKg, unit: 'kg', observedAt: health.generatedAt, source: profileSource, sourceId: 'profile:weight' }); counts.observations += 1 }
      health.healthProfile.goals.forEach((goal, index) => { upsertTwinGoal({ subjectId: subject.id, domain: 'health', title: String(goal), target: {}, status: 'active', priority: 50, source: profileSource, sourceId: `goal:${index}:${String(goal)}` }); counts.goals += 1 })
      health.healthProfile.allergies.forEach((allergy, index) => { upsertTwinConstraint({ subjectId: subject.id, domain: 'health', key: 'allergy', value: allergy, enforcement: 'hard', source: profileSource, sourceId: `allergy:${index}:${String(allergy)}` }); counts.constraints += 1 })
      health.healthProfile.conditions.forEach((condition, index) => { upsertTwinConstraint({ subjectId: subject.id, domain: 'health', key: 'condition', value: condition, enforcement: 'advisory', source: profileSource, sourceId: `condition:${index}:${String(condition)}` }); counts.constraints += 1 })

      const records = health.records || []
      const scaleRecordedAt = new Set(records.filter(record => record.kind === 'scale_reading').map(record => String(record.recordedAt)))
      for (const record of records) {
        const id = String(record.id)
        const source = legacySource(profile, 'records', id)
        const recordedAt = String(record.recordedAt || health.generatedAt)
        const value = record.value && typeof record.value === 'object' ? record.value as Record<string, unknown> : { value: record.value }
        if (record.kind === 'scale_reading') {
          event({ eventType: 'health.scale.measured', subjectId: subject.id, payload: { legacy: record }, occurredAt: recordedAt, source, sourceId: id })
          counts.events += 1
          const metricMap: Record<string, string> = { weightKg: 'body.weight_kg', bmi: 'body.bmi', bodyFatPercent: 'body.fat_percent', muscleMassKg: 'body.muscle_mass_kg', visceralFatLevel: 'body.visceral_fat_level', basalMetabolismKcal: 'body.basal_metabolism_kcal' }
          for (const [key, metric] of Object.entries(metricMap)) if (typeof value[key] === 'number') { observation({ entityId: subject.id, metric, value: value[key], unit: metric.endsWith('_kg') ? 'kg' : null, observedAt: recordedAt, source, sourceId: id }); counts.observations += 1 }
        } else if (record.kind === 'weight' && !scaleRecordedAt.has(recordedAt)) {
          observation({ entityId: subject.id, metric: 'body.weight_kg', value: value.value, unit: typeof record.unit === 'string' ? record.unit : 'kg', observedAt: recordedAt, source, sourceId: id }); counts.observations += 1
        } else if (record.kind === 'body_measurement') {
          for (const [key, numeric] of numericEntries((value.measurements && typeof value.measurements === 'object' ? value.measurements : value) as Record<string, unknown>)) { observation({ entityId: subject.id, metric: `body.measurement.${key}`, value: numeric, observedAt: recordedAt, source, sourceId: `${id}:${key}` }); counts.observations += 1 }
        } else if (record.kind === 'posture_assessment' || record.kind === 'skin_assessment') {
          event({ eventType: record.kind === 'posture_assessment' ? 'health.posture.assessed' : 'health.skin.assessed', subjectId: subject.id, payload: { legacy: record }, occurredAt: recordedAt, source, sourceId: id }); counts.events += 1
        } else if (record.kind !== 'scale_reading') {
          event({ eventType: `health.record.${String(record.kind || 'unknown').replace(/[^a-z0-9_]+/gi, '_')}`, subjectId: subject.id, payload: { legacy: record }, occurredAt: recordedAt, source, sourceId: id }); counts.events += 1
        }
      }
      for (const workout of health.workouts || []) { const id = String(workout.id); event({ eventType: 'fitness.workout.logged', subjectId: subject.id, payload: { legacy: workout }, occurredAt: String(workout.startedAt || health.generatedAt), source: legacySource(profile, 'workouts', id), sourceId: id }); counts.events += 1 }
      for (const food of health.foodLogs || []) { const id = String(food.id); event({ eventType: 'nutrition.meal.logged', subjectId: subject.id, payload: { legacy: food }, occurredAt: String(food.loggedAt || health.generatedAt), source: legacySource(profile, 'foodLogs', id), sourceId: id }); counts.events += 1 }
      for (const checkin of health.dailyCheckins || []) { const id = String(checkin.id); event({ eventType: 'health.daily_checkin.recorded', subjectId: subject.id, payload: { legacy: checkin }, occurredAt: String(checkin.checkinDate || health.generatedAt), source: legacySource(profile, 'dailyCheckins', id), sourceId: id }); counts.events += 1 }
      for (const plan of health.dailyPlans || []) { const id = String(plan.id); event({ eventType: 'health.plan.recorded', subjectId: subject.id, payload: { legacy: plan }, occurredAt: String(plan.planDate || health.generatedAt), source: legacySource(profile, 'dailyPlans', id), sourceId: id }); counts.events += 1 }
      for (const bodyMap of health.bodyMap || []) { const id = String(bodyMap.id); event({ eventType: 'health.body_region.assessed', subjectId: subject.id, payload: { legacy: bodyMap }, occurredAt: String(bodyMap.recordedAt || health.generatedAt), source: legacySource(profile, 'bodyMap', id), sourceId: id }); counts.events += 1 }
      for (const supplement of health.supplementLogs || []) { const id = String(supplement.id); event({ eventType: 'health.supplement.taken', subjectId: subject.id, payload: { legacy: supplement }, occurredAt: String(supplement.takenAt || health.generatedAt), source: legacySource(profile, 'supplementLogs', id), sourceId: id }); counts.events += 1 }
      for (const proposal of personal.proposals || []) { const id = String(proposal.id); event({ eventType: proposal.status === 'pending' ? 'personal.proposal.created' : 'personal.proposal.reviewed', subjectId: subject.id, payload: { legacy: proposal }, occurredAt: String(proposal.provenance.createdAt || personal.generatedAt), source: personalSource(profile, 'proposals', id), sourceId: id }); counts.events += 1 }
      for (const task of personal.tasks || []) { const id = String(task.id); event({ eventType: 'personal.task.created', subjectId: subject.id, payload: { legacy: task }, occurredAt: String(task.provenance.createdAt || personal.generatedAt), source: personalSource(profile, 'tasks', id), sourceId: id }); counts.events += 1 }
    }
    const completedAt = nowIso()
    withPersonalTwinDb(db => db.prepare(`INSERT INTO twin_import_runs (id, source, source_fingerprint, status, counts_json, started_at, completed_at) VALUES (?, ?, ?, 'completed', ?, ?, ?)`)
      .run(runId, 'legacy-personal-os', sourceFingerprint, JSON.stringify(counts), startedAt, completedAt))
    return { runId, profiles, status: 'completed', counts, startedAt, completedAt }
  } catch (error) {
    const completedAt = nowIso()
    withPersonalTwinDb(db => db.prepare(`INSERT OR REPLACE INTO twin_import_runs (id, source, source_fingerprint, status, counts_json, error, started_at, completed_at) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`)
      .run(runId, 'legacy-personal-os', sourceFingerprint, JSON.stringify(counts), String(error), startedAt, completedAt))
    throw error
  }
}
