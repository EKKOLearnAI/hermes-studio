import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HealthIngestionEnvelope } from '../../packages/server/src/services/hermes/health-loop'

const observedAt = '2026-07-13T08:00:00.000Z'

const fixtures: HealthIngestionEnvelope[] = [
  { domain: 'body_composition', source: 'mi-s400', sourceId: 'reading-1', observedAt, evidenceClass: 'measured', confidence: 0.99,
    payload: { weightKg: 84.2, bmi: 26.6, bodyFatPercent: 21.4, muscleMassKg: 62.1, boneSaltKg: 3.2, bodyWaterPercent: 55.1, visceralFatLevel: 9, basalMetabolismKcal: 1840,
      proteinPercent: 18.2, subcutaneousFatPercent: 17.1, fatMassKg: 18, leanMassKg: 66.2, skeletalMusclePercent: 42.3, bodyScore: 82, idealWeightKg: 74,
      waistHipRatio: 0.89, bodyAgeYears: 31, deviceModel: 'xiaomi-s400' } },
  { domain: 'measurements', source: 'guided-measurement', sourceId: 'measurement-1', observedAt, evidenceClass: 'reported', confidence: 0.9,
    payload: { waistCm: 88, hipCm: 99, leftArmCm: 33, rightArmCm: 33.5, leftThighCm: 57, rightThighCm: 57.4, calibrationMethod: 'scale-reference', calibrationId: 'tape-2026',
      captureConditions: { lightingProfile: 'daylight', distanceCm: 180, deviceModel: 'pixel-9', view: 'front', scaleReference: 'a4-sheet' }, modelVersion: 'measure-2.1', modelConfidence: 0.83 } },
  { domain: 'posture', source: 'local-pose', sourceId: 'posture-1', observedAt, evidenceClass: 'inferred', confidence: 0.82,
    payload: { findings: [{ code: 'forward_head', severity: 0.4, confidence: 0.81 }], angles: { headForwardDeg: 12.5 }, landmarks: [{ name: 'left_shoulder', x: 0.31, y: 0.42, confidence: 0.91 }], capture: { views: ['front', 'side'], quality: 0.92 }, modelVersion: 'pose-1.2', modelConfidence: 0.84 } },
  { domain: 'skin', source: 'local-skin', sourceId: 'skin-1', observedAt, evidenceClass: 'inferred', confidence: 0.76,
    payload: { region: 'face', appearances: [{ type: 'redness', severity: 0.3 }], trend: 'stable', captureQuality: 0.88, lightingProfile: 'daylight', distanceCm: 40, device: 'pixel-9', comparisonBaseline: 'skin-baseline-2026-07' } },
  { domain: 'diet', source: 'meal-log', sourceId: 'meal-1', observedAt, evidenceClass: 'reported', confidence: 0.85,
    payload: { foods: [{ name: 'rice', portionGrams: 180 }], supplements: [{ name: 'creatine', amount: 5, unit: 'g' }], mealTime: '2026-07-13T12:10:00+08:00', caloriesKcal: 520, proteinG: 30, carbsG: 65, fatG: 14,
      micros: { fiberG: 8, sodiumMg: 640 }, waterMl: 350, parserConfidence: 0.86, portionConfirmed: true, confirmationStatus: 'confirmed' } },
  { domain: 'fitness', source: 'training-log', sourceId: 'workout-1', observedAt, evidenceClass: 'measured', confidence: 0.95,
    payload: { exercises: [{ name: 'squat', sets: [{ reps: 8, loadKg: 80, rpe: 8, completed: true }, { reps: 8, loadKg: 80, rpe: 8, completed: true }], muscles: ['quadriceps', 'glutes'] },
      { name: 'plank', sets: [{ durationSeconds: 60, completed: true }], muscles: ['core'] }], durationMinutes: 42, intensity: 'vigorous', muscles: ['quadriceps', 'glutes'], pain: 0, rpe: 8, trainingLoad: 320, completed: true } },
  { domain: 'sleep', source: 'mi-fitness', sourceId: 'sleep-1', observedAt, evidenceClass: 'measured', confidence: 0.93,
    payload: { startedAt: '2026-07-12T23:10:00+08:00', endedAt: '2026-07-13T06:40:00+08:00', durationMinutes: 450, interruptions: 2,
      stages: { deepMinutes: 90, remMinutes: 105, lightMinutes: 240 }, restingHeartRateBpm: 58, restingRespiratoryRateBrpm: 14, restingSpo2Percent: 97,
      freshnessMinutes: 20, subjectiveRecovery: 7, recoveryScore: 81 } },
  { domain: 'internal_health', source: 'report-parser', sourceId: 'report-1', observedAt, evidenceClass: 'inferred', confidence: 0.88,
    payload: { markers: [{ key: 'fasting_glucose', displayLabel: 'Fasting glucose', value: 5.2, unit: 'mmol/L', referenceInterval: { low: 3.9, high: 6.1 },
      providerFlag: 'normal', measuredAt: '2026-07-01T08:15:00+08:00', evidence: { page: 2, region: 'lab-table-row-4' } }],
      reportDate: '2026-07-01', institution: 'Example Hospital', reportArtifactId: `artifact-${'a'.repeat(64)}`, pendingConfirmation: true } },
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

  it('covers the complete approved canonical field set in each domain fixture', async () => {
    const { normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const metrics = (index: number) => Object.fromEntries(normalizeHealthIngestionEnvelope(fixtures[index]).observations.map(item => [item.metric, item]))

    expect(metrics(0)).toMatchObject({
      'health.body_composition.waist_hip_ratio': { value: 0.89 },
      'health.body_composition.device_model': { value: 'xiaomi-s400' },
      'health.body_composition.bone_mass_kg': { unit: 'kg' },
      'health.body_composition.metabolic_age_years': { unit: 'year' },
    })
    expect(metrics(1)).toMatchObject({
      'health.measurements.calibration_method': { value: 'scale-reference' },
      'health.measurements.capture_conditions': { value: { lightingProfile: 'daylight', distanceCm: 180, deviceModel: 'pixel-9', view: 'front', scaleReference: 'a4-sheet' } },
      'health.measurements.model_version': { value: 'measure-2.1' },
      'health.measurements.model_confidence': { value: 0.83 },
    })
    expect(metrics(2)).toMatchObject({ 'health.posture.landmarks': { value: [{ name: 'left_shoulder', x: 0.31, y: 0.42, confidence: 0.91 }] } })
    expect(metrics(3)).toMatchObject({
      'health.skin.lighting_profile': { value: 'daylight' }, 'health.skin.distance_cm': { value: 40, unit: 'cm' },
      'health.skin.device': { value: 'pixel-9' }, 'health.skin.comparison_baseline': { value: 'skin-baseline-2026-07' },
    })
    expect(metrics(4)).toMatchObject({
      'health.diet.meal_time': { value: '2026-07-13T12:10:00+08:00' }, 'health.diet.parser_confidence': { value: 0.86 },
      'health.diet.confirmation_status': { value: 'confirmed' },
      'health.diet.supplements': { value: [{ name: 'creatine', amount: 5, unit: 'g' }] },
    })
    expect(metrics(5)['health.fitness.exercises'].value).toEqual([
      expect.objectContaining({ name: 'squat', sets: [expect.objectContaining({ reps: 8, loadKg: 80 }), expect.objectContaining({ reps: 8, loadKg: 80 })] }),
      expect.objectContaining({ name: 'plank', sets: [{ durationSeconds: 60, completed: true }], muscles: ['core'] }),
    ])
    expect(metrics(5)['health.fitness.training_load']).toMatchObject({ value: 320 })
    expect(metrics(6)).toMatchObject({
      'health.sleep.resting_respiratory_rate_brpm': { unit: 'breath/min' }, 'health.sleep.resting_spo2_percent': { unit: '%' },
      'health.sleep.freshness_minutes': { unit: 'min' }, 'health.sleep.subjective_recovery': { value: 7 },
    })
    expect(metrics(7)['health.internal_health.markers'].value).toEqual([expect.objectContaining({
      key: 'fasting_glucose', displayLabel: 'Fasting glucose', measuredAt: '2026-07-01T08:15:00+08:00', referenceInterval: { low: 3.9, high: 6.1 },
      evidence: { page: 2, region: 'lab-table-row-4' },
    })])
  })

  it('sorts and deduplicates unordered semantic sets so reversed replay is a no-op', async () => {
    const { ingestHealthEnvelope, normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const findingA = { code: 'forward_head', severity: 0.4, confidence: 0.8 }
    const findingB = { code: 'shoulder_asymmetry', severity: 0.2, confidence: 0.9 }
    const appearanceA = { type: 'redness', severity: 0.3 }
    const appearanceB = { type: 'dryness', severity: 0.1 }
    const markerA = { key: 'fasting_glucose', displayLabel: 'Fasting glucose', value: 5.2, unit: 'mmol/L', measuredAt: observedAt, evidence: { page: 2, region: 'row-4' } }
    const markerB = { key: 'hba1c', displayLabel: 'HbA1c', value: 5.3, unit: '%', measuredAt: observedAt, evidence: { page: 2, region: 'row-5' } }
    const landmarkA = { name: 'left_shoulder', x: 0.3, y: 0.4, confidence: 0.9 }
    const landmarkB = { name: 'right_shoulder', x: 0.7, y: 0.4, confidence: 0.9 }
    const foodA = { name: 'rice', portionGrams: 180 }; const foodB = { name: 'chicken', portionGrams: 150 }
    const supplementA = { name: 'creatine', amount: 5, unit: 'g' }; const supplementB = { name: 'vitamin D', amount: 25, unit: 'ug' }
    const cases: Array<[HealthIngestionEnvelope, HealthIngestionEnvelope]> = [
      [{ ...fixtures[2], sourceId: 'posture-set', payload: { ...fixtures[2].payload, findings: [findingA, findingB, findingA], landmarks: [landmarkA, landmarkB, landmarkA] } },
        { ...fixtures[2], sourceId: 'posture-set', payload: { ...fixtures[2].payload, findings: [findingB, findingA], landmarks: [landmarkB, landmarkA] } }],
      [{ ...fixtures[3], sourceId: 'skin-set', payload: { ...fixtures[3].payload, appearances: [appearanceA, appearanceB, appearanceA] } },
        { ...fixtures[3], sourceId: 'skin-set', payload: { ...fixtures[3].payload, appearances: [appearanceB, appearanceA] } }],
      [{ ...fixtures[4], sourceId: 'diet-set', payload: { ...fixtures[4].payload, foods: [foodA, foodB, foodA], supplements: [supplementA, supplementB, supplementA] } },
        { ...fixtures[4], sourceId: 'diet-set', payload: { ...fixtures[4].payload, foods: [foodB, foodA], supplements: [supplementB, supplementA] } }],
      [{ ...fixtures[7], sourceId: 'marker-set', payload: { ...fixtures[7].payload, markers: [markerA, markerB, markerA] } },
        { ...fixtures[7], sourceId: 'marker-set', payload: { ...fixtures[7].payload, markers: [markerB, markerA] } }],
    ]
    for (const [first, reversed] of cases) {
      expect(normalizeHealthIngestionEnvelope(reversed)).toEqual(normalizeHealthIngestionEnvelope(first))
      const inserted = ingestHealthEnvelope(first); const replay = ingestHealthEnvelope(reversed)
      expect(replay.event.id).toBe(inserted.event.id)
      expect(replay.observations.map(item => item.id)).toEqual(inserted.observations.map(item => item.id))
    }

    const ordered = fixtures[5]
    const reversedExercises = { ...ordered, payload: { ...ordered.payload, exercises: [...(ordered.payload.exercises as unknown[])].reverse() } }
    expect(normalizeHealthIngestionEnvelope(reversedExercises).materialDigest)
      .not.toBe(normalizeHealthIngestionEnvelope(ordered).materialDigest)
  })

  it('rejects invalid newly approved fields in every domain with sanitized errors', async () => {
    const { HealthIngestionError, normalizeHealthIngestionEnvelope } = await import('../../packages/server/src/services/hermes/health-loop')
    const invalid: HealthIngestionEnvelope[] = [
      { ...fixtures[0], payload: { ...fixtures[0].payload, deviceModel: '   ' } },
      { ...fixtures[1], payload: { ...fixtures[1].payload, captureConditions: { unknown: true } } },
      { ...fixtures[2], payload: { ...fixtures[2].payload, landmarks: [{ name: 'nose', x: 11, y: 0.5, confidence: 1 }] } },
      { ...fixtures[3], payload: { ...fixtures[3].payload, distanceCm: 0 } },
      { ...fixtures[4], payload: { ...fixtures[4].payload, supplements: [{ name: 'creatine', amount: -1, unit: 'g' }] } },
      { ...fixtures[5], payload: { ...fixtures[5].payload, exercises: [{ name: 'squat', sets: [{ loadKg: 2_000 }] }] } },
      { ...fixtures[6], payload: { ...fixtures[6].payload, subjectiveRecovery: 11 } },
      { ...fixtures[7], payload: { ...fixtures[7].payload, markers: [{ key: 'glucose', displayLabel: 'Glucose', value: 5, unit: 'mmol/L', evidence: { page: 0 } }] } },
    ]
    for (const envelope of invalid) expect(() => normalizeHealthIngestionEnvelope(envelope)).toThrow(HealthIngestionError)
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
