import { createHash } from 'crypto'
import type { TwinObservation, TwinProjection } from '../personal-twin'
import { listTwinProjections, writeTwinProjectionBatch } from '../personal-twin'
import { calculateVelocity, rollingSum, roundHealthNumber, weightedConfidence } from './rules/health-math'
import type { HealthEvidenceClass } from './types'

export const HEALTH_PROJECTION_KEYS = [
  'health.body_composition_state', 'health.fat_loss_state', 'health.nutrition_state',
  'health.training_state', 'health.recovery_state', 'health.posture_state',
  'health.skin_state', 'health.internal_state', 'health.readiness_state',
] as const

export type HealthProjectionKey = typeof HEALTH_PROJECTION_KEYS[number]
export const DEFAULT_HEALTH_RULE_VERSION = 'health-rules-v1'
export const MAX_HEALTH_PROJECTION_INPUTS = 128

export const HEALTH_FRESHNESS_POLICY = {
  version: 'health-freshness-v1',
  body: { thresholdMs: 7 * 86_400_000 },
  nutrition: { thresholdMs: 36 * 3_600_000 },
  training: { thresholdMs: 72 * 3_600_000 },
  recovery: { thresholdMs: 36 * 3_600_000 },
  posture: { thresholdMs: 30 * 86_400_000 },
  skin: { thresholdMs: 30 * 86_400_000 },
  internal: { thresholdMs: 180 * 86_400_000 },
} as const

type FreshnessDomain = Exclude<keyof typeof HEALTH_FRESHNESS_POLICY, 'version'>
type FreshnessStatus = 'fresh' | 'stale' | 'missing' | 'conflict'

export interface HealthProjectionConflict {
  code: 'FUTURE_RECORD' | 'INVALID_RECORD' | 'UNIT_CONFLICT' | 'VALUE_CONFLICT' | 'SOURCE_CONFLICT'
  metric: string
  recordIds: string[]
  message: string
}

export interface HealthProjectionEnvelope {
  schemaVersion: 1
  ruleVersion: string
  state: Record<string, unknown>
  inputRecordIds: string[]
  effectiveAt: string | null
  computedAt: string
  freshness: {
    policyVersion: string
    status: FreshnessStatus
    thresholdMs: number
    ageMs: number | null
  }
  confidence: number
  conflicts: HealthProjectionConflict[]
  missing: string[]
  rationale: Array<{ code: string; message: string }>
}

export type HealthProjectionSet = Record<HealthProjectionKey, HealthProjectionEnvelope>

export interface ComputeHealthProjectionOptions {
  computedAt: string
  cutoffAt?: string
  ruleVersion?: string
}

interface Candidate {
  record: TwinObservation
  at: number
  evidenceClass: HealthEvidenceClass
}

