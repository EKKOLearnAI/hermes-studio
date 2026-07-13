import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HealthIngestionEnvelope } from '../../packages/server/src/services/hermes/health-loop'

const observedAt = '2026-07-13T08:00:00.000Z'

const fixtures: HealthIngestionEnvelope[] = [
  { domain: 'body_composition', source: 'mi-s400', sourceId: 'reading-1', observedAt, evidenceClass: 'measured', confidence: 0.99,
    payload: { weightKg: 84.2, bmi: 26.6, bodyFatPercent: 21.4, muscleMassKg: 62.1, boneMassKg: 3.2, waterPercent: 55.1, visceralFatLevel: 9, bmrKcal: 1840,
      proteinPercent: 18.2, subcutaneousFatPercent: 17.1, fatMassKg: 18, leanBodyMassKg: 66.2, skeletalMusclePercent: 42.3, bodyScore: 82, idealWeightKg: 74 } },
  { domain: 'measurements', source: 'guided-measurement', sourceId: 'measurement-1', observedAt, evidenceClass: 'reported', confidence: 0.9,
    payload: { waistCm: 88, hipCm: 99, leftArmCm: 33, rightArmCm: 33.5, leftThighCm: 57, rightThighCm: 57.4, method: 'tape', calibrationId: 'tape-2026' } },
  { domain: 'posture', source: 'local-pose', sourceId: 'posture-1', observedAt, evidenceClass: 'inferred', confidence: 0.82,
    payload: { findings: [{ code: 'forward_head', severity: 0.4, confidence: 0.81 }], angles: { headForwardDeg: 12.5 }, capture: { views: ['front', 'side'], quality: 0.92 }, modelVersion: 'pose-1.2', modelConfidence: 0.84 } },
  { domain: 'skin', source: 'local-skin', sourceId: 'skin-1', observedAt, evidenceClass: 'inferred', confidence: 0.76,
    payload: { region: 'face', appearances: [{ type: 'redness', severity: 0.3 }], trend: 'stable', captureQuality: 0.88 } },
  { domain: 'diet', source: 'meal-log', sourceId: 'meal-1', observedAt, evidenceClass: 'reported', confidence: 0.85,
    payload: { foods: [{ name: 'rice', portionGrams: 180 }], caloriesKcal: 520, proteinG: 30, carbsG: 65, fatG: 14, micros: { fiberG: 8, sodiumMg: 640 }, waterMl: 350, portionConfirmed: true } },
  { domain: 'fitness', source: 'training-log', sourceId: 'workout-1', observedAt, evidenceClass: 'measured', confidence: 0.95,
    payload: { exercise: 'squat', sets: 4, reps: 8, loadKg: 80, durationMinutes: 42, intensity: 'vigorous', muscles: ['quadriceps', 'glutes'], pain: 0, rpe: 8, completed: true } },
  { domain: 'sleep', source: 'mi-fitness', sourceId: 'sleep-1', observedAt, evidenceClass: 'measured', confidence: 0.93,
    payload: { startedAt: '2026-07-12T23:10:00+08:00', endedAt: '2026-07-13T06:40:00+08:00', durationMinutes: 450, interruptions: 2, stages: { deepMinutes: 90, remMinutes: 105, lightMinutes: 240 }, restingHeartRateBpm: 58, recoveryScore: 81 } },
  { domain: 'internal_health', source: 'report-parser', sourceId: 'report-1', observedAt, evidenceClass: 'inferred', confidence: 0.88,
    payload: { markers: [{ name: 'fasting_glucose', value: 5.2, unit: 'mmol/L', referenceLow: 3.9, referenceHigh: 6.1, providerFlag: 'normal' }], reportDate: '2026-07-01', institution: 'Example Hospital', reportArtifactId: `artifact-${'a'.repeat(64)}`, pendingConfirmation: true } },
]

