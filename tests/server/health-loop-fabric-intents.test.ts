import { describe, expect, it } from 'vitest'

import { mapHealthActionCandidateToFabric, type HealthActionCandidate }
  from '../../packages/server/src/services/hermes/health-loop'

describe('health intervention to Action Fabric mapping', () => {
  const context = {
    planId: 'daily-plan', expectedPlanVersion: 7, ownerUserId: 'user-1',
    dueAt: '2026-07-15T00:00:00.000Z', expiresAt: '2026-07-16T00:00:00.000Z',
  }

  it.each([
    [{ operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'low_sleep' },
      { operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'low_sleep' }],
    [{ operation: 'review_energy_deficit', reasonCode: 'weight_loss_velocity_over_one_percent' },
      { operation: 'review_energy_deficit', reasonCode: 'weight_loss_velocity_over_one_percent' }],
    [{ operation: 'prioritize_food_protein', targetG: 120, reasonCode: 'resistance_day_protein_gap' },
      { operation: 'prioritize_food_protein', targetG: 120, reasonCode: 'resistance_day_protein_gap' }],
    [{ operation: 'reduce_constrained_chain_load', chains: ['posterior_chain'], reasonCode: 'posture_chain_overload' },
      { operation: 'reduce_constrained_chain_load', chains: ['posterior_chain'], reasonCode: 'posture_chain_overload' }],
  ])('maps each Task 9 plan operation without translating away its safety parameters', (parameters, expected) => {
    expect(mapHealthActionCandidateToFabric(candidate('health.plan.adjust', parameters), context)).toEqual({
      capabilityId: 'health.plan.adjust', target: { kind: 'health_plan', planId: 'daily-plan' },
      input: { schemaVersion: 1, planId: 'daily-plan', expectedVersion: 7, ...expected },
    })
  })

  it('maps check-ins and medical/provider follow-ups to exact structured targets', () => {
    expect(mapHealthActionCandidateToFabric(candidate('health.checkin.request', {
      operation: 'request_marker_metadata', requiredFields: ['unit', 'measured_at'],
    }), context)).toMatchObject({ target: { kind: 'health_recipient', recipient: 'configured-self' },
      input: { operation: 'request_marker_metadata', requiredFields: ['unit', 'measured_at'] } })
    expect(mapHealthActionCandidateToFabric(candidate('health.followup.schedule', {
      operation: 'schedule_pain_followup', reasonCode: 'material_reported_pain',
    }), context)).toMatchObject({ target: { kind: 'health_followup', ownerUserId: 'user-1' },
      input: { category: 'medical_review', operation: 'schedule_pain_followup' } })
  })

  it.each([
    { operation: 'review_energy_deficit', dailyCalories: 800, reasonCode: 'weight_loss_velocity_over_one_percent' },
    { operation: 'reduce_training_intensity', maximumIntensity: 'hard', reasonCode: 'low_sleep' },
    { operation: 'prioritize_food_protein', targetG: 9999, reasonCode: 'resistance_day_protein_gap' },
  ])('rejects unsafe or unbounded candidate parameters', parameters => {
    expect(() => mapHealthActionCandidateToFabric(candidate('health.plan.adjust', parameters), context))
      .toThrow('HEALTH_ACTION_PARAMETERS_INVALID')
  })
})

function candidate(capabilityId: HealthActionCandidate['capabilityId'], parameters: Record<string, unknown>): HealthActionCandidate {
  return {
    id: 'health.action.test', ruleId: 'rule-test', category: 'recovery', capabilityId,
    risk: 'low', authority: 'auto', priority: 1, scoreTuple: [1, 1, 1, 1, 1, 1, 1],
    sourceProjectionKeys: [], parameters, rationale: 'test', idempotencyKey: 'health-action-test',
    supersedes: [], effectiveDate: '2026-07-14',
  }
}
