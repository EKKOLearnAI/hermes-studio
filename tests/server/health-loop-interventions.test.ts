import { describe, expect, it } from 'vitest'
import type { TwinObservation, TwinProjection } from '../../packages/server/src/services/hermes/personal-twin'
import {
  HEALTH_PROJECTION_KEYS,
  healthProjectionSourceRecordId,
  type HealthProjectionKey,
  type HealthProjectionSet,
} from '../../packages/server/src/services/hermes/health-loop'

const now = '2026-07-14T12:00:00Z'

function signProjections(values: TwinProjection[]): TwinProjection[] {
  const envelopes = Object.fromEntries(HEALTH_PROJECTION_KEYS.map(key => [
    key, values.find(item => item.key === key)!.value,
  ])) as unknown as HealthProjectionSet
  const sourceRecordId = healthProjectionSourceRecordId(envelopes)
  return values.map(item => ({ ...item, sourceRecordId }))
}

function projection(key: HealthProjectionKey, state: Record<string, unknown>, overrides: {
  freshness?: 'fresh' | 'stale' | 'missing' | 'conflict'
  conflicts?: Array<Record<string, unknown>>
  missing?: string[]
  confidence?: number
  version?: number
} = {}): TwinProjection {
  if (key === 'health.nutrition_state' && !state.current) {
    const totals = state.totals as Record<string, unknown> | undefined
    if (typeof totals?.protein_g === 'number') state.current = { protein_g: { value: totals.protein_g, unit: 'g' } }
  }
  const conflicts = overrides.conflicts ?? []
  const current = state.current && typeof state.current === 'object' && !Array.isArray(state.current)
    ? state.current as Record<string, unknown> : null
  const normalizedCurrent = state.current && typeof state.current === 'object' && !Array.isArray(state.current)
    ? state.current as Record<string, unknown> : null
  const evidence: Array<Record<string, unknown>> = []
  if (normalizedCurrent) for (const [field, raw] of Object.entries(normalizedCurrent)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    entry.recordId ??= `record-${key}-${field}`
    entry.observedAt ??= overrides.freshness === 'stale' ? '2026-07-10T08:00:00Z' : '2026-07-14T08:00:00Z'
    entry.evidenceClass ??= 'measured'
    evidence.push({ recordId: entry.recordId, confidence: overrides.confidence ?? 0.9 })
  }
  if (evidence.length && state.evidence === undefined) state.evidence = { measured: evidence, reported: [], inferred: [], derived: [] }
  return {
    key,
    subjectId: 'person:self',
    version: overrides.version ?? 3,
    sourceRecordId: 'unsigned',
    updatedAt: now,
    value: {
      schemaVersion: 1,
      ruleVersion: 'health-rules-fixture-v1',
      state,
      inputRecordIds: [`record-${key}`],
      effectiveAt: '2026-07-14T08:00:00Z',
      computedAt: now,
      freshness: {
        policyVersion: 'health-freshness-v1',
        status: overrides.freshness ?? 'fresh',
        thresholdMs: key === 'health.internal_state' ? 180 * 86_400_000 : 86_400_000,
        ageMs: 14_400_000,
      },
      confidence: overrides.confidence ?? 0.9,
      conflicts,
      conflictCount: conflicts.length,
      conflictOmittedCount: 0,
      missing: overrides.missing ?? [],
      rationale: [{ code: 'HEALTH_STATE_CURRENT', message: 'fixture' }],
    },
  }
}

function projections(): TwinProjection[] {
  return signProjections([
    projection('health.body_composition_state', { current: { weight_kg: { value: 80, unit: 'kg' } } }, { version: 1 }),
    projection('health.fat_loss_state', { weightKg: 80, weightVelocityKgPerWeek: -0.2, sampleCount: 7 }, { version: 2 }),
    projection('health.nutrition_state', { totals: { calories_kcal: 1900, protein_g: 130 }, windowHours: 24 }, { version: 3 }),
    projection('health.training_state', { current: { intensity: { value: 'moderate' }, pain: { value: 0 } }, load7d: 500, sessions: 3 }, { version: 4 }),
    projection('health.recovery_state', { current: { duration_minutes: { value: 480 }, 'fitness.pain': { value: 0 } } }, { version: 5 }),
    projection('health.posture_state', { current: { findings: { value: [] }, reported_compensation_chain: { value: [] } } }, { version: 6 }),
    projection('health.skin_state', { current: { capture_quality: { value: 0.9 }, appearances: { value: [] } } }, { version: 7 }),
    projection('health.internal_state', { confirmed: [], pending: [], confirmedCount: 0, pendingCount: 0 }, { version: 8 }),
    projection('health.readiness_state', { status: 'ready', score: 82, dependencies: {} }, { version: 9 }),
  ])
}

function replace(values: TwinProjection[], next: TwinProjection): TwinProjection[] {
  return signProjections(values.map(item => item.key === next.key ? next : item))
}

function observation(overrides: Partial<TwinObservation> & Pick<TwinObservation, 'id' | 'metric' | 'value'>): TwinObservation {
  return {
    entityId: 'person:self', unit: null, observedAt: '2026-07-14T08:00:00Z', ingestedAt: '2026-07-14T08:00:01Z',
    provenance: { source: 'fixture', sourceId: overrides.id, actor: 'fixture', confidence: 0.9,
      confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 },
    ...overrides,
  }
}

