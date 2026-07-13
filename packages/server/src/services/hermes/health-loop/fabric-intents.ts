import { validateHealthSemantics } from '../action-fabric/contracts'
import type { FabricJsonObject } from '../action-fabric/types'
import type { HealthActionCandidate } from './interventions'

export interface HealthFabricIntentContext {
  planId: string
  expectedPlanVersion: number
  ownerUserId: string
  dueAt: string
  expiresAt: string
}

export interface MappedHealthFabricAction {
  capabilityId: Exclude<HealthActionCandidate['capabilityId'], null>
  target: FabricJsonObject
  input: FabricJsonObject
}

/** Pure candidate-to-contract mapping; it neither reads state nor persists an intent. */
export function mapHealthActionCandidateToFabric(
  candidate: HealthActionCandidate,
  context: HealthFabricIntentContext,
): MappedHealthFabricAction {
  if (!candidate.capabilityId) throw new Error('HEALTH_ACTION_NOT_EXECUTABLE')
  if (!isPlain(candidate.parameters)) throw new Error('HEALTH_ACTION_PARAMETERS_INVALID')
  if (candidate.capabilityId === 'health.plan.adjust') {
    assertKeys(candidate.parameters, ['operation', 'maximumIntensity', 'targetG', 'chains', 'reasonCode'])
    const input = { schemaVersion: 1, planId: context.planId, expectedVersion: context.expectedPlanVersion,
      ...candidate.parameters }
    if (!validateHealthSemantics(candidate.capabilityId, input)) throw new Error('HEALTH_ACTION_PARAMETERS_INVALID')
    return { capabilityId: candidate.capabilityId,
      target: { kind: 'health_plan', planId: context.planId }, input }
  }
  if (candidate.capabilityId === 'health.checkin.request') {
    assertKeys(candidate.parameters, ['operation', 'reasonCode', 'requiredFields'])
    const operation = candidate.parameters.operation
    if (!['request_skin_recapture', 'request_marker_metadata'].includes(String(operation))) {
      throw new Error('HEALTH_ACTION_PARAMETERS_INVALID')
    }
    if (operation === 'request_skin_recapture' && candidate.parameters.reasonCode !== 'low_capture_quality') {
      throw new Error('HEALTH_ACTION_PARAMETERS_INVALID')
    }
    if (operation === 'request_marker_metadata' && (!Array.isArray(candidate.parameters.requiredFields)
      || candidate.parameters.requiredFields.length === 0 || candidate.parameters.requiredFields.length > 16
      || candidate.parameters.requiredFields.some(item => typeof item !== 'string'))) {
      throw new Error('HEALTH_ACTION_PARAMETERS_INVALID')
    }
    return { capabilityId: candidate.capabilityId,
      target: { kind: 'health_recipient', recipient: 'configured-self' },
      input: { schemaVersion: 1, checkinId: candidate.id, recipient: 'configured-self',
        operation, ...(candidate.parameters.reasonCode === undefined ? {} : { reasonCode: candidate.parameters.reasonCode }),
        ...(candidate.parameters.requiredFields === undefined ? {} : { requiredFields: candidate.parameters.requiredFields }),
        expiresAt: context.expiresAt } }
  }
  assertKeys(candidate.parameters, ['operation', 'reasonCode'])
  if ((candidate.parameters.operation === 'schedule_pain_followup'
      && candidate.parameters.reasonCode !== 'material_reported_pain')
    || (candidate.parameters.operation === 'schedule_provider_flag_review'
      && candidate.parameters.reasonCode !== 'source_reported_marker_flag')
    || !['schedule_pain_followup', 'schedule_provider_flag_review'].includes(String(candidate.parameters.operation))) {
    throw new Error('HEALTH_ACTION_PARAMETERS_INVALID')
  }
  return { capabilityId: candidate.capabilityId,
    target: { kind: 'health_followup', ownerUserId: context.ownerUserId },
    input: { schemaVersion: 1, followupId: candidate.id, ownerUserId: context.ownerUserId,
      category: candidate.parameters.operation === 'schedule_pain_followup' ? 'medical_review' : 'measurement',
      operation: candidate.parameters.operation, reasonCode: candidate.parameters.reasonCode, dueAt: context.dueAt } }
}

function assertKeys(value: FabricJsonObject, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('HEALTH_ACTION_PARAMETERS_INVALID')
}

function isPlain(value: unknown): value is FabricJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
