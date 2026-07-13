import type { HealthProjectionEnvelope, HealthProjectionKey } from '../projectors'

export const HEALTH_INTERVENTION_RULE_VERSION = 'health-interventions-v2'

export type HealthInterventionRisk = 'none' | 'low' | 'medium' | 'high' | 'critical'
export type HealthInterventionAuthority = 'auto' | 'approval' | 'inform_only'
export type HealthInterventionCategory = 'training' | 'recovery' | 'nutrition' | 'posture' | 'skin' | 'internal_health'

export interface HealthInterventionPlan {
  trainingIntensity?: 'rest' | 'low' | 'moderate' | 'high'
  resistanceTrainingToday?: boolean
  proteinTargetG?: number
  trainingChains?: string[]
}

export interface HealthRuleProjection {
  key: HealthProjectionKey
  version: number
  envelope: HealthProjectionEnvelope
}

export interface HealthRuleContext {
  projections: ReadonlyMap<HealthProjectionKey, HealthRuleProjection>
  plan: Readonly<HealthInterventionPlan>
}

export interface HealthRuleCandidate {
  id: string
  ruleId: string
  category: HealthInterventionCategory
  capabilityId: 'health.plan.adjust' | 'health.checkin.request' | 'health.followup.schedule' | null
  risk: HealthInterventionRisk
  authority: HealthInterventionAuthority
  requiredProjectionKeys: HealthProjectionKey[]
  priority: number
  urgency: number
  expectedBenefit: number
  goalRelevance: number
  executionBurden: number
  timing: number
  cooldownMs: number
  parameters: Record<string, unknown>
  rationale: string
  gatePolicy: HealthRuleGatePolicy
}

export interface HealthRuleSignalRequirement {
  projectionKey: HealthProjectionKey
  statePaths: string[]
  match: 'all' | 'any'
  recordIds?: string[]
  metrics: string[]
}

export interface HealthRuleGatePolicy {
  signals: HealthRuleSignalRequirement[]
  freshness: 'signal' | 'projection' | 'ignore'
  confidence: 'signal' | 'projection' | 'ignore'
  conflicts: 'signal' | 'projection' | 'ignore'
  minimumConfidence: number
}

export const HEALTH_ACTION_SAFETY_CATALOG: Readonly<Record<string, {
  risk: HealthInterventionRisk
  authority: HealthInterventionAuthority
}>> = Object.freeze({
  'health.training.reduce_after_low_sleep': { risk: 'low', authority: 'auto' },
  'health.training.reduce_after_low_recovery': { risk: 'low', authority: 'auto' },
  'health.training.reduce_after_pain': { risk: 'medium', authority: 'approval' },
  'health.safety.pain_followup': { risk: 'medium', authority: 'approval' },
  'health.safety.severe_pain_notice': { risk: 'high', authority: 'inform_only' },
  'health.nutrition.review_unsafe_weight_loss': { risk: 'medium', authority: 'approval' },
  'health.nutrition.close_protein_gap': { risk: 'low', authority: 'auto' },
  'health.posture.reduce_chain_overload': { risk: 'low', authority: 'auto' },
  'health.skin.request_recapture': { risk: 'low', authority: 'auto' },
  'health.internal.request_marker_metadata': { risk: 'low', authority: 'auto' },
  'health.internal.review_provider_flag': { risk: 'medium', authority: 'approval' },
  'health.internal.critical_provider_flag_notice': { risk: 'critical', authority: 'inform_only' },
})