async function realProjections(records: TwinObservation[], computedAt = now): Promise<TwinProjection[]> {
  const { computeHealthProjections } = await import('../../packages/server/src/services/hermes/health-loop')
  const computed = computeHealthProjections(records, { computedAt })
  return signProjections(HEALTH_PROJECTION_KEYS.map((key, index) => ({
    key, subjectId: 'person:self', version: index + 1, sourceRecordId: 'unsigned', updatedAt: computedAt,
    value: computed[key] as unknown as Record<string, unknown>,
  })))
}

describe('health-loop cross-domain intervention engine', () => {
  it('uses candidate-specific evidence gates with real Task 8 projections', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')

    const severePain = await realProjections([observation({ id: 'pain-9', metric: 'health.fitness.pain', value: 9 })])
    expect(decideHealthInterventions({ projections: severePain, now }).primary).toMatchObject({
      id: 'health.safety.severe_pain_notice', authority: 'inform_only', capabilityId: null,
    })

    const materialPain = await realProjections([observation({ id: 'pain-5', metric: 'health.fitness.pain', value: 5 })])
    const painDecision = decideHealthInterventions({ projections: materialPain, now, plan: { trainingIntensity: 'high' } })
    expect([painDecision.primary, ...painDecision.alternatives]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'health.safety.pain_followup', authority: 'approval' }),
      expect.objectContaining({ id: 'health.training.reduce_after_pain', authority: 'approval', capabilityId: 'health.plan.adjust' }),
    ]))
    expect(painDecision.primary?.id).toBe('health.training.reduce_after_pain')

    const lowRecovery = await realProjections([observation({ id: 'recovery-35', metric: 'health.sleep.recovery_score', value: 35 })])
    expect(decideHealthInterventions({ projections: lowRecovery, now, plan: { trainingIntensity: 'high' } }).primary).toMatchObject({
      id: 'health.training.reduce_after_low_recovery', risk: 'low', authority: 'auto',
    })

    const pendingLab = await realProjections([observation({
      id: 'pending-lab', metric: 'health.internal_health.markers',
      value: [{ key: 'marker_a', value: 4.2, unit: 'u/L' }],
      provenance: { source: 'fixture', sourceId: 'pending-lab', actor: 'fixture', confidence: 0.7,
        confirmationState: 'inferred', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 },
    })])
    expect(decideHealthInterventions({ projections: pendingLab, now }).primary).toMatchObject({
      id: 'health.internal.request_marker_metadata', capabilityId: 'health.checkin.request',
    })

    const oldCriticalLab = await realProjections([observation({
      id: 'critical-lab', metric: 'health.internal_health.markers', observedAt: '2025-01-01T08:00:00Z',
      value: [{ key: 'marker_b', value: 20, unit: 'u/L', referenceInterval: { low: 1, high: 10 },
        measuredAt: '2025-01-01T08:00:00Z', providerFlag: 'critical' }],
      provenance: { source: 'fixture', sourceId: 'critical-lab', actor: 'fixture', confidence: 0.2,
        confirmationState: 'confirmed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 },
    })])
    expect(decideHealthInterventions({ projections: oldCriticalLab, now }).primary).toMatchObject({
      id: 'health.internal.critical_provider_flag_notice', risk: 'critical', authority: 'inform_only', capabilityId: null,
    })

    const lowQualitySkin = await realProjections([observation({
      id: 'skin-quality', metric: 'health.skin.capture_quality', value: 0.3,
      provenance: { source: 'fixture', sourceId: 'skin-quality', actor: 'fixture', confidence: 0.4,
        confirmationState: 'inferred', evidence: [{ evidenceClass: 'inferred' }], schemaVersion: 1 },
    })])
    expect(decideHealthInterventions({ projections: lowQualitySkin, now }).primary).toMatchObject({
      id: 'health.skin.request_recapture', capabilityId: 'health.checkin.request',
    })
  })

  it('uses a protein-only real Task 8 observation for shortage and gates on that signal', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = await realProjections([
      observation({ id: 'protein', metric: 'health.diet.protein_g', value: 50, unit: 'g' }),
    ])
    const nutrition = values.find(item => item.key === 'health.nutrition_state')!.value.state as Record<string, unknown>
    expect(nutrition).toMatchObject({
      current: { protein_g: { value: 50, recordId: 'protein', observedAt: '2026-07-14T08:00:00Z' } },
      totals: { protein_g: 50 },
      evidence: { measured: [expect.objectContaining({ recordId: 'protein', confidence: 0.9 })] },
    })
    expect(decideHealthInterventions({ projections: values, now,
      plan: { resistanceTrainingToday: true, proteinTargetG: 120 } }).primary).toMatchObject({
      id: 'health.nutrition.close_protein_gap', risk: 'low', authority: 'auto',
    })

    const stale = await realProjections([
      observation({ id: 'protein-stale', metric: 'health.diet.protein_g', value: 50, unit: 'g' }),
    ])
    expect(decideHealthInterventions({ projections: stale, now: '2026-07-16T00:00:01Z',
      plan: { resistanceTrainingToday: true, proteinTargetG: 120 } }).considered).toContainEqual({
      id: 'health.nutrition.close_protein_gap', accepted: false, reason: 'source_stale',
    })

    const lowConfidence = await realProjections([observation({
      id: 'protein-low-confidence', metric: 'health.diet.protein_g', value: 50, unit: 'g',
      provenance: { source: 'fixture', sourceId: 'protein-low-confidence', actor: 'fixture', confidence: 0.2,
        confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 },
    })])
    expect(decideHealthInterventions({ projections: lowConfidence, now,
      plan: { resistanceTrainingToday: true, proteinTargetG: 120 } }).considered).toContainEqual({
      id: 'health.nutrition.close_protein_gap', accepted: false, reason: 'source_low_confidence',
    })

    const conflict = await realProjections([
      observation({ id: 'protein-a', metric: 'health.diet.protein_g', value: 50, unit: 'g' }),
      observation({ id: 'protein-b', metric: 'health.diet.protein_g', value: 60, unit: 'g' }),
    ])
    expect(decideHealthInterventions({ projections: conflict, now,
      plan: { resistanceTrainingToday: true, proteinTargetG: 120 } }).primary).toBeNull()
    expect((conflict.find(item => item.key === 'health.nutrition_state')!.value.conflicts as Array<{ metric: string }>))
      .toContainEqual(expect.objectContaining({ metric: 'health.diet.protein_g' }))

    const conflictGate = replace(projections(), projection('health.nutrition_state', {
      current: { protein_g: { value: 50, unit: 'g' } }, totals: { protein_g: 50 }, windowHours: 24,
    }, { freshness: 'conflict', conflicts: [{
      code: 'VALUE_CONFLICT', metric: 'health.diet.protein_g',
      recordIds: ['record-health.nutrition_state-protein_g'], recordCount: 1, omittedRecordCount: 0,
      message: 'fixture protein conflict',
    }] }))
    expect(decideHealthInterventions({ projections: conflictGate, now,
      plan: { resistanceTrainingToday: true, proteinTargetG: 120 } }).considered).toContainEqual({
      id: 'health.nutrition.close_protein_gap', accepted: false, reason: 'source_conflict',
    })
  })

  it('accepts safely representable old projection ages and still emits an informational safety notice', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const old = await realProjections([observation({
      id: 'old-critical-lab', metric: 'health.internal_health.markers', observedAt: '2010-01-01T08:00:00Z',
      value: [{ key: 'marker_old', value: 20, unit: 'u/L', referenceInterval: { low: 1, high: 10 },
        measuredAt: '2010-01-01T08:00:00Z', providerFlag: 'critical' }],
      provenance: { source: 'fixture', sourceId: 'old-critical-lab', actor: 'fixture', confidence: 0.2,
        confirmationState: 'confirmed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 },
    })])
    expect(decideHealthInterventions({ projections: old, now }).primary).toMatchObject({
      id: 'health.internal.critical_provider_flag_notice', authority: 'inform_only',
    })
  })

  it('ranks critical informational safety above high risk regardless of confidence', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = await realProjections([
      observation({ id: 'sleep-for-confidence', metric: 'health.sleep.duration_minutes', value: 420, unit: 'min',
        provenance: { source: 'fixture', sourceId: 'sleep-for-confidence', actor: 'fixture', confidence: 0.99,
          confirmationState: 'observed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 } }),
      observation({ id: 'pain-high-confidence', metric: 'health.fitness.pain', value: 9,
        provenance: { source: 'fixture', sourceId: 'pain-high-confidence', actor: 'fixture', confidence: 0.99,
          confirmationState: 'reported', evidence: [{ evidenceClass: 'reported' }], schemaVersion: 1 } }),
      observation({ id: 'critical-low-confidence', metric: 'health.internal_health.markers',
        value: [{ key: 'marker_critical', value: 20, unit: 'u/L', referenceInterval: { low: 1, high: 10 },
          measuredAt: '2026-07-14T08:00:00Z', providerFlag: 'critical' }],
        provenance: { source: 'fixture', sourceId: 'critical-low-confidence', actor: 'fixture', confidence: 0.1,
          confirmationState: 'confirmed', evidence: [{ evidenceClass: 'measured' }], schemaVersion: 1 } }),
    ])
    const result = decideHealthInterventions({ projections: values, now })
    expect(result.primary?.id).toBe('health.internal.critical_provider_flag_notice')
    expect(result.alternatives[0]?.id).toBe('health.safety.severe_pain_notice')
  })

  it('rejects projection snapshots computed or updated after decision now', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const future = await realProjections([
      observation({ id: 'future-sleep-input', metric: 'health.sleep.duration_minutes', value: 300, unit: 'min' }),
    ], '2026-07-15T12:00:00Z')
    expect(() => decideHealthInterventions({ projections: future, now, plan: { trainingIntensity: 'high' } }))
      .toThrow('HEALTH_INTERVENTION_FUTURE_SNAPSHOT')
  })

  it('uses the oldest contributing signal for multi-signal freshness', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = await realProjections([
      observation({ id: 'old-posture', metric: 'health.posture.findings', observedAt: '2026-05-01T08:00:00Z',
        value: [{ code: 'right_shoulder', severity: 0.7, confidence: 0.8 }],
        provenance: { source: 'fixture', sourceId: 'old-posture', actor: 'fixture', confidence: 0.8,
          confirmationState: 'inferred', evidence: [{ evidenceClass: 'inferred' }], schemaVersion: 1 } }),
      observation({ id: 'new-chain', metric: 'health.posture.reported_compensation_chain',
        value: ['right_shoulder'], provenance: { source: 'fixture', sourceId: 'new-chain', actor: 'fixture', confidence: 0.9,
          confirmationState: 'reported', evidence: [{ evidenceClass: 'reported' }], schemaVersion: 1 } }),
    ])
    const result = decideHealthInterventions({ projections: values, now,
      plan: { trainingIntensity: 'high', trainingChains: ['right_shoulder'] } })
    expect(result.primary).toBeNull()
    expect(result.considered).toContainEqual({
      id: 'health.posture.reduce_chain_overload', accepted: false, reason: 'source_stale',
    })
  })
  it('lets low sleep override hard training with one low-risk automatic plan action', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 300 }, 'fitness.pain': { value: 0 } },
    }, { version: 15 }))
    const result = decideHealthInterventions({
      projections: values, now,
      plan: { trainingIntensity: 'high' },
    })

    expect(Object.keys(result)).toEqual(['primary', 'alternatives', 'considered', 'projectionVersions', 'ruleVersion', 'decidedAt'])
    expect(result.primary).toMatchObject({
      id: 'health.training.reduce_after_low_sleep', ruleId: 'HL-RULE-001', category: 'training',
      capabilityId: 'health.plan.adjust', risk: 'low', authority: 'auto',
    })
    expect(result.primary?.scoreTuple).toHaveLength(7)
    expect(result.alternatives).toEqual([])
    expect(result.projectionVersions['health.recovery_state']).toBe(15)
    expect(result.decidedAt).toBe(now)
  })

  it('escalates material pain for approval and never makes high pain executable', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const moderate = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 420 }, 'fitness.pain': { value: 6 } },
    }))
    expect(decideHealthInterventions({ projections: moderate, now }).primary).toMatchObject({
      id: 'health.safety.pain_followup', ruleId: 'HL-RULE-002', risk: 'medium', authority: 'approval',
      capabilityId: 'health.followup.schedule',
    })

    const severe = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 420 }, 'fitness.pain': { value: 9 } },
    }))
    expect(decideHealthInterventions({ projections: severe, now }).primary).toMatchObject({
      id: 'health.safety.severe_pain_notice', risk: 'high', authority: 'inform_only', capabilityId: null,
    })
  })

  it('flags unsafe weight-loss velocity without diagnosing or changing supplements', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.fat_loss_state', {
      weightKg: 80, weightVelocityKgPerWeek: -1.1, sampleCount: 8,
    }))
    const result = decideHealthInterventions({ projections: values, now })
    expect(result.primary).toMatchObject({
      id: 'health.nutrition.review_unsafe_weight_loss', ruleId: 'HL-RULE-003',
      risk: 'medium', authority: 'approval', capabilityId: 'health.plan.adjust',
    })
    expect(JSON.stringify(result)).not.toMatch(/medication|supplement.dose|diagnos|emergency.disposition/i)
  })

  it('prioritizes a protein shortage on a resistance-training day', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.nutrition_state', {
      totals: { calories_kcal: 1800, protein_g: 55 }, windowHours: 24,
    }))
    const result = decideHealthInterventions({
      projections: values, now,
      plan: { resistanceTrainingToday: true, proteinTargetG: 120, trainingIntensity: 'moderate' },
    })
    expect(result.primary).toMatchObject({
      id: 'health.nutrition.close_protein_gap', ruleId: 'HL-RULE-004',
      category: 'nutrition', risk: 'low', authority: 'auto', capabilityId: 'health.plan.adjust',
    })
  })

  it('detects posture-chain overload from an explicit planned chain', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.posture_state', {
      current: {
        findings: { value: [{ code: 'right_shoulder', severity: 0.7, confidence: 0.8 }] },
        reported_compensation_chain: { value: ['right_shoulder'] },
      },
    }))
    const result = decideHealthInterventions({
      projections: values, now,
      plan: { trainingIntensity: 'high', trainingChains: ['right_shoulder'] },
    })
    expect(result.primary).toMatchObject({
      id: 'health.posture.reduce_chain_overload', ruleId: 'HL-RULE-005', category: 'posture',
      risk: 'low', authority: 'auto', capabilityId: 'health.plan.adjust',
    })
  })

  it('requests a skin recapture only when capture quality is low', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.skin_state', {
      current: { capture_quality: { value: 0.4 }, appearances: { value: [{ type: 'redness', severity: 0.4 }] } },
    }))
    expect(decideHealthInterventions({ projections: values, now }).primary).toMatchObject({
      id: 'health.skin.request_recapture', ruleId: 'HL-RULE-006',
      risk: 'low', authority: 'auto', capabilityId: 'health.checkin.request',
    })
  })

  it('requests missing lab metadata and gates provider-flagged markers behind approval', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const incomplete = replace(projections(), projection('health.internal_state', {
      confirmed: [{ recordId: 'lab-1', observedAt: '2026-07-13T08:00:00Z', evidenceClass: 'measured',
        markers: [{ key: 'fasting_glucose', value: 5.2, unit: 'mmol/L' }] }],
      pending: [], confirmedCount: 1, pendingCount: 0,
    }))
    expect(decideHealthInterventions({ projections: incomplete, now }).primary).toMatchObject({
      id: 'health.internal.request_marker_metadata', ruleId: 'HL-RULE-007',
      risk: 'low', authority: 'auto', capabilityId: 'health.checkin.request',
    })

    const flagged = replace(projections(), projection('health.internal_state', {
      confirmed: [{ recordId: 'lab-2', observedAt: '2026-07-13T08:00:00Z', evidenceClass: 'measured',
        markers: [{ key: 'marker_x', value: 12, unit: 'u/L', referenceInterval: { low: 1, high: 10 },
          measuredAt: '2026-07-13T08:00:00Z', providerFlag: 'high' }] }],
      pending: [], confirmedCount: 1, pendingCount: 0,
    }))
    expect(decideHealthInterventions({ projections: flagged, now }).primary).toMatchObject({
      id: 'health.internal.review_provider_flag', ruleId: 'HL-RULE-008', risk: 'medium',
      authority: 'approval', capabilityId: 'health.followup.schedule',
    })

    const pending = replace(projections(), projection('health.internal_state', {
      confirmed: [], pending: [{ recordId: 'lab-pending', observedAt: '2026-07-13T08:00:00Z',
        evidenceClass: 'measured', markers: [{ key: 'marker_y', value: 4.2, unit: 'u/L' }] }],
      confirmedCount: 0, pendingCount: 1,
    }))
    expect(decideHealthInterventions({ projections: pending, now }).primary).toMatchObject({
      id: 'health.internal.request_marker_metadata', authority: 'auto', capabilityId: 'health.checkin.request',
    })

    const critical = replace(projections(), projection('health.internal_state', {
      confirmed: [{ recordId: 'lab-critical', observedAt: '2026-07-13T08:00:00Z', evidenceClass: 'measured',
        markers: [{ key: 'marker_z', value: 20, unit: 'u/L', referenceInterval: { low: 1, high: 10 },
          measuredAt: '2026-07-13T08:00:00Z', providerFlag: 'critical' }] }],
      pending: [], confirmedCount: 1, pendingCount: 0,
    }))
    expect(decideHealthInterventions({ projections: critical, now }).primary).toMatchObject({
      id: 'health.internal.critical_provider_flag_notice', ruleId: 'HL-RULE-008B', risk: 'critical',
      authority: 'inform_only', capabilityId: null,
    })
  })

  it.each([
    ['stale', { freshness: 'stale' as const }],
    ['conflict', { freshness: 'conflict' as const,
      conflicts: [{ code: 'VALUE_CONFLICT', metric: 'health.sleep.duration_minutes',
        recordIds: ['record-health.recovery_state-duration_minutes'], recordCount: 1, omittedRecordCount: 0,
        message: 'fixture conflict' }] }],
  ])('blocks rules backed by a %s projection', async (_name, gate) => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 280 }, 'fitness.pain': { value: 0 } },
    }, gate))
    const result = decideHealthInterventions({ projections: values, now, plan: { trainingIntensity: 'high' } })
    expect(result.primary).toBeNull()
    expect(result.considered).toContainEqual({ id: 'health.training.reduce_after_low_sleep', accepted: false, reason: `source_${_name}` })
  })

  it('blocks automatic actions during quiet time crossing midnight', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.skin_state', {
      current: { capture_quality: { value: 0.3 }, appearances: { value: [] } },
    }))
    const result = decideHealthInterventions({
      projections: values, now: '2026-07-14T23:30:00Z',
      quietHours: { start: '22:00', end: '07:00', utcOffsetMinutes: 0 },
    })
    expect(result.primary).toBeNull()
    expect(result.considered).toContainEqual({ id: 'health.skin.request_recapture', accepted: false, reason: 'quiet_time' })
  })

  it('does not suppress safety information during quiet time and treats the end boundary as open', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const severe = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 420 }, 'fitness.pain': { value: 9 } },
    }))
    expect(decideHealthInterventions({
      projections: severe, now: '2026-07-14T23:30:00Z',
      quietHours: { start: '22:00', end: '07:00', utcOffsetMinutes: 0 },
    }).primary).toMatchObject({ id: 'health.safety.severe_pain_notice', authority: 'inform_only' })

    const skin = replace(projections(), projection('health.skin_state', {
      current: { capture_quality: { value: 0.3 }, appearances: { value: [] } },
    }))
    expect(decideHealthInterventions({
      projections: skin, now: '2026-07-15T07:00:00Z',
      quietHours: { start: '22:00', end: '07:00', utcOffsetMinutes: 0 },
    }).primary?.id).toBe('health.skin.request_recapture')
  })

  it('expires a formerly fresh projection as explicit now advances', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 300 }, 'fitness.pain': { value: 0 } },
    }))
    const result = decideHealthInterventions({
      projections: values, now: '2026-07-15T09:00:00Z', plan: { trainingIntensity: 'high' },
    })
    expect(result.primary).toBeNull()
    expect(result.considered).toContainEqual({
      id: 'health.training.reduce_after_low_sleep', accepted: false, reason: 'source_stale',
    })
  })

  it('enforces explicit cooldowns at an inclusive boundary', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.skin_state', {
      current: { capture_quality: { value: 0.3 }, appearances: { value: [] } },
    }))
    const blocked = decideHealthInterventions({ projections: values, now, recentActions: [{
      candidateId: 'health.skin.request_recapture', category: 'skin', actedAt: '2026-07-14T08:00:00Z', cooldownUntil: now,
    }] })
    expect(blocked.primary).toBeNull()
    expect(blocked.considered).toContainEqual({ id: 'health.skin.request_recapture', accepted: false, reason: 'cooldown_active' })

    const allowed = decideHealthInterventions({ projections: values, now: '2026-07-14T12:00:00.001Z', recentActions: [{
      candidateId: 'health.skin.request_recapture', category: 'skin', actedAt: '2026-07-14T08:00:00Z', cooldownUntil: now,
    }] })
    expect(allowed.primary?.id).toBe('health.skin.request_recapture')
  })

  it('supersedes a lower-priority active action and retains exactly one primary', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    let values = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 420 }, 'fitness.pain': { value: 6 } },
    }))
    values = replace(values, projection('health.skin_state', {
      current: { capture_quality: { value: 0.3 }, appearances: { value: [] } },
    }))
    const result = decideHealthInterventions({ projections: values, now, activeActions: [{
      id: 'active-skin-1', candidateId: 'health.skin.request_recapture', priority: 20, supersedable: true,
      risk: 'low', authority: 'auto',
    }] })
    expect(result.primary).toMatchObject({
      id: 'health.safety.pain_followup', supersedes: ['active-skin-1'],
    })
    expect(result.alternatives).toEqual([])
    expect(result.considered).toContainEqual({
      id: 'health.skin.request_recapture', accepted: false, reason: 'duplicate_active_action:active-skin-1',
    })
    expect(result.considered).toContainEqual({ id: 'active-skin-1', accepted: false, reason: 'superseded_by:health.safety.pain_followup' })
  })

  it('uses risk and authority when resolving active-action supersession', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const skin = replace(projections(), projection('health.skin_state', {
      current: { capture_quality: { value: 0.3 }, appearances: { value: [] } },
    }))
    const forgedCritical = decideHealthInterventions({ projections: skin, now, activeActions: [{
      id: 'active-critical', candidateId: 'health.internal.critical_provider_flag_notice', priority: 1, supersedable: true,
      risk: 'critical', authority: 'inform_only',
    }] })
    expect(forgedCritical.primary).toBeNull()
    expect(forgedCritical.considered).toContainEqual({
      id: 'health.skin.request_recapture', accepted: false, reason: 'active_action_higher_risk:active-critical',
    })

    for (const active of [
      { id: 'active-duplicate', candidateId: 'health.skin.request_recapture', priority: 1, supersedable: true,
        risk: 'low' as const, authority: 'auto' as const, reason: 'duplicate_active_action:active-duplicate' },
      { id: 'active-higher', candidateId: 'health.training.reduce_after_low_sleep', priority: 40, supersedable: true,
        risk: 'low' as const, authority: 'auto' as const, reason: 'active_action_priority_not_higher:active-higher' },
      { id: 'active-fixed', candidateId: 'health.training.reduce_after_low_sleep', priority: 1, supersedable: false,
        risk: 'low' as const, authority: 'auto' as const, reason: 'active_action_not_supersedable:active-fixed' },
    ]) {
      const { reason, ...input } = active
      const decision = decideHealthInterventions({ projections: skin, now, activeActions: [input] })
      expect(decision.primary).toBeNull()
      expect(decision.considered).toContainEqual({ id: 'health.skin.request_recapture', accepted: false, reason })
    }

    const severe = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 420 }, 'fitness.pain': { value: 9 } },
    }))
    expect(decideHealthInterventions({ projections: severe, now, activeActions: [{
      id: 'active-fixed', candidateId: 'health.internal.critical_provider_flag_notice', priority: 100, supersedable: false,
      risk: 'critical', authority: 'inform_only',
    }] }).primary?.id).toBe('health.safety.severe_pain_notice')

    expect(() => decideHealthInterventions({ projections: skin, now, activeActions: [{
      id: 'active-forged-known', candidateId: 'health.internal.critical_provider_flag_notice', priority: 1,
      supersedable: true, risk: 'low', authority: 'auto',
    }] })).toThrow('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    const unknown = decideHealthInterventions({ projections: skin, now, activeActions: [{
      id: 'active-unknown', candidateId: 'health.unknown', priority: 1, supersedable: true, risk: 'low', authority: 'auto',
    }] })
    expect(unknown.primary).toBeNull()
    expect(unknown.considered).toContainEqual({
      id: 'health.skin.request_recapture', accepted: false, reason: 'active_action_unknown_safety:active-unknown',
    })
  })

  it('deduplicates the exact active informational safety signal but allows a different one', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const severe = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 420 }, 'fitness.pain': { value: 9 } },
    }))
    const duplicate = decideHealthInterventions({ projections: severe, now, activeActions: [{
      id: 'active-severe', candidateId: 'health.safety.severe_pain_notice', priority: 100, supersedable: false,
      risk: 'high', authority: 'inform_only',
    }] })
    expect(duplicate.primary).toBeNull()
    expect(duplicate.considered).toContainEqual({
      id: 'health.safety.severe_pain_notice', accepted: false, reason: 'duplicate_active_action:active-severe',
    })

    const different = decideHealthInterventions({ projections: severe, now, activeActions: [{
      id: 'active-critical', candidateId: 'health.internal.critical_provider_flag_notice', priority: 100,
      supersedable: false, risk: 'critical', authority: 'inform_only',
    }] })
    expect(different.primary?.id).toBe('health.safety.severe_pain_notice')
  })

  it('attaches supersession only to the selected primary, never alternatives', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    let values = replace(projections(), projection('health.fat_loss_state', {
      weightKg: 80, weightVelocityKgPerWeek: -1.1, sampleCount: 8,
    }))
    values = replace(values, projection('health.nutrition_state', {
      totals: { calories_kcal: 1_800, protein_g: 50 }, windowHours: 24,
    }))
    const result = decideHealthInterventions({ projections: values, now,
      plan: { resistanceTrainingToday: true, proteinTargetG: 120 }, activeActions: [{
        id: 'active-low-sleep', candidateId: 'health.training.reduce_after_low_sleep', priority: 10,
        supersedable: true, risk: 'low', authority: 'auto',
      }] })
    expect(result.primary).toMatchObject({
      id: 'health.nutrition.review_unsafe_weight_loss', supersedes: ['active-low-sleep'],
    })
    expect(result.alternatives.map(item => item.id)).toContain('health.nutrition.close_protein_gap')
    expect(result.alternatives.every(item => item.supersedes.length === 0)).toBe(true)
  })

  it('uses stable score tuples and ordering under projection permutation', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    let values = replace(projections(), projection('health.fat_loss_state', {
      weightKg: 80, weightVelocityKgPerWeek: -1.2, sampleCount: 8,
    }))
    values = replace(values, projection('health.nutrition_state', {
      totals: { calories_kcal: 1700, protein_g: 50 }, windowHours: 24,
    }))
    values = replace(values, projection('health.skin_state', {
      current: { capture_quality: { value: 0.3 }, appearances: { value: [] } },
    }))
    const input = { now, plan: { resistanceTrainingToday: true, proteinTargetG: 120 } }
    const first = decideHealthInterventions({ projections: values, ...input })
    const second = decideHealthInterventions({ projections: [...values].reverse(), ...input })
    expect(first).toEqual(second)
    expect(first.primary?.id).toBe('health.nutrition.review_unsafe_weight_loss')
    expect(first.alternatives.map(item => item.id)).toEqual([
      'health.nutrition.close_protein_gap', 'health.skin.request_recapture',
    ])
    expect(first.considered.filter(item => item.accepted)).toHaveLength(3)
  })

  it('binds idempotency material to both projection versions and semantic parameters', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const values = replace(projections(), projection('health.nutrition_state', {
      totals: { calories_kcal: 1800, protein_g: 50 }, windowHours: 24,
    }))
    const target120 = decideHealthInterventions({
      projections: values, now, plan: { resistanceTrainingToday: true, proteinTargetG: 120 },
    }).primary
    const target140 = decideHealthInterventions({
      projections: values, now, plan: { resistanceTrainingToday: true, proteinTargetG: 140 },
    }).primary
    expect(target120).toMatchObject({ parameters: { targetG: 120 } })
    expect(target140).toMatchObject({ parameters: { targetG: 140 } })
    expect(target120?.idempotencyKey).not.toBe(target140?.idempotencyKey)

    const sameUtcDay = decideHealthInterventions({
      projections: values, now: '2026-07-14T23:59:59Z', plan: { resistanceTrainingToday: true, proteinTargetG: 120 },
    }).primary
    const nextUtcDay = decideHealthInterventions({
      projections: values, now: '2026-07-15T00:00:00Z', plan: { resistanceTrainingToday: true, proteinTargetG: 120 },
    }).primary
    expect(target120?.idempotencyKey).toBe(sameUtcDay?.idempotencyKey)
    expect(target120?.idempotencyKey).not.toBe(nextUtcDay?.idempotencyKey)
    expect(decideHealthInterventions({
      projections: values, now, effectiveDate: '2026-07-20',
      plan: { resistanceTrainingToday: true, proteinTargetG: 120 },
    }).primary?.idempotencyKey).not.toBe(target120?.idempotencyKey)
  })

  it('requires a complete unique nine-projection snapshot but remains reorder-stable', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    expect(() => decideHealthInterventions({ projections: projections().slice(0, 8), now })).toThrow('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    expect(() => decideHealthInterventions({ projections: [...projections(), projections()[0]], now })).toThrow('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    expect(() => decideHealthInterventions({ projections: projections().map(item => ({
      ...item, sourceRecordId: 'health-projection-not-a-sha256',
    })), now })).toThrow('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    expect(decideHealthInterventions({ projections: projections(), now })).toEqual(
      decideHealthInterventions({ projections: projections().reverse(), now }),
    )
  })

  it('rejects cross-batch projection splices and mixed projector rule versions', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const batchA = await realProjections([
      observation({ id: 'protein-a', metric: 'health.diet.protein_g', value: 50, unit: 'g' }),
    ])
    const batchB = await realProjections([
      observation({ id: 'protein-b', metric: 'health.diet.protein_g', value: 70, unit: 'g' }),
    ])
    const bNutrition = batchB.find(item => item.key === 'health.nutrition_state')!
    const spliced = batchA.map(item => item.key === bNutrition.key ? bNutrition : item)
    expect(() => decideHealthInterventions({ projections: spliced, now })).toThrow('HEALTH_INTERVENTION_INVALID_PROJECTIONS')

    const forgedCommonSource = spliced.map(item => ({ ...item, sourceRecordId: batchA[0].sourceRecordId }))
    expect(() => decideHealthInterventions({ projections: forgedCommonSource, now })).toThrow('HEALTH_INTERVENTION_INVALID_PROJECTIONS')

    const mixedRules = batchA.map(item => ({ ...item, value: { ...item.value } }))
    mixedRules.find(item => item.key === 'health.nutrition_state')!.value.ruleVersion = 'health-rules-fixture-v99'
    expect(() => decideHealthInterventions({ projections: signProjections(mixedRules), now }))
      .toThrow('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
  })

  it('rejects unsafe freshness ages, future history, and unbounded cooldown windows with defined errors', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    const unsafeAge = projections()
    ;((unsafeAge.find(item => item.key === 'health.recovery_state')!.value.freshness as Record<string, unknown>).ageMs) = Number.MAX_VALUE
    expect(() => decideHealthInterventions({ projections: unsafeAge, now, plan: { trainingIntensity: 'high' } }))
      .toThrow('HEALTH_INTERVENTION_INVALID_PROJECTION')
    expect(() => decideHealthInterventions({ projections: projections(), now, recentActions: [{
      candidateId: 'health.skin.request_recapture', category: 'skin', actedAt: '2026-07-15T00:00:00Z',
    }] })).toThrow('HEALTH_INTERVENTION_INVALID_HISTORY')
    expect(() => decideHealthInterventions({ projections: projections(), now, recentActions: [{
      candidateId: 'health.skin.request_recapture', category: 'skin', actedAt: '2026-07-14T08:00:00Z',
      cooldownUntil: '2027-07-16T08:00:00Z',
    }] })).toThrow('HEALTH_INTERVENTION_INVALID_HISTORY')
  })

  it('rejects hostile or structurally ambiguous public inputs without invoking accessors', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    let accessed = false
    const accessor: Record<string, unknown> = { projections: projections() }
    Object.defineProperty(accessor, 'now', { enumerable: true, get: () => { accessed = true; return now } })
    expect(() => decideHealthInterventions(accessor as never)).toThrow('HEALTH_INTERVENTION_INVALID_INPUT')
    expect(accessed).toBe(false)

    const cycle: Record<string, unknown> = { projections: projections(), now }
    cycle.extra = cycle
    expect(() => decideHealthInterventions(cycle as never)).toThrow('HEALTH_INTERVENTION_INVALID_INPUT')
    expect(() => decideHealthInterventions({ projections: projections(), now, extra: true } as never)).toThrow('HEALTH_INTERVENTION_INVALID_INPUT')
    expect(() => decideHealthInterventions(new Proxy({ projections: projections(), now }, {}) as never)).toThrow('HEALTH_INTERVENTION_INVALID_INPUT')
    expect(() => decideHealthInterventions({ projections: projections(), now,
      plan: Object.create({ trainingIntensity: 'high' }) } as never)).toThrow('HEALTH_INTERVENTION_INVALID_INPUT')
    expect(() => decideHealthInterventions(JSON.parse(`{"projections":[],"now":"${now}","__proto__":{}}`) as never))
      .toThrow('HEALTH_INTERVENTION_INVALID_INPUT')

    const holey = projections()
    delete holey[3]
    expect(() => decideHealthInterventions({ projections: holey, now })).toThrow('HEALTH_INTERVENTION_INVALID_INPUT')
    const extraArray = projections() as TwinProjection[] & { extra?: boolean }
    extraArray.extra = true
    expect(() => decideHealthInterventions({ projections: extraArray, now })).toThrow('HEALTH_INTERVENTION_INVALID_INPUT')
  })

  it('requires a canonical explicit now and fail-closes the risk-authority matrix', async () => {
    const { decideHealthInterventions } = await import('../../packages/server/src/services/hermes/health-loop')
    expect(() => decideHealthInterventions({ projections: projections(), now: 'not-a-time' })).toThrow('HEALTH_INTERVENTION_INVALID_NOW')
    expect(() => decideHealthInterventions({ projections: projections(), now: '2026-02-31T00:00:00Z' })).toThrow('HEALTH_INTERVENTION_INVALID_NOW')

    const values = replace(projections(), projection('health.recovery_state', {
      current: { duration_minutes: { value: 420 }, 'fitness.pain': { value: 9 } },
    }))
    const result = decideHealthInterventions({ projections: values, now })
    expect(result.primary).toMatchObject({ risk: 'high', authority: 'inform_only', capabilityId: null })
    expect(result.alternatives.every(item => item.authority !== 'auto' || item.risk === 'none' || item.risk === 'low')).toBe(true)
  })
})