interface DomainResult {
  state: Record<string, unknown>
  candidates: Candidate[]
  inputRecordIds: string[]
  effectiveAt: string | null
  conflicts: HealthProjectionConflict[]
  missing: string[]
  confidence: number
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const EVIDENCE_CLASSES = ['measured', 'reported', 'inferred', 'derived'] as const
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const EXPECTED_UNITS: Record<string, string | null> = {
  'health.body_composition.weight_kg': 'kg', 'health.body_composition.bmi': null,
  'health.body_composition.body_fat_percent': '%', 'health.body_composition.muscle_mass_kg': 'kg',
  'health.body_composition.bone_mass_kg': 'kg', 'health.body_composition.water_percent': '%',
  'health.body_composition.visceral_fat_level': null, 'health.body_composition.bmr_kcal': 'kcal/day',
  'health.body_composition.metabolic_age_years': 'year', 'health.body_composition.protein_percent': '%',
  'health.body_composition.subcutaneous_fat_percent': '%', 'health.body_composition.fat_mass_kg': 'kg',
  'health.body_composition.lean_body_mass_kg': 'kg', 'health.body_composition.skeletal_muscle_percent': '%',
  'health.body_composition.body_score': null, 'health.body_composition.ideal_weight_kg': 'kg',
  'health.body_composition.waist_hip_ratio': null,
  'health.diet.calories_kcal': 'kcal', 'health.diet.protein_g': 'g', 'health.diet.carbs_g': 'g',
  'health.diet.fat_g': 'g', 'health.diet.water_ml': 'mL',
  'health.fitness.sets': null, 'health.fitness.reps': null, 'health.fitness.load_kg': 'kg',
  'health.fitness.duration_minutes': 'min', 'health.fitness.pain': null, 'health.fitness.rpe': null,
  'health.fitness.training_load': null,
  'health.sleep.duration_minutes': 'min', 'health.sleep.interruptions': null, 'health.sleep.stages': 'min',
  'health.sleep.resting_heart_rate_bpm': 'bpm', 'health.sleep.hrv_ms': 'ms',
  'health.sleep.resting_respiratory_rate_brpm': 'breath/min', 'health.sleep.resting_spo2_percent': '%',
  'health.sleep.freshness_minutes': 'min', 'health.sleep.subjective_recovery': null, 'health.sleep.recovery_score': null,
  'health.posture.angles': 'degree', 'health.skin.distance_cm': 'cm',
}

const PRIVATE_METRIC_SUFFIXES = new Set([
  'device_model', 'capture_conditions', 'calibration_id', 'model_version', 'landmarks', 'capture',
  'reported_routine', 'comparison_baseline', 'device', 'lighting_profile', 'foods', 'supplements', 'exercises',
  'report_artifact_id', 'institution',
])

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') throw new Error('shape')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort(compareUtf8)
  if (keys.some(key => POISON_KEYS.has(key))) throw new Error('poison')
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function timestamp(value: string, field: string): number {
  if (typeof value !== 'string' || !RFC3339.test(value)) throw new Error(`HEALTH_PROJECTION_INVALID_${field}`)
  const result = Date.parse(value)
  if (!Number.isFinite(result)) throw new Error(`HEALTH_PROJECTION_INVALID_${field}`)
  return result
}

function evidenceClass(record: TwinObservation): HealthEvidenceClass | null {
  if (!record.provenance || !Array.isArray(record.provenance.evidence)) return null
  const values = [...new Set(record.provenance.evidence.map(item => item?.evidenceClass)
    .filter((item): item is HealthEvidenceClass => typeof item === 'string' && EVIDENCE_CLASSES.includes(item as HealthEvidenceClass)))]
  return values.length === 1 ? values[0] : null
}

function recordIds(records: readonly TwinObservation[]): string[] {
  return [...new Set(records.map(record => record.id).filter(id => typeof id === 'string' && id.length > 0))].sort(compareUtf8)
}

function conflict(code: HealthProjectionConflict['code'], metric: string, records: readonly TwinObservation[]): HealthProjectionConflict {
  const messages: Record<HealthProjectionConflict['code'], string> = {
    FUTURE_RECORD: 'A future-dated record was excluded from current state.',
    INVALID_RECORD: 'An invalid stored record was excluded from current state.',
    UNIT_CONFLICT: 'Canonical units disagree, so this metric was not aggregated.',
    VALUE_CONFLICT: 'Values disagree at the same effective time, so no value was selected.',
    SOURCE_CONFLICT: 'Source identity is inconsistent and requires reconciliation.',
  }
  return { code, metric, recordIds: recordIds(records), message: messages[code] }
}

function conflictSort(left: HealthProjectionConflict, right: HealthProjectionConflict): number {
  return compareUtf8(left.code, right.code) || compareUtf8(left.metric, right.metric)
    || compareUtf8(left.recordIds.join('\0'), right.recordIds.join('\0'))
}

function safeMetric(metric: string): boolean {
  const suffix = metric.slice(metric.lastIndexOf('.') + 1)
  return !PRIVATE_METRIC_SUFFIXES.has(suffix)
}

function expectedUnit(metric: string): string | null | undefined {
  if (Object.prototype.hasOwnProperty.call(EXPECTED_UNITS, metric)) return EXPECTED_UNITS[metric]
  if (/^health\.measurements\.(?:chest|waist|hip|left_arm|right_arm|left_thigh|right_thigh|left_calf|right_calf)_cm$/.test(metric)) return 'cm'
  if (/^health\.(?:posture|skin|diet|fitness|sleep|internal_health)\./.test(metric)) return null
  return undefined
}

function isSafeValue(value: unknown): boolean {
  try {
    const encoded = stableJson(value)
    return Buffer.byteLength(encoded, 'utf8') <= 4_096
  } catch { return false }
}

function prepareCandidates(records: readonly TwinObservation[], cutoffMs: number): {
  candidates: Candidate[]
  conflicts: HealthProjectionConflict[]
} {
  const candidates: Candidate[] = []
  const conflicts: HealthProjectionConflict[] = []
  for (const record of records) {
    let at: number
    const klass = evidenceClass(record)
    try {
      at = timestamp(record.observedAt, 'RECORD')
    } catch {
      conflicts.push(conflict('INVALID_RECORD', typeof record.metric === 'string' ? record.metric : 'health.invalid', [record]))
      continue
    }
    if (at > cutoffMs) {
      conflicts.push(conflict('FUTURE_RECORD', record.metric, [record]))
      continue
    }
    const expected = expectedUnit(record.metric)
    if (record.entityId !== 'person:self' || typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(record.id)
      || typeof record.metric !== 'string' || !record.provenance || typeof record.provenance.source !== 'string' || !record.provenance.source
      || typeof record.provenance.sourceId !== 'string' || !record.provenance.sourceId
      || !Number.isFinite(record.provenance.confidence) || record.provenance.confidence < 0 || record.provenance.confidence > 1
      || !klass || expected === undefined || !isSafeValue(record.value)) {
      conflicts.push(conflict('INVALID_RECORD', record.metric, [record]))
      continue
    }
    if (record.unit !== expected) {
      conflicts.push(conflict('UNIT_CONFLICT', record.metric, [record]))
      continue
    }
    candidates.push({ record, at, evidenceClass: klass })
  }
  return { candidates, conflicts }
}

function publicValue(record: TwinObservation): unknown {
  if (record.metric === 'health.internal_health.markers' && Array.isArray(record.value)) {
    return record.value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const marker = item as Record<string, unknown>
      return {
        key: marker.key, value: marker.value, unit: marker.unit,
        ...(marker.referenceInterval === undefined ? {} : { referenceInterval: marker.referenceInterval }),
        ...(marker.providerFlag === undefined ? {} : { providerFlag: marker.providerFlag }),
        ...(marker.measuredAt === undefined ? {} : { measuredAt: marker.measuredAt }),
      }
    }).filter(Boolean)
  }
  return JSON.parse(stableJson(record.value)) as unknown
}

