import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TwinObservation } from '../../packages/server/src/services/hermes/personal-twin'

const computedAt = '2026-07-14T12:00:00.000Z'

function observation(overrides: Partial<TwinObservation> & Pick<TwinObservation, 'id' | 'metric' | 'value'>): TwinObservation {
  return {
    entityId: 'person:self',
    unit: null,
    observedAt: '2026-07-14T08:00:00.000Z',
    ingestedAt: '2026-07-14T08:00:01.000Z',
    provenance: {
      source: 'fixture', sourceId: overrides.id, actor: 'fixture', confidence: 0.9,
      confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1,
    },
    ...overrides,
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

describe('health-loop deterministic projectors', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-projectors-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('builds all nine exact envelopes and is hash-stable under input permutation', async () => {
    const { computeHealthProjections, HEALTH_PROJECTION_KEYS } = await import('../../packages/server/src/services/hermes/health-loop')
    const records = [
      observation({ id: 'weight-new', metric: 'health.body_composition.weight_kg', value: 82, unit: 'kg' }),
      observation({ id: 'sleep', metric: 'health.sleep.duration_minutes', value: 450, unit: 'min' }),
      observation({ id: 'meal', metric: 'health.diet.protein_g', value: 35, unit: 'g' }),
      observation({ id: 'load', metric: 'health.fitness.training_load', value: 240 }),
    ]
    const first = computeHealthProjections(records, { computedAt, ruleVersion: 'health-rules-fixture-v7' })
    const second = computeHealthProjections([...records].reverse(), { computedAt, ruleVersion: 'health-rules-fixture-v7' })

    expect(Object.keys(first)).toEqual(HEALTH_PROJECTION_KEYS)
    expect(digest(first)).toBe(digest(second))
    for (const key of HEALTH_PROJECTION_KEYS) {
      expect(Object.keys(first[key])).toEqual([
        'schemaVersion', 'ruleVersion', 'state', 'inputRecordIds', 'effectiveAt', 'computedAt',
        'freshness', 'confidence', 'conflicts', 'missing', 'rationale',
      ])
      expect(first[key]).toMatchObject({ schemaVersion: 1, ruleVersion: 'health-rules-fixture-v7', computedAt })
      expect(first[key].rationale.every(item => !/diagnos/i.test(item.message))).toBe(true)
    }
    expect(first['health.body_composition_state'].state).toMatchObject({ current: { weight_kg: { value: 82, unit: 'kg' } } })
    expect(first['health.readiness_state'].inputRecordIds).toEqual(['load', 'meal', 'sleep', 'weight-new'])
    expect(Object.keys(first['health.readiness_state'].state.dependencies)).toEqual([
      'bodyComposition', 'internal', 'nutrition', 'posture', 'recovery', 'skin', 'training',
    ])
    expect(JSON.stringify(first)).not.toContain('artifact-')
  })

  it('uses source identity tie-breaks and keeps skin reports beside vision estimates', async () => {
    const { computeHealthProjections } = await import('../../packages/server/src/services/hermes/health-loop')
    const result = computeHealthProjections([
      observation({ id: 'measured-z', metric: 'health.body_composition.weight_kg', value: 82, unit: 'kg',
        provenance: { source: 'z-scale', sourceId: 'reading-z', actor: 'fixture', confidence: 0.9, confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 } }),
      observation({ id: 'inferred-a', metric: 'health.body_composition.weight_kg', value: 82, unit: 'kg',
        provenance: { source: 'a-model', sourceId: 'reading-a', actor: 'fixture', confidence: 0.7, confirmationState: 'inferred', evidence: [{ evidenceClass: 'inferred' }], schemaVersion: 1 } }),
      observation({ id: 'skin-report', metric: 'health.skin.reported_concerns', value: ['dryness'],
        provenance: { source: 'user', sourceId: 'skin-report', actor: 'fixture', confidence: 0.9, confirmationState: 'reported', evidence: [{ evidenceClass: 'reported' }], schemaVersion: 1 } }),
      observation({ id: 'skin-vision', metric: 'health.skin.appearances', value: [{ type: 'redness', severity: 0.3 }],
        provenance: { source: 'local-vision', sourceId: 'skin-vision', actor: 'fixture', confidence: 0.75, confirmationState: 'inferred', evidence: [{ evidenceClass: 'inferred' }], schemaVersion: 1 } }),
    ], { computedAt })
    expect(result['health.body_composition_state'].state.current).toMatchObject({ weight_kg: { recordId: 'inferred-a' } })
    expect(result['health.skin_state'].state.evidence).toMatchObject({
      reported: [expect.objectContaining({ recordId: 'skin-report' })],
      inferred: [expect.objectContaining({ recordId: 'skin-vision' })],
    })
  })

  it('canonicalizes structured values independently of object insertion order', async () => {
    const { computeHealthProjections } = await import('../../packages/server/src/services/hermes/health-loop')
    const left = observation({ id: 'posture-canonical', metric: 'health.posture.findings',
      value: [{ code: 'forward_head', severity: 0.4, confidence: 0.8 }],
      provenance: { source: 'vision', sourceId: 'canonical', actor: 'fixture', confidence: 0.8, confirmationState: 'inferred', evidence: [{ evidenceClass: 'inferred' }], schemaVersion: 1 } })
    const right = observation({ id: 'posture-canonical', metric: 'health.posture.findings',
      value: [{ confidence: 0.8, severity: 0.4, code: 'forward_head' }],
      provenance: left.provenance })
    expect(digest(computeHealthProjections([left], { computedAt }))).toBe(digest(computeHealthProjections([right], { computedAt })))
  })

  it('does not let a fresh fitness record disguise stale sleep recovery evidence', async () => {
    const { computeHealthProjections } = await import('../../packages/server/src/services/hermes/health-loop')
    const recovery = computeHealthProjections([
      observation({ id: 'old-sleep', metric: 'health.sleep.duration_minutes', value: 420, unit: 'min', observedAt: '2026-07-10T00:00:00.000Z' }),
      observation({ id: 'fresh-pain', metric: 'health.fitness.pain', value: 2, observedAt: '2026-07-14T11:00:00.000Z' }),
    ], { computedAt })['health.recovery_state']
    expect(recovery.freshness.status).toBe('stale')
    expect(recovery.state.current).toMatchObject({ duration_minutes: { value: 420 }, 'fitness.pain': { value: 2 } })
    expect(recovery.inputRecordIds).toEqual(['fresh-pain', 'old-sleep'])
  })

  it('keeps evidence classes separate and exposes deterministic value, unit, and source conflicts', async () => {
    const { computeHealthProjections } = await import('../../packages/server/src/services/hermes/health-loop')
    const records = [
      observation({ id: 'reported-posture', metric: 'health.posture.reported_issues', value: ['neck_tension'],
        provenance: { source: 'user', sourceId: 'posture-report', actor: 'fixture', confidence: 0.8, confirmationState: 'reported', evidence: [{ evidenceClass: 'reported' }], schemaVersion: 1 } }),
      observation({ id: 'vision-posture', metric: 'health.posture.findings', value: [{ code: 'forward_head', severity: 0.4, confidence: 0.8 }],
        provenance: { source: 'local-vision', sourceId: 'posture-vision', actor: 'fixture', confidence: 0.8, confirmationState: 'inferred', evidence: [{ evidenceClass: 'inferred' }], schemaVersion: 1 } }),
      observation({ id: 'weight-a', metric: 'health.body_composition.weight_kg', value: 82, unit: 'kg',
        provenance: { source: 'scale-a', sourceId: 'same', actor: 'fixture', confidence: 0.9, confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 } }),
      observation({ id: 'weight-b', metric: 'health.body_composition.weight_kg', value: 83, unit: 'kg',
        provenance: { source: 'scale-b', sourceId: 'same', actor: 'fixture', confidence: 0.9, confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 } }),
      observation({ id: 'weight-c', metric: 'health.body_composition.weight_kg', value: 181, unit: 'lb',
        provenance: { source: 'scale-c', sourceId: 'third', actor: 'fixture', confidence: 0.9, confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 } }),
    ]
    const result = computeHealthProjections(records, { computedAt })
    const posture = result['health.posture_state']
    const body = result['health.body_composition_state']

    expect(posture.state.evidence).toMatchObject({ reported: [expect.objectContaining({ recordId: 'reported-posture' })], inferred: [expect.objectContaining({ recordId: 'vision-posture' })] })
    expect(posture.inputRecordIds).toEqual(['reported-posture', 'vision-posture'])
    expect(body.state.current).not.toHaveProperty('weight_kg')
    expect(body.conflicts.map(item => item.code)).toEqual(expect.arrayContaining(['SOURCE_CONFLICT', 'UNIT_CONFLICT', 'VALUE_CONFLICT']))
    expect(body.conflicts.flatMap(item => item.recordIds)).toEqual(expect.arrayContaining(['weight-a', 'weight-b', 'weight-c']))
    expect(body.inputRecordIds).toEqual(['weight-a', 'weight-b', 'weight-c'])
  })

  it('uses versioned freshness thresholds with deterministic inclusive boundaries and rejects future/corrupt facts', async () => {
    const { computeHealthProjections, HEALTH_FRESHNESS_POLICY } = await import('../../packages/server/src/services/hermes/health-loop')
    const boundary = observation({ id: 'sleep-boundary', metric: 'health.sleep.duration_minutes', value: 420, unit: 'min', observedAt: '2026-07-13T00:00:00.000Z' })
    const fresh = computeHealthProjections([boundary], { computedAt: '2026-07-14T12:00:00.000Z' })['health.recovery_state']
    const stale = computeHealthProjections([boundary], { computedAt: '2026-07-14T12:00:00.001Z' })['health.recovery_state']
    expect(HEALTH_FRESHNESS_POLICY).toMatchObject({ version: 'health-freshness-v1', recovery: { thresholdMs: 36 * 60 * 60 * 1000 } })
    expect(fresh.freshness.status).toBe('fresh')
    expect(stale.freshness.status).toBe('stale')
    expect(stale.state.current).toMatchObject({ duration_minutes: { value: 420 } })

    const unsafe = computeHealthProjections([
      observation({ id: 'future-sleep', metric: 'health.sleep.duration_minutes', value: 480, unit: 'min', observedAt: '2026-07-15T00:00:00.000Z' }),
      observation({ id: 'bad-time', metric: 'health.sleep.recovery_score', value: 90, observedAt: 'not-a-time' }),
      observation({ id: 'bad-value', metric: 'health.sleep.duration_minutes', value: Number.NaN, unit: 'min' }),
      observation({ id: 'poison-value', metric: 'health.sleep.stages', value: JSON.parse('{"constructor":{"polluted":true}}'), unit: 'min' }),
      observation({ id: 'foreign-record', entityId: 'person:other', metric: 'health.sleep.recovery_score', value: 99 }),
    ], { computedAt })['health.recovery_state']
    expect(unsafe.freshness.status).not.toBe('fresh')
    expect(unsafe.conflicts.map(item => item.code)).toEqual(expect.arrayContaining(['FUTURE_RECORD', 'INVALID_RECORD']))
    expect(unsafe.state.current).not.toHaveProperty('stages')
    expect(unsafe.state.current).not.toHaveProperty('recovery_score')
    expect(unsafe.inputRecordIds).toEqual(['bad-time', 'bad-value', 'foreign-record', 'future-sleep', 'poison-value'])
  })

  it('keeps first internal reports pending and out of confirmed current state', async () => {
    const { computeHealthProjections } = await import('../../packages/server/src/services/hermes/health-loop')
    const pending = observation({ id: 'pending-lab', metric: 'health.internal_health.markers',
      value: [{ key: 'fasting_glucose', value: 5.2, unit: 'mmol/L', displayLabel: 'private full report title', evidence: { page: 2 } }],
      provenance: { source: 'local-parser', sourceId: 'report-1', actor: 'fixture', confidence: 0.88, confirmationState: 'inferred', evidence: [{ evidenceClass: 'measured', artifactIds: [`artifact-${'a'.repeat(64)}`] }], schemaVersion: 1 } })
    const confirmed = observation({ id: 'confirmed-lab', metric: 'health.internal_health.markers', observedAt: '2026-07-13T08:00:00.000Z',
      value: [{ key: 'resting_hr', value: 60, unit: 'bpm' }],
      provenance: { source: 'user-confirmation', sourceId: 'report-0', actor: 'user', confidence: 0.9, confirmationState: 'confirmed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 } })
    const projection = computeHealthProjections([pending, confirmed], { computedAt })['health.internal_state']

    expect(projection.state.pending).toEqual([expect.objectContaining({ recordId: 'pending-lab', markers: [expect.objectContaining({ key: 'fasting_glucose' })] })])
    expect(projection.state.confirmed).toEqual([expect.objectContaining({ recordId: 'confirmed-lab' })])
    expect(JSON.stringify(projection.state.confirmed)).not.toContain('fasting_glucose')
    expect(JSON.stringify(projection)).not.toContain('artifact-')
    expect(JSON.stringify(projection)).not.toContain('private full report title')
    expect(projection.inputRecordIds).toEqual(['confirmed-lab', 'pending-lab'])
  })

  it('derives finite conservative health math without inventing missing inputs', async () => {
    const { calculateVelocity, rollingSum, roundHealthNumber, weightedConfidence, computeHealthProjections } = await import('../../packages/server/src/services/hermes/health-loop')
    expect(calculateVelocity([{ at: 0, value: 82 }, { at: 7 * 86_400_000, value: 81 }], 86_400_000)).toEqual({ perDay: -0.1429, sampleCount: 2, spanMs: 604_800_000 })
    expect(calculateVelocity([{ at: 0, value: 82 }, { at: 1_000, value: 81 }], 86_400_000)).toBeNull()
    expect(calculateVelocity([{ at: 0, value: 82 }, { at: 0, value: 81 }], 0)).toBeNull()
    expect(calculateVelocity([{ at: 0, value: 82 }, { at: 86_400_000, value: 120 }], 86_400_000, 5)).toBeNull()
    expect(rollingSum([{ at: 0, value: 10 }, { at: 10, value: 5 }, { at: 20, value: Number.NaN }], 20, 20)).toBeNull()
    expect(weightedConfidence([{ confidence: 0.8, weight: 1 }, { confidence: 1, weight: 3 }])).toBe(0.95)
    expect(weightedConfidence([{ confidence: 1, weight: 0 }])).toBeNull()
    expect(roundHealthNumber(1 / 3, 4)).toBe(0.3333)

    const empty = computeHealthProjections([], { computedAt })
    expect(empty['health.fat_loss_state'].state).toMatchObject({ weightKg: null, weightVelocityKgPerWeek: null })
    expect(empty['health.nutrition_state'].state).toMatchObject({ totals: null })
    expect(empty['health.training_state'].state).toMatchObject({ load7d: null })
    expect(empty['health.recovery_state'].state).toMatchObject({ current: {} })
    expect(empty['health.readiness_state'].state).toMatchObject({ status: 'insufficient', score: null })
    expect(empty['health.readiness_state'].missing.length).toBeGreaterThan(0)
  })

  it('atomically CAS-persists nine live projections, rolls back conflicts, and skips historical replay writes', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-loop')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    twin.upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    twin.writeTwinProjection({ key: 'legacy:custom', subjectId: 'person:self', value: { retained: true }, sourceRecordId: 'legacy', updatedAt: computedAt })
    const values = health.computeHealthProjections([
      observation({ id: 'weight', metric: 'health.body_composition.weight_kg', value: 82, unit: 'kg' }),
    ], { computedAt })

    const first = health.persistHealthProjections(values, { expectedVersions: Object.fromEntries(health.HEALTH_PROJECTION_KEYS.map(key => [key, 0])) })
    expect(first).toHaveLength(9)
    expect(first.every(item => item.version === 1)).toBe(true)
    expect(twin.getTwinProjection('legacy:custom', 'person:self')?.value).toEqual({ retained: true })

    const next = health.computeHealthProjections([], { computedAt: '2026-07-14T12:01:00.000Z' })
    expect(() => health.persistHealthProjections(next, { expectedVersions: { ...Object.fromEntries(health.HEALTH_PROJECTION_KEYS.map(key => [key, 1])), 'health.skin_state': 0 } }))
      .toThrow('TWIN_PROJECTION_CONFLICT')
    expect(health.HEALTH_PROJECTION_KEYS.map(key => twin.getTwinProjection(key, 'person:self')?.version)).toEqual(Array(9).fill(1))

    const historical = health.projectHealthState([], { computedAt: '2026-01-01T00:00:00.000Z', cutoffAt: '2025-12-31T00:00:00.000Z', historical: true })
    expect(historical.persisted).toEqual([])
    expect(health.HEALTH_PROJECTION_KEYS.map(key => twin.getTwinProjection(key, 'person:self')?.version)).toEqual(Array(9).fill(1))
  })

  it('fails closed above the explicit immutable input bound', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-loop')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    const { computeHealthProjections, MAX_HEALTH_PROJECTION_INPUTS } = health
    const records = Array.from({ length: MAX_HEALTH_PROJECTION_INPUTS + 1 }, (_, index) => observation({
      id: `weight-${index}`, metric: 'health.body_composition.weight_kg', value: 82, unit: 'kg',
    }))
    expect(() => computeHealthProjections(records, { computedAt })).toThrow('HEALTH_PROJECTION_INPUT_LIMIT')

    twin.upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    const bounded = computeHealthProjections(records.slice(0, MAX_HEALTH_PROJECTION_INPUTS), { computedAt })
    expect(() => health.persistHealthProjections(bounded)).not.toThrow()
  })
})