describe('health-loop ingestion', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-ingestion-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it.each(fixtures)('normalizes and ingests one synthetic $domain fixture with canonical units', async envelope => {
    const { ingestHealthEnvelope, normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const { getTwinEntity, listTwinEvents, listTwinObservations } = await import('../../packages/server/src/services/hermes/personal-twin')
    const normalized = normalizeHealthIngestionEnvelope(envelope)
    const result = ingestHealthEnvelope(envelope)

    expect(normalized.observations.length).toBeGreaterThan(0)
    expect(normalized.observations.every(item => item.metric.startsWith('health.'))).toBe(true)
    expect(result.observations.map(item => item.metric)).toEqual(normalized.observations.map(item => item.metric))
    expect(result.event.eventType).toBe('health.ingestion.recorded')
    expect(listTwinObservations({ entityId: 'person:self' })).toHaveLength(normalized.observations.length)
    expect(listTwinEvents({ subjectId: 'person:self' })).toHaveLength(1)
    expect(getTwinEntity('person:self')).toMatchObject({ id: 'person:self', source: 'system', sourceId: 'self' })
  })

  it('uses explicit allowlists so unknown fields do not affect normalized material or replay', async () => {
    const { ingestHealthEnvelope, normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const { listTwinEvents, listTwinObservations } = await import('../../packages/server/src/services/hermes/personal-twin')
    const base = fixtures[0]
    const first = ingestHealthEnvelope(base)
    const withUnknown = { ...base, payload: { ...base.payload, providerDump: { accessToken: 'must-not-persist' }, unknown: 123 } }
    const replay = ingestHealthEnvelope(withUnknown)

    expect(normalizeHealthIngestionEnvelope(withUnknown)).toEqual(normalizeHealthIngestionEnvelope(base))
    expect(replay.observations.map(item => item.id)).toEqual(first.observations.map(item => item.id))
    expect(replay.event.id).toBe(first.event.id)
    expect(listTwinObservations({ entityId: 'person:self' })).toHaveLength(first.observations.length)
    expect(listTwinEvents({ subjectId: 'person:self' })).toHaveLength(1)
    expect(JSON.stringify({ replay, observations: listTwinObservations({ entityId: 'person:self' }) })).not.toContain('accessToken')
  })

  it('assigns canonical units to scalar measurements and retains model confidence', async () => {
    const { normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const body = normalizeHealthIngestionEnvelope(fixtures[0])
    const units = Object.fromEntries(body.observations.map(item => [item.metric, item.unit]))
    expect(units).toMatchObject({
      'health.body_composition.weight_kg': 'kg',
      'health.body_composition.body_fat_percent': '%',
      'health.body_composition.protein_percent': '%',
      'health.body_composition.subcutaneous_fat_percent': '%',
      'health.body_composition.fat_mass_kg': 'kg',
      'health.body_composition.lean_body_mass_kg': 'kg',
      'health.body_composition.skeletal_muscle_percent': '%',
      'health.body_composition.bmr_kcal': 'kcal/day',
      'health.body_composition.ideal_weight_kg': 'kg',
    })
    expect(body.observations.find(item => item.metric === 'health.body_composition.body_score')).toMatchObject({ value: 82, unit: null })
    expect(normalizeHealthIngestionEnvelope(fixtures[2]).observations)
      .toContainEqual({ metric: 'health.posture.model_confidence', value: 0.84, unit: null })
  })

  it('enforces strict RFC3339 timestamps, numeric bounds, and semantic string budgets', async () => {
    const { normalizeHealthIngestionEnvelope, HealthIngestionError } = await import('../../packages/server/src/services/hermes/health-loop')
    const base = fixtures[0]
    const invalid: HealthIngestionEnvelope[] = [
      { ...base, observedAt: '2026-07-13' },
      { ...base, observedAt: '2026-02-30T08:00:00Z' },
      { ...base, confidence: Number.NaN },
      { ...base, confidence: 1.01 },
      { ...base, source: 'bad source' },
      { ...base, source: `a${'b'.repeat(64)}` },
      { ...base, sourceId: 'bad/source' },
      { ...base, sourceId: `a${'b'.repeat(200)}` },
      { ...base, parserVersion: 'bad version!' },
      { ...base, payload: { ...base.payload, weightKg: Number.POSITIVE_INFINITY } },
      { ...base, payload: { ...base.payload, weightKg: 0 } },
    ]
    for (const envelope of invalid) {
      expect(() => normalizeHealthIngestionEnvelope(envelope)).toThrow(HealthIngestionError)
    }
  })

  it('preserves evidence class while mapping conservative Twin confirmation states', async () => {
    const { normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const expected = { measured: 'observed', reported: 'reported', inferred: 'inferred', derived: 'inferred' }
    for (const [evidenceClass, confirmationState] of Object.entries(expected)) {
      const normalized = normalizeHealthIngestionEnvelope({ ...fixtures[0], evidenceClass: evidenceClass as HealthIngestionEnvelope['evidenceClass'] })
      expect(normalized.confirmationState).toBe(confirmationState)
      expect(normalized.evidence).toContainEqual(expect.objectContaining({ evidenceClass }))
    }
    const report = normalizeHealthIngestionEnvelope(fixtures[7])
    expect(report.confirmationState).toBe('inferred')
    expect(report.eventPayload).toMatchObject({ pendingConfirmation: true })
  })

  it('validates and deduplicates artifact IDs and binds them into evidence', async () => {
    const { HealthIngestionError, normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const artifact = `artifact-${'b'.repeat(64)}`
    const normalized = normalizeHealthIngestionEnvelope({ ...fixtures[2], artifactIds: [artifact, artifact] })
    expect(normalized.artifactIds).toEqual([artifact])
    expect(normalized.evidence).toContainEqual(expect.objectContaining({ artifactIds: [artifact] }))
    expect(() => normalizeHealthIngestionEnvelope({ ...fixtures[2], artifactIds: ['../secret'] })).toThrow(/HEALTH_INGESTION_INVALID_ARTIFACT_ID/)
    expect(() => normalizeHealthIngestionEnvelope({ ...fixtures[2], artifactIds: 'not-an-array' as unknown as string[] }))
      .toThrow(HealthIngestionError)
  })

  it('rejects recursive prototype poison, accessors, cycles, and structural limit abuse', async () => {
    const { normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const poison = JSON.parse('{"safe":{"constructor":{"prototype":{"polluted":true}}}}')
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'weightKg', { enumerable: true, get: () => 84 })
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    let deep: Record<string, unknown> = { value: 1 }
    for (let index = 0; index < 10; index += 1) deep = { nested: deep }
    const many = { items: Array.from({ length: 600 }, (_, index) => index) }
    const huge = { text: 'x'.repeat(70_000) }
    for (const payload of [poison, accessor, cycle, deep, many, huge]) {
      expect(() => normalizeHealthIngestionEnvelope({ ...fixtures[0], payload })).toThrow(/HEALTH_INGESTION_INVALID_JSON/)
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('fails closed on changed normalized material under one source identity with no partial writes', async () => {
    const { ingestHealthEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const { listTwinEvents, listTwinObservations, withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const first = ingestHealthEnvelope(fixtures[0])
    const changed = { ...fixtures[0], payload: { ...fixtures[0].payload, weightKg: 83.8, metabolicAgeYears: 31 } }
    expect(() => ingestHealthEnvelope(changed)).toThrow(/HEALTH_INGESTION_IDENTITY_CONFLICT/)

    expect(listTwinObservations({ entityId: 'person:self' })).toHaveLength(first.observations.length)
    expect(listTwinObservations({ entityId: 'person:self', metric: 'health.body_composition.weight_kg' })[0].value).toBe(84.2)
    expect(listTwinEvents({ subjectId: 'person:self' })).toHaveLength(1)
    expect(withPersonalTwinDb(db => db.prepare('SELECT COUNT(*) count FROM twin_outbox').get()))
      .toEqual({ count: first.observations.length + 1 })
  })

  it('does not mutate canonical identity attributes on first ingestion or replay', async () => {
    const { ingestHealthEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const { getTwinEntity, upsertTwinEntity } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Li Hao', attributes: { locale: 'zh-CN' }, source: 'system', sourceId: 'self' })
    ingestHealthEnvelope(fixtures[4]); ingestHealthEnvelope(fixtures[4])
    expect(getTwinEntity('person:self')).toMatchObject({ label: 'Li Hao', attributes: { locale: 'zh-CN' } })
  })
})