function publicCandidate(candidate: Candidate): Record<string, unknown> {
  return {
    recordId: candidate.record.id, metric: candidate.record.metric, value: publicValue(candidate.record), unit: candidate.record.unit,
    observedAt: candidate.record.observedAt, evidenceClass: candidate.evidenceClass,
    confidence: candidate.record.provenance.confidence,
  }
}

function suffix(metric: string, prefixes: readonly string[]): string {
  const prefix = prefixes.find(item => metric.startsWith(item)) ?? ''
  const rest = metric.slice(prefix.length)
  return prefix === 'health.measurements.' ? `measurements.${rest}` : prefix === 'health.fitness.' && prefixes.length > 1 ? `fitness.${rest}` : rest
}

function genericDomain(records: readonly TwinObservation[], prefixes: readonly string[], cutoffMs: number, required: readonly string[]): DomainResult {
  const relevant = records.filter(record => typeof record.metric === 'string' && prefixes.some(prefix => record.metric.startsWith(prefix)))
  const prepared = prepareCandidates(relevant, cutoffMs)
  const groups = new Map<string, Candidate[]>()
  for (const candidate of prepared.candidates) {
    if (!safeMetric(candidate.record.metric)) continue
    const group = groups.get(candidate.record.metric) ?? []
    group.push(candidate); groups.set(candidate.record.metric, group)
  }
  const current: Record<string, unknown> = {}
  const evidence: Record<HealthEvidenceClass, Array<Record<string, unknown>>> = { measured: [], reported: [], inferred: [], derived: [] }
  const conflicts = [...prepared.conflicts]
  const accepted: Candidate[] = []
  for (const metric of [...groups.keys()].sort(compareUtf8)) {
    const items = groups.get(metric)!.sort((left, right) => right.at - left.at
      || compareUtf8(left.record.provenance.source, right.record.provenance.source)
      || compareUtf8(left.record.provenance.sourceId, right.record.provenance.sourceId)
      || compareUtf8(left.record.id, right.record.id))
    for (const klass of EVIDENCE_CLASSES) {
      const latestForClass = items.find(item => item.evidenceClass === klass)
      if (latestForClass) evidence[klass].push(publicCandidate(latestForClass))
    }
    accepted.push(...items)
    const latest = items.filter(item => item.at === items[0].at)
    const unitIds = new Set(latest.map(item => String(item.record.unit)))
    const valueIds = new Set<string>()
    for (const item of latest) valueIds.add(stableJson(item.record.value))
    const identityOwners = new Map<string, Set<string>>()
    for (const item of latest) {
      const owners = identityOwners.get(item.record.provenance.sourceId) ?? new Set<string>()
      owners.add(item.record.provenance.source); identityOwners.set(item.record.provenance.sourceId, owners)
    }
    if (unitIds.size > 1) conflicts.push(conflict('UNIT_CONFLICT', metric, latest.map(item => item.record)))
    if (valueIds.size > 1) conflicts.push(conflict('VALUE_CONFLICT', metric, latest.map(item => item.record)))
    if ([...identityOwners.values()].some(owners => owners.size > 1)) conflicts.push(conflict('SOURCE_CONFLICT', metric, latest.map(item => item.record)))
    if (unitIds.size === 1 && valueIds.size === 1 && ![...identityOwners.values()].some(owners => owners.size > 1)) {
      const selected = latest[0]
      current[suffix(metric, prefixes)] = {
        value: publicValue(selected.record), unit: selected.record.unit, observedAt: selected.record.observedAt,
        recordId: selected.record.id, evidenceClass: selected.evidenceClass,
      }
    }
  }
  for (const klass of EVIDENCE_CLASSES) evidence[klass].sort((left, right) => compareUtf8(String(left.recordId), String(right.recordId)))
  const validTimes = accepted.map(item => item.at)
  const latestAt = validTimes.length ? Math.max(...validTimes) : null
  const latest = latestAt === null ? null : accepted.filter(item => item.at === latestAt).sort((left, right) => compareUtf8(left.record.id, right.record.id))[0]
  const missing = required.filter(item => !Object.prototype.hasOwnProperty.call(current, item)).sort(compareUtf8)
  return {
    state: { current, evidence }, candidates: accepted, inputRecordIds: recordIds(relevant),
    effectiveAt: latest?.record.observedAt ?? null, conflicts: conflicts.sort(conflictSort), missing,
    confidence: weightedConfidence(accepted.map(item => ({ confidence: item.record.provenance.confidence, weight: 1 }))) ?? 0,
  }
}

