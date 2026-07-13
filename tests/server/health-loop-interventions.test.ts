import { describe, expect, it } from 'vitest'
import type { TwinProjection } from '../../packages/server/src/services/hermes/personal-twin'
import type { HealthProjectionKey } from '../../packages/server/src/services/hermes/health-loop'

const now = '2026-07-14T12:00:00Z'

function projection(key: HealthProjectionKey, state: Record<string, unknown>, overrides: {
  freshness?: 'fresh' | 'stale' | 'missing' | 'conflict'
  conflicts?: Array<Record<string, unknown>>
  missing?: string[]
  confidence?: number
  version?: number
} = {}): TwinProjection {
  const conflicts = overrides.conflicts ?? []
  return {
    key,
    subjectId: 'person:self',
    version: overrides.version ?? 3,
    sourceRecordId: `source-${key}`,
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
        thresholdMs: 86_400_000,
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
  return [
    projection('health.body_composition_state', { current: { weight_kg: { value: 80, unit: 'kg' } } }, { version: 1 }),
    projection('health.fat_loss_state', { weightKg: 80, weightVelocityKgPerWeek: -0.2, sampleCount: 7 }, { version: 2 }),
    projection('health.nutrition_state', { totals: { calories_kcal: 1900, protein_g: 130 }, windowHours: 24 }, { version: 3 }),
    projection('health.training_state', { current: { intensity: { value: 'moderate' }, pain: { value: 0 } }, load7d: 500, sessions: 3 }, { version: 4 }),
    projection('health.recovery_state', { current: { duration_minutes: { value: 480 }, 'fitness.pain': { value: 0 } } }, { version: 5 }),
    projection('health.posture_state', { current: { findings: { value: [] }, reported_compensation_chain: { value: [] } } }, { version: 6 }),
    projection('health.skin_state', { current: { capture_quality: { value: 0.9 }, appearances: { value: [] } } }, { version: 7 }),
    projection('health.internal_state', { confirmed: [], pending: [], confirmedCount: 0, pendingCount: 0 }, { version: 8 }),
    projection('health.readiness_state', { status: 'ready', score: 82, dependencies: {} }, { version: 9 }),
  ]
}

function replace(values: TwinProjection[], next: TwinProjection): TwinProjection[] {
  return values.map(item => item.key === next.key ? next : item)
}

describe('health-loop cross-domain intervention engine', () => {
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
    ['conflict', { freshness: 'conflict' as const, conflicts: [{ code: 'VALUE_CONFLICT' }] }],
    ['missing', { freshness: 'missing' as const, missing: ['duration_minutes'] }],
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
    }] })
    expect(result.primary).toMatchObject({
      id: 'health.safety.pain_followup', supersedes: ['active-skin-1'],
    })
    expect(result.alternatives.map(item => item.id)).toEqual(['health.skin.request_recapture'])
    expect(result.considered).toContainEqual({ id: 'active-skin-1', accepted: false, reason: 'superseded_by:health.safety.pain_followup' })
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