function gate(projectionKey: HealthProjectionKey, statePaths: string[],
  options: Partial<Omit<HealthRuleGatePolicy, 'signals'>> & { match?: 'all' | 'any'; recordIds?: string[] } = {}): HealthRuleGatePolicy {
  const metricByPath: Record<string, string> = {
    'current.duration_minutes': 'health.sleep.duration_minutes',
    'current.recovery_score': 'health.sleep.recovery_score',
    'current.fitness.pain': 'health.fitness.pain',
    'current.protein_g': 'health.diet.protein_g',
    'current.findings': 'health.posture.findings',
    'current.reported_compensation_chain': 'health.posture.reported_compensation_chain',
    'current.capture_quality': 'health.skin.capture_quality',
    confirmed: 'health.internal_health.markers', pending: 'health.internal_health.markers',
    weightKg: 'health.body_composition.weight_kg', weightVelocityKgPerWeek: 'health.body_composition.weight_kg',
  }
  return {
    signals: [{ projectionKey, statePaths, match: options.match ?? (statePaths.length > 1 ? 'any' : 'all'),
      ...(options.recordIds ? { recordIds: [...options.recordIds].sort() } : {}),
      metrics: [...new Set(statePaths.map(path => metricByPath[path]).filter((item): item is string => !!item))].sort() }],
    freshness: options.freshness ?? 'signal', confidence: options.confidence ?? 'signal',
    conflicts: options.conflicts ?? 'signal', minimumConfidence: options.minimumConfidence ?? 0.6,
  }
}