function freshness(domain: FreshnessDomain, result: DomainResult, computedMs: number): HealthProjectionEnvelope['freshness'] {
  const thresholdMs = HEALTH_FRESHNESS_POLICY[domain].thresholdMs
  if (result.conflicts.length) return { policyVersion: HEALTH_FRESHNESS_POLICY.version, status: 'conflict', thresholdMs, ageMs: null }
  if (!result.effectiveAt) return { policyVersion: HEALTH_FRESHNESS_POLICY.version, status: 'missing', thresholdMs, ageMs: null }
  const ageMs = computedMs - timestamp(result.effectiveAt, 'EFFECTIVE_AT')
  return { policyVersion: HEALTH_FRESHNESS_POLICY.version, status: ageMs <= thresholdMs ? 'fresh' : 'stale', thresholdMs, ageMs }
}

function envelope(result: DomainResult, domain: FreshnessDomain, options: Required<ComputeHealthProjectionOptions>, computedMs: number): HealthProjectionEnvelope {
  const fresh = freshness(domain, result, computedMs)
  const penalty = fresh.status === 'conflict' ? 0.5 : fresh.status === 'stale' ? 0.7 : fresh.status === 'missing' ? 0 : 1
  return {
    schemaVersion: 1, ruleVersion: options.ruleVersion, state: result.state, inputRecordIds: result.inputRecordIds,
    effectiveAt: result.effectiveAt, computedAt: options.computedAt, freshness: fresh,
    confidence: roundHealthNumber(result.confidence * penalty, 4) ?? 0,
    conflicts: result.conflicts, missing: result.missing,
    rationale: [{ code: result.conflicts.length ? 'HEALTH_STATE_CONFLICT' : result.missing.length ? 'HEALTH_STATE_INCOMPLETE' : 'HEALTH_STATE_CURRENT',
      message: result.conflicts.length ? 'Conflicting evidence is retained for review.' : result.missing.length ? 'State is incomplete because required evidence is missing.' : 'State was computed from canonical health evidence.' }],
  }
}

function withState(base: DomainResult, state: Record<string, unknown>, missing = base.missing): DomainResult {
  return { ...base, state, missing }
}

function fatLossResult(records: readonly TwinObservation[], cutoffMs: number): DomainResult {
  const base = genericDomain(records, ['health.body_composition.'], cutoffMs, ['weight_kg'])
  const weights = base.candidates.filter(item => item.record.metric === 'health.body_composition.weight_kg' && typeof item.record.value === 'number')
  const byInstant = new Map<number, Candidate[]>()
  for (const item of weights) { const group = byInstant.get(item.at) ?? []; group.push(item); byInstant.set(item.at, group) }
  const samples = [...byInstant.entries()].filter(([, items]) => new Set(items.map(item => stableJson(item.record.value))).size === 1)
    .map(([at, items]) => ({ at, value: items[0].record.value as number })).sort((left, right) => left.at - right.at)
  const velocity = calculateVelocity(samples, 86_400_000, 5)
  const current = base.state.current as Record<string, { value?: unknown }> | undefined
  const weightKg = typeof current?.weight_kg?.value === 'number' ? current.weight_kg.value : null
  return withState(base, {
    weightKg, weightVelocityKgPerWeek: velocity ? roundHealthNumber(velocity.perDay * 7, 4) : null,
    sampleCount: velocity?.sampleCount ?? samples.length,
  }, [...new Set([...(weightKg === null ? ['weight_kg'] : []), ...(velocity ? [] : ['weight_trend'])])].sort(compareUtf8))
}

function nutritionResult(records: readonly TwinObservation[], cutoffMs: number): DomainResult {
  const base = genericDomain(records, ['health.diet.'], cutoffMs, ['calories_kcal', 'protein_g'])
  const names = ['calories_kcal', 'protein_g', 'carbs_g', 'fat_g', 'water_ml'] as const
  const totals: Record<string, number> = {}
  for (const name of names) {
    const samples = base.candidates.filter(item => item.record.metric === `health.diet.${name}` && typeof item.record.value === 'number')
      .map(item => ({ at: item.at, value: item.record.value as number }))
    const total = rollingSum(samples, cutoffMs, 24 * 3_600_000)
    if (total !== null) totals[name] = total
  }
  return withState(base, { totals: Object.keys(totals).length ? totals : null, windowHours: 24 })
}

function trainingResult(records: readonly TwinObservation[], cutoffMs: number): DomainResult {
  const base = genericDomain(records, ['health.fitness.'], cutoffMs, ['training_load'])
  const loads = base.candidates.filter(item => item.record.metric === 'health.fitness.training_load' && typeof item.record.value === 'number')
  const load7d = rollingSum(loads.map(item => ({ at: item.at, value: item.record.value as number })), cutoffMs, 7 * 86_400_000)
  return withState(base, { ...base.state, load7d, sessions: new Set(loads.map(item => `${item.record.provenance.source}\0${item.record.provenance.sourceId}`)).size })
}

function recoveryResult(records: readonly TwinObservation[], cutoffMs: number): DomainResult {
  const base = genericDomain(records, ['health.sleep.', 'health.fitness.'], cutoffMs, ['duration_minutes'])
  const sleep = base.candidates.filter(item => item.record.metric.startsWith('health.sleep.'))
    .sort((left, right) => right.at - left.at || compareUtf8(left.record.provenance.source, right.record.provenance.source)
      || compareUtf8(left.record.provenance.sourceId, right.record.provenance.sourceId) || compareUtf8(left.record.id, right.record.id))
  return { ...base, effectiveAt: sleep[0]?.record.observedAt ?? null }
}