function state(context: HealthRuleContext, key: HealthProjectionKey): Record<string, unknown> | null {
  return context.projections.get(key)?.envelope.state ?? null
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function currentValue(domainState: Record<string, unknown> | null, key: string): unknown {
  const current = object(domainState?.current)
  return object(current?.[key])?.value
}

function currentRecordId(domainState: Record<string, unknown> | null, key: string): string | null {
  const current = object(domainState?.current)
  const id = object(current?.[key])?.recordId
  return typeof id === 'string' ? id : null
}

function lowSleep(context: HealthRuleContext): HealthRuleCandidate | null {
  const duration = finite(currentValue(state(context, 'health.recovery_state'), 'duration_minutes'))
  if (duration === null || duration >= 360 || context.plan.trainingIntensity !== 'high') return null
  return {
    id: 'health.training.reduce_after_low_sleep', ruleId: 'HL-RULE-001', category: 'training',
    capabilityId: 'health.plan.adjust', risk: 'low', authority: 'auto',
    requiredProjectionKeys: ['health.recovery_state'], priority: 75, urgency: 90, expectedBenefit: 85,
    goalRelevance: 85, executionBurden: 15, timing: 95, cooldownMs: 12 * 3_600_000,
    parameters: { operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'low_sleep' },
    rationale: 'Recent sleep is below the recovery threshold, so hard training should be reduced or rearranged.',
    gatePolicy: gate('health.recovery_state', ['current.duration_minutes']),
  }
}

function lowRecovery(context: HealthRuleContext): HealthRuleCandidate | null {
  const score = finite(currentValue(state(context, 'health.recovery_state'), 'recovery_score'))
  if (score === null || score >= 50 || context.plan.trainingIntensity !== 'high') return null
  return {
    id: 'health.training.reduce_after_low_recovery', ruleId: 'HL-RULE-001B', category: 'training',
    capabilityId: 'health.plan.adjust', risk: 'low', authority: 'auto',
    requiredProjectionKeys: ['health.recovery_state'], priority: 78, urgency: 92, expectedBenefit: 88,
    goalRelevance: 88, executionBurden: 15, timing: 95, cooldownMs: 12 * 3_600_000,
    parameters: { operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'low_recovery_score' },
    rationale: 'The current recovery score is low, so hard training should be reduced or rearranged.',
    gatePolicy: gate('health.recovery_state', ['current.recovery_score']),
  }
}

function pain(context: HealthRuleContext): HealthRuleCandidate | null {
  const painScore = finite(currentValue(state(context, 'health.recovery_state'), 'fitness.pain'))
  if (painScore === null || painScore < 4) return null
  if (painScore >= 8) {
    return {
      id: 'health.safety.severe_pain_notice', ruleId: 'HL-RULE-002B', category: 'recovery',
      capabilityId: null, risk: 'high', authority: 'inform_only',
      requiredProjectionKeys: ['health.recovery_state'], priority: 100, urgency: 100, expectedBenefit: 100,
      goalRelevance: 100, executionBurden: 0, timing: 100, cooldownMs: 0,
      parameters: { warningCode: 'severe_reported_pain', requestProfessionalReview: true },
      rationale: 'Severe reported pain warrants prompt human review; no diagnosis or automatic treatment action is produced.',
      gatePolicy: gate('health.recovery_state', ['current.fitness.pain'], { freshness: 'ignore', confidence: 'ignore' }),
    }
  }
  return {
    id: 'health.safety.pain_followup', ruleId: 'HL-RULE-002', category: 'recovery',
    capabilityId: 'health.followup.schedule', risk: 'medium', authority: 'approval',
    requiredProjectionKeys: ['health.recovery_state'], priority: 90, urgency: 95, expectedBenefit: 90,
    goalRelevance: 100, executionBurden: 30, timing: 100, cooldownMs: 12 * 3_600_000,
    parameters: { operation: 'schedule_pain_followup', reasonCode: 'material_reported_pain' },
    rationale: 'Material reported pain requires confirmation before scheduling follow-up or changing the plan.',
    gatePolicy: gate('health.recovery_state', ['current.fitness.pain']),
  }
}

function painTrainingOverride(context: HealthRuleContext): HealthRuleCandidate | null {
  const painScore = finite(currentValue(state(context, 'health.recovery_state'), 'fitness.pain'))
  if (painScore === null || painScore < 4 || context.plan.trainingIntensity !== 'high') return null
  return {
    id: 'health.training.reduce_after_pain', ruleId: 'HL-RULE-002A', category: 'training',
    capabilityId: 'health.plan.adjust', risk: 'medium', authority: 'approval',
    requiredProjectionKeys: ['health.recovery_state'], priority: 92, urgency: 98, expectedBenefit: 92,
    goalRelevance: 100, executionBurden: 25, timing: 100, cooldownMs: 12 * 3_600_000,
    parameters: { operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'material_reported_pain' },
    rationale: 'Material reported pain overrides planned hard training, but confirmation is required before the plan changes.',
    gatePolicy: gate('health.recovery_state', ['current.fitness.pain']),
  }
}

function unsafeWeightLoss(context: HealthRuleContext): HealthRuleCandidate | null {
  const fatLoss = state(context, 'health.fat_loss_state')
  const weightKg = finite(fatLoss?.weightKg)
  const velocity = finite(fatLoss?.weightVelocityKgPerWeek)
  if (weightKg === null || weightKg <= 0 || velocity === null || velocity > -(weightKg * 0.01)) return null
  return {
    id: 'health.nutrition.review_unsafe_weight_loss', ruleId: 'HL-RULE-003', category: 'nutrition',
    capabilityId: 'health.plan.adjust', risk: 'medium', authority: 'approval',
    requiredProjectionKeys: ['health.fat_loss_state'], priority: 80, urgency: 85, expectedBenefit: 90,
    goalRelevance: 95, executionBurden: 35, timing: 90, cooldownMs: 3 * 86_400_000,
    parameters: { operation: 'review_energy_deficit', reasonCode: 'weight_loss_velocity_over_one_percent' },
    rationale: 'The observed weekly weight-loss velocity exceeds one percent of current weight and needs plan review.',
    gatePolicy: gate('health.fat_loss_state', ['weightKg', 'weightVelocityKgPerWeek'], {
      freshness: 'projection', confidence: 'projection', conflicts: 'projection', match: 'all',
    }),
  }
}

function proteinShortage(context: HealthRuleContext): HealthRuleCandidate | null {
  if (!context.plan.resistanceTrainingToday) return null
  const target = finite(context.plan.proteinTargetG)
  const totals = object(state(context, 'health.nutrition_state')?.totals)
  const protein = finite(totals?.protein_g)
  if (target === null || target <= 0 || protein === null || protein >= target * 0.8) return null
  return {
    id: 'health.nutrition.close_protein_gap', ruleId: 'HL-RULE-004', category: 'nutrition',
    capabilityId: 'health.plan.adjust', risk: 'low', authority: 'auto',
    requiredProjectionKeys: ['health.nutrition_state'], priority: 65, urgency: 75, expectedBenefit: 75,
    goalRelevance: 90, executionBurden: 25, timing: 85, cooldownMs: 12 * 3_600_000,
    parameters: { operation: 'prioritize_food_protein', targetG: target, reasonCode: 'resistance_day_protein_gap' },
    rationale: 'Protein intake is below eighty percent of the configured target on a resistance-training day.',
    gatePolicy: gate('health.nutrition_state', ['current.protein_g']),
  }
}

function postureChainOverload(context: HealthRuleContext): HealthRuleCandidate | null {
  if (context.plan.trainingIntensity !== 'high' || !context.plan.trainingChains?.length) return null
  const posture = state(context, 'health.posture_state')
  const findings = currentValue(posture, 'findings')
  const chain = currentValue(posture, 'reported_compensation_chain')
  const findingConstraints = new Set<string>()
  const chainConstraints = new Set<string>()
  if (Array.isArray(findings)) {
    for (const finding of findings) {
      const value = object(finding)
      if (typeof value?.code === 'string' && (finite(value.severity) ?? 0) >= 0.5) findingConstraints.add(value.code)
    }
  }
  if (Array.isArray(chain)) for (const item of chain) if (typeof item === 'string') chainConstraints.add(item)
  const planned = [...new Set(context.plan.trainingChains)]
  const overlap = planned.filter(item => findingConstraints.has(item) || chainConstraints.has(item)).sort()
  if (!overlap.length) return null
  const sourcePaths: string[] = []
  const sourceRecordIds: string[] = []
  if (planned.some(item => findingConstraints.has(item))) {
    sourcePaths.push('current.findings')
    const id = currentRecordId(posture, 'findings'); if (id) sourceRecordIds.push(id)
  }
  if (planned.some(item => chainConstraints.has(item))) {
    sourcePaths.push('current.reported_compensation_chain')
    const id = currentRecordId(posture, 'reported_compensation_chain'); if (id) sourceRecordIds.push(id)
  }
  return {
    id: 'health.posture.reduce_chain_overload', ruleId: 'HL-RULE-005', category: 'posture',
    capabilityId: 'health.plan.adjust', risk: 'low', authority: 'auto',
    requiredProjectionKeys: ['health.posture_state'], priority: 60, urgency: 70, expectedBenefit: 75,
    goalRelevance: 80, executionBurden: 25, timing: 80, cooldownMs: 24 * 3_600_000,
    parameters: { operation: 'reduce_constrained_chain_load', chains: overlap, reasonCode: 'posture_chain_overload' },
    rationale: 'The planned high-intensity work overlaps a constrained posture chain.',
    gatePolicy: gate('health.posture_state', sourcePaths, { match: 'any', recordIds: sourceRecordIds }),
  }
}

function skinRecapture(context: HealthRuleContext): HealthRuleCandidate | null {
  const quality = finite(currentValue(state(context, 'health.skin_state'), 'capture_quality'))
  if (quality === null || quality >= 0.65) return null
  return {
    id: 'health.skin.request_recapture', ruleId: 'HL-RULE-006', category: 'skin',
    capabilityId: 'health.checkin.request', risk: 'low', authority: 'auto',
    requiredProjectionKeys: ['health.skin_state'], priority: 40, urgency: 45, expectedBenefit: 55,
    goalRelevance: 60, executionBurden: 30, timing: 60, cooldownMs: 24 * 3_600_000,
    parameters: { operation: 'request_skin_recapture', reasonCode: 'low_capture_quality' },
    rationale: 'Skin capture quality is too low for a reliable comparison, so a standardized recapture is preferred.',
    gatePolicy: gate('health.skin_state', ['current.capture_quality'], { confidence: 'ignore' }),
  }
}

interface MarkerSummary { recordId?: unknown; observedAt?: unknown; markers?: unknown }

function confirmedMarkers(context: HealthRuleContext): MarkerSummary[] {
  const confirmed = state(context, 'health.internal_state')?.confirmed
  return Array.isArray(confirmed) ? confirmed.filter(item => object(item) !== null) as MarkerSummary[] : []
}

function allMarkerSummaries(context: HealthRuleContext): MarkerSummary[] {
  const internal = state(context, 'health.internal_state')
  const pending = Array.isArray(internal?.pending) ? internal.pending.filter(item => object(item) !== null) as MarkerSummary[] : []
  return [...confirmedMarkers(context), ...pending]
}

function incompleteMarkerMetadata(context: HealthRuleContext): HealthRuleCandidate | null {
  const incomplete = allMarkerSummaries(context).filter(summary => typeof summary.recordId !== 'string'
    || typeof summary.observedAt !== 'string' || !Array.isArray(summary.markers) || summary.markers.some(item => {
      const marker = object(item)
      return !marker || typeof marker.key !== 'string' || typeof marker.unit !== 'string' || !marker.unit
        || marker.referenceInterval === undefined || typeof marker.measuredAt !== 'string'
    }))
  if (!incomplete.length) return null
  const recordIds = incomplete.map(item => item.recordId).filter((item): item is string => typeof item === 'string')
  return {
    id: 'health.internal.request_marker_metadata', ruleId: 'HL-RULE-007', category: 'internal_health',
    capabilityId: 'health.checkin.request', risk: 'low', authority: 'auto',
    requiredProjectionKeys: ['health.internal_state'], priority: 55, urgency: 55, expectedBenefit: 70,
    goalRelevance: 75, executionBurden: 30, timing: 65, cooldownMs: 3 * 86_400_000,
    parameters: { operation: 'request_marker_metadata', requiredFields: ['unit', 'reference_interval', 'measured_at', 'source_record'] },
    rationale: 'Marker metadata is incomplete, so interpretation is blocked until the missing source fields are confirmed.',
    gatePolicy: gate('health.internal_state', ['confirmed', 'pending'], {
      freshness: 'ignore', confidence: 'ignore', recordIds,
    }),
  }
}

const PROVIDER_FLAGS = new Set(['abnormal', 'critical', 'high', 'low', 'positive', 'warning'])

function providerFlag(context: HealthRuleContext): HealthRuleCandidate | null {
  const flags = confirmedMarkers(context).flatMap(summary => Array.isArray(summary.markers) ? summary.markers.map(item => {
    const flag = object(item)?.providerFlag
    return { flag: typeof flag === 'string' ? flag.trim().toLowerCase() : '',
      recordId: typeof summary.recordId === 'string' ? summary.recordId : null }
  }) : []).filter(item => PROVIDER_FLAGS.has(item.flag))
  if (!flags.length) return null
  if (flags.some(item => item.flag === 'critical')) {
    const recordIds = flags.filter(item => item.flag === 'critical').map(item => item.recordId)
      .filter((item): item is string => item !== null)
    return {
      id: 'health.internal.critical_provider_flag_notice', ruleId: 'HL-RULE-008B', category: 'internal_health',
      capabilityId: null, risk: 'critical', authority: 'inform_only',
      requiredProjectionKeys: ['health.internal_state'], priority: 100, urgency: 100, expectedBenefit: 100,
      goalRelevance: 100, executionBurden: 0, timing: 100, cooldownMs: 0,
      parameters: { warningCode: 'critical_source_reported_marker_flag', requestProfessionalReview: true },
      rationale: 'A source report marked a result critical; prompt human review is requested without diagnosis or automatic disposition.',
      gatePolicy: gate('health.internal_state', ['confirmed'], { freshness: 'ignore', confidence: 'ignore', recordIds }),
    }
  }
  return {
    id: 'health.internal.review_provider_flag', ruleId: 'HL-RULE-008', category: 'internal_health',
    capabilityId: 'health.followup.schedule', risk: 'medium', authority: 'approval',
    requiredProjectionKeys: ['health.internal_state'], priority: 85, urgency: 90, expectedBenefit: 85,
    goalRelevance: 100, executionBurden: 35, timing: 95, cooldownMs: 3 * 86_400_000,
    parameters: { operation: 'schedule_provider_flag_review', reasonCode: 'source_reported_marker_flag' },
    rationale: 'A source report flagged a marker; human approval is required for follow-up and no diagnosis is inferred.',
    gatePolicy: gate('health.internal_state', ['confirmed'], {
      confidence: 'ignore', recordIds: flags.map(item => item.recordId).filter((item): item is string => item !== null),
    }),
  }
}

export function evaluateHealthInterventionRules(context: HealthRuleContext): HealthRuleCandidate[] {
  return [lowSleep(context), lowRecovery(context), pain(context), painTrainingOverride(context), unsafeWeightLoss(context), proteinShortage(context),
    postureChainOverload(context), skinRecapture(context), incompleteMarkerMetadata(context), providerFlag(context)]
    .filter((item): item is HealthRuleCandidate => item !== null)
    .sort((left, right) => left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0)
}