function internalResult(records: readonly TwinObservation[], cutoffMs: number): DomainResult {
  const base = genericDomain(records, ['health.internal_health.'], cutoffMs, ['markers'])
  const markers = base.candidates.filter(item => item.record.metric === 'health.internal_health.markers')
  const pending = markers.filter(item => item.record.provenance.confirmationState === 'inferred')
    .map(item => ({ recordId: item.record.id, observedAt: item.record.observedAt, evidenceClass: item.evidenceClass, markers: publicValue(item.record) }))
  const confirmed = markers.filter(item => item.record.provenance.confirmationState !== 'inferred')
    .map(item => ({ recordId: item.record.id, observedAt: item.record.observedAt, evidenceClass: item.evidenceClass, markers: publicValue(item.record) }))
  pending.sort((left, right) => compareUtf8(left.recordId, right.recordId)); confirmed.sort((left, right) => compareUtf8(left.recordId, right.recordId))
  return withState(base, { confirmed, pending }, confirmed.length ? [] : ['confirmed_markers'])
}

function readinessResult(dependencies: {
  bodyComposition: HealthProjectionEnvelope
  internal: HealthProjectionEnvelope
  nutrition: HealthProjectionEnvelope
  posture: HealthProjectionEnvelope
  recovery: HealthProjectionEnvelope
  skin: HealthProjectionEnvelope
  training: HealthProjectionEnvelope
}, options: Required<ComputeHealthProjectionOptions>): DomainResult {
  const orderedDependencies = Object.entries(dependencies) as Array<[keyof typeof dependencies, HealthProjectionEnvelope]>
  const inputRecordIds = [...new Set(orderedDependencies.flatMap(([, item]) => item.inputRecordIds))].sort(compareUtf8)
  const conflicts = orderedDependencies.flatMap(([, item]) => item.conflicts).sort(conflictSort)
  const recover = dependencies.recovery
  const nutrition = dependencies.nutrition
  const training = dependencies.training
  const available = [recover, nutrition, training].filter(item => item.freshness.status === 'fresh')
  const components: number[] = []
  const recoveryCurrent = recover.state.current as Record<string, { value?: unknown }> | undefined
  const recoveryScore = recoveryCurrent?.recovery_score?.value
  const duration = recoveryCurrent?.duration_minutes?.value
  if (typeof recoveryScore === 'number') components.push(recoveryScore)
  else if (typeof duration === 'number') components.push(Math.max(0, Math.min(100, duration / 4.8)))
  if (nutrition.freshness.status === 'fresh') components.push(nutrition.missing.length ? 50 : 75)
  if (training.freshness.status === 'fresh') components.push(training.conflicts.length ? 40 : 70)
  const score = components.length >= 2 ? roundHealthNumber(components.reduce((sum, value) => sum + value, 0) / components.length, 1) : null
  const missing = [recover, nutrition, training].flatMap((item, index) => item.freshness.status === 'missing' ? [['recovery', 'nutrition', 'training'][index]] : []).sort(compareUtf8)
  const status = score === null ? 'insufficient' : conflicts.length || available.some(item => item.freshness.status !== 'fresh') || score < 60 ? 'caution' : 'ready'
  const effective = orderedDependencies.map(([, item]) => item.effectiveAt).filter((item): item is string => item !== null)
    .sort((left, right) => timestamp(right, 'DEPENDENCY') - timestamp(left, 'DEPENDENCY'))[0] ?? null
  const dependencyState = Object.fromEntries(orderedDependencies.map(([name, item]) => [name, {
    projectionKey: ({
      bodyComposition: 'health.body_composition_state', internal: 'health.internal_state', nutrition: 'health.nutrition_state',
      posture: 'health.posture_state', recovery: 'health.recovery_state', skin: 'health.skin_state', training: 'health.training_state',
    } as const)[name],
    schemaVersion: item.schemaVersion, ruleVersion: item.ruleVersion, freshness: item.freshness.status,
    rationale: item.rationale.map(entry => entry.code),
  }]))
  return {
    state: {
      status, score, dependencies: dependencyState,
    }, candidates: [], inputRecordIds, effectiveAt: effective, conflicts, missing,
    confidence: components.length < 2 ? 0 : weightedConfidence(available.map(item => ({ confidence: item.confidence, weight: 1 }))) ?? 0,
  }
}

function normalizeOptions(options: ComputeHealthProjectionOptions): { options: Required<ComputeHealthProjectionOptions>; computedMs: number; cutoffMs: number } {
  const computedMs = timestamp(options.computedAt, 'COMPUTED_AT')
  const cutoffAt = options.cutoffAt ?? options.computedAt
  const cutoffMs = timestamp(cutoffAt, 'CUTOFF_AT')
  const ruleVersion = options.ruleVersion ?? DEFAULT_HEALTH_RULE_VERSION
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(ruleVersion)) throw new Error('HEALTH_PROJECTION_INVALID_RULE_VERSION')
  return { options: { computedAt: options.computedAt, cutoffAt, ruleVersion }, computedMs, cutoffMs }
}

export function computeHealthProjections(records: readonly TwinObservation[], inputOptions: ComputeHealthProjectionOptions): HealthProjectionSet {
  if (!Array.isArray(records) || records.length > MAX_HEALTH_PROJECTION_INPUTS) throw new Error('HEALTH_PROJECTION_INPUT_LIMIT')
  const { options, computedMs, cutoffMs } = normalizeOptions(inputOptions)
  const ordered = [...records].sort((left, right) => compareUtf8(String(left.id), String(right.id)))
  const body = genericDomain(ordered, ['health.body_composition.', 'health.measurements.'], cutoffMs, ['weight_kg'])
  const fatLoss = fatLossResult(ordered, cutoffMs)
  const nutrition = nutritionResult(ordered, cutoffMs)
  const training = trainingResult(ordered, cutoffMs)
  const recovery = recoveryResult(ordered, cutoffMs)
  const posture = genericDomain(ordered, ['health.posture.'], cutoffMs, ['findings'])
  const skin = genericDomain(ordered, ['health.skin.'], cutoffMs, ['appearances'])
  const internal = internalResult(ordered, cutoffMs)
  const partial = {
    'health.body_composition_state': envelope(body, 'body', options, computedMs),
    'health.fat_loss_state': envelope(fatLoss, 'body', options, computedMs),
    'health.nutrition_state': envelope(nutrition, 'nutrition', options, computedMs),
    'health.training_state': envelope(training, 'training', options, computedMs),
    'health.recovery_state': envelope(recovery, 'recovery', options, computedMs),
    'health.posture_state': envelope(posture, 'posture', options, computedMs),
    'health.skin_state': envelope(skin, 'skin', options, computedMs),
    'health.internal_state': envelope(internal, 'internal', options, computedMs),
  }
  const readiness = readinessResult({
    bodyComposition: partial['health.body_composition_state'], internal: partial['health.internal_state'],
    nutrition: partial['health.nutrition_state'], posture: partial['health.posture_state'], recovery: partial['health.recovery_state'],
    skin: partial['health.skin_state'], training: partial['health.training_state'],
  }, options)
  return { ...partial, 'health.readiness_state': envelope(readiness, 'recovery', options, computedMs) }
}

export interface PersistHealthProjectionOptions {
  subjectId?: string
  expectedVersions?: Partial<Record<HealthProjectionKey, number>>
}

export function persistHealthProjections(values: HealthProjectionSet, options: PersistHealthProjectionOptions = {}): TwinProjection[] {
  const subjectId = options.subjectId ?? 'person:self'
  const current = new Map(listTwinProjections('health.', subjectId).map(item => [item.key, item.version]))
  const materialDigest = createHash('sha256').update(stableJson(values)).digest('hex')
  return writeTwinProjectionBatch(HEALTH_PROJECTION_KEYS.map(key => ({
    key, subjectId, value: values[key] as unknown as Record<string, unknown>,
    sourceRecordId: `health-projection-${materialDigest}`,
    expectedVersion: options.expectedVersions?.[key] ?? current.get(key) ?? 0,
    updatedAt: values[key].computedAt,
  })))
}

export interface ProjectHealthStateOptions extends ComputeHealthProjectionOptions, PersistHealthProjectionOptions {
  historical?: boolean
}

export function projectHealthState(records: readonly TwinObservation[], options: ProjectHealthStateOptions): {
  projections: HealthProjectionSet
  persisted: TwinProjection[]
} {
  const projections = computeHealthProjections(records, options)
  return { projections, persisted: options.historical ? [] : persistHealthProjections(projections, options) }
}
