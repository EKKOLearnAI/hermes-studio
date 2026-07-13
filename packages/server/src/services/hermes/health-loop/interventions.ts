import { createHash } from 'crypto'
import type { TwinProjection } from '../personal-twin'
import { canonicalizeHealthTimestamp, healthTimestampEpochNanoseconds } from './normalizers'
import {
  HEALTH_PROJECTION_KEYS,
  type HealthProjectionEnvelope,
  type HealthProjectionKey,
} from './projectors'
import {
  evaluateHealthInterventionRules,
  HEALTH_INTERVENTION_RULE_VERSION,
  type HealthInterventionAuthority,
  type HealthInterventionCategory,
  type HealthInterventionPlan,
  type HealthInterventionRisk,
  type HealthRuleCandidate,
  type HealthRuleProjection,
} from './rules/intervention-rules'

export interface HealthInterventionQuietHours {
  start: string
  end: string
  utcOffsetMinutes: number
}

export interface HealthRecentAction {
  candidateId: string
  category: HealthInterventionCategory
  actedAt: string
  cooldownUntil?: string
}

export interface HealthActiveAction {
  id: string
  candidateId: string
  priority: number
  supersedable: boolean
}

export interface DecideHealthInterventionsInput {
  projections: readonly TwinProjection[]
  now: string
  plan?: HealthInterventionPlan
  quietHours?: HealthInterventionQuietHours
  recentActions?: readonly HealthRecentAction[]
  activeActions?: readonly HealthActiveAction[]
}

export interface HealthActionCandidate {
  id: string
  ruleId: string
  category: HealthInterventionCategory
  capabilityId: 'health.plan.adjust' | 'health.checkin.request' | 'health.followup.schedule' | null
  risk: HealthInterventionRisk
  authority: HealthInterventionAuthority
  priority: number
  scoreTuple: [number, number, number, number, number, number, number]
  sourceProjectionKeys: HealthProjectionKey[]
  parameters: Record<string, unknown>
  rationale: string
  idempotencyKey: string
  supersedes: string[]
}

export interface HealthInterventionDecision {
  primary: HealthActionCandidate | null
  alternatives: HealthActionCandidate[]
  considered: Array<{ id: string; accepted: boolean; reason: string }>
  projectionVersions: Record<string, number>
  ruleVersion: string
  decidedAt: string
}

const RISK_ORDER: Record<HealthInterventionRisk, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
const PROJECTION_KEY_SET = new Set<string>(HEALTH_PROJECTION_KEYS)
const FRESHNESS = new Set(['fresh', 'stale', 'missing', 'conflict'])
const CATEGORIES = new Set<HealthInterventionCategory>(['training', 'recovery', 'nutrition', 'posture', 'skin', 'internal_health'])
const PLAN_KEYS = new Set(['trainingIntensity', 'resistanceTrainingToday', 'proteinTargetG', 'trainingChains'])
const MAX_HISTORY_ITEMS = 256

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalTimestamp(value: unknown, code: string): { canonical: string; nanoseconds: bigint } {
  if (typeof value !== 'string') throw new Error(code)
  try {
    const canonical = canonicalizeHealthTimestamp(value, 'health intervention timestamp')
    return { canonical, nanoseconds: healthTimestampEpochNanoseconds(canonical, 'health intervention timestamp') }
  } catch {
    throw new Error(code)
  }
}

function assertBoundedIdentifier(value: unknown, code: string, maximum = 200): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(code)
}

function validateEnvelope(value: unknown): HealthProjectionEnvelope {
  if (!plain(value) || value.schemaVersion !== 1 || typeof value.ruleVersion !== 'string' || !value.ruleVersion
    || !plain(value.state) || !Array.isArray(value.inputRecordIds) || typeof value.computedAt !== 'string'
    || !plain(value.freshness) || !FRESHNESS.has(String(value.freshness.status))
    || typeof value.freshness.thresholdMs !== 'number' || !Number.isSafeInteger(value.freshness.thresholdMs) || value.freshness.thresholdMs < 0
    || (value.freshness.ageMs !== null && (typeof value.freshness.ageMs !== 'number' || !Number.isFinite(value.freshness.ageMs) || value.freshness.ageMs < 0))
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
    || !Array.isArray(value.conflicts) || !Number.isSafeInteger(value.conflictCount) || (value.conflictCount as number) < 0
    || !Number.isSafeInteger(value.conflictOmittedCount) || (value.conflictOmittedCount as number) < 0
    || !Array.isArray(value.missing) || !Array.isArray(value.rationale)) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTION')
  canonicalTimestamp(value.computedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION')
  if (value.effectiveAt !== null) canonicalTimestamp(value.effectiveAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION')
  if (value.inputRecordIds.length > 4_096 || value.inputRecordIds.some(item => typeof item !== 'string' || !item || item.length > 200)
    || value.missing.length > 256 || value.missing.some(item => typeof item !== 'string' || !item || item.length > 200)
    || value.conflicts.length > 32 || value.rationale.length > 64) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTION')
  return value as unknown as HealthProjectionEnvelope
}

function normalizeProjections(values: readonly TwinProjection[]): {
  projections: Map<HealthProjectionKey, HealthRuleProjection>
  versions: Record<string, number>
} {
  if (!Array.isArray(values) || values.length > HEALTH_PROJECTION_KEYS.length) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
  const projections = new Map<HealthProjectionKey, HealthRuleProjection>()
  for (const value of values) {
    if (!value || typeof value !== 'object' || !PROJECTION_KEY_SET.has(value.key) || value.subjectId !== 'person:self'
      || !Number.isSafeInteger(value.version) || value.version < 1 || projections.has(value.key as HealthProjectionKey)) {
      throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    }
    const key = value.key as HealthProjectionKey
    projections.set(key, { key, version: value.version, envelope: validateEnvelope(value.value) })
  }
  const versions: Record<string, number> = {}
  for (const key of HEALTH_PROJECTION_KEYS) {
    const item = projections.get(key)
    if (item) versions[key] = item.version
  }
  return { projections, versions }
}

function normalizePlan(value: HealthInterventionPlan | undefined): HealthInterventionPlan {
  if (value === undefined) return {}
  if (!plain(value) || Object.keys(value).some(key => !PLAN_KEYS.has(key))) throw new Error('HEALTH_INTERVENTION_INVALID_PLAN')
  const plan = value as HealthInterventionPlan
  if (plan.trainingIntensity !== undefined && !['rest', 'low', 'moderate', 'high'].includes(plan.trainingIntensity)) {
    throw new Error('HEALTH_INTERVENTION_INVALID_PLAN')
  }
  if (plan.resistanceTrainingToday !== undefined && typeof plan.resistanceTrainingToday !== 'boolean') throw new Error('HEALTH_INTERVENTION_INVALID_PLAN')
  if (plan.proteinTargetG !== undefined && (typeof plan.proteinTargetG !== 'number' || !Number.isFinite(plan.proteinTargetG)
    || plan.proteinTargetG <= 0 || plan.proteinTargetG > 1_000)) throw new Error('HEALTH_INTERVENTION_INVALID_PLAN')
  if (plan.trainingChains !== undefined && (!Array.isArray(plan.trainingChains) || plan.trainingChains.length > 32
    || new Set(plan.trainingChains).size !== plan.trainingChains.length
    || plan.trainingChains.some(item => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(item)))) {
    throw new Error('HEALTH_INTERVENTION_INVALID_PLAN')
  }
  return {
    ...(plan.trainingIntensity === undefined ? {} : { trainingIntensity: plan.trainingIntensity }),
    ...(plan.resistanceTrainingToday === undefined ? {} : { resistanceTrainingToday: plan.resistanceTrainingToday }),
    ...(plan.proteinTargetG === undefined ? {} : { proteinTargetG: plan.proteinTargetG }),
    ...(plan.trainingChains === undefined ? {} : { trainingChains: [...plan.trainingChains].sort(compareUtf8) }),
  }
}

function normalizeQuietHours(value: HealthInterventionQuietHours | undefined): HealthInterventionQuietHours | null {
  if (value === undefined) return null
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'end,start,utcOffsetMinutes'
    || typeof value.start !== 'string' || typeof value.end !== 'string'
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end)
    || !Number.isInteger(value.utcOffsetMinutes) || value.utcOffsetMinutes < -840 || value.utcOffsetMinutes > 840) {
    throw new Error('HEALTH_INTERVENTION_INVALID_QUIET_HOURS')
  }
  return { start: value.start, end: value.end, utcOffsetMinutes: value.utcOffsetMinutes }
}

function minute(value: string): number {
  const [hour, minutes] = value.split(':').map(Number)
  return hour * 60 + minutes
}

function isQuietTime(nowNs: bigint, quiet: HealthInterventionQuietHours | null): boolean {
  if (!quiet || quiet.start === quiet.end) return false
  const nowMs = Number(nowNs / 1_000_000n)
  const local = new Date(nowMs + quiet.utcOffsetMinutes * 60_000)
  const current = local.getUTCHours() * 60 + local.getUTCMinutes()
  const start = minute(quiet.start)
  const end = minute(quiet.end)
  return start < end ? current >= start && current < end : current >= start || current < end
}

function normalizeRecentActions(values: readonly HealthRecentAction[] | undefined): Array<HealthRecentAction & { actedNs: bigint; cooldownNs: bigint | null }> {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > MAX_HISTORY_ITEMS) throw new Error('HEALTH_INTERVENTION_INVALID_HISTORY')
  return values.map(value => {
    if (!plain(value) || Object.keys(value).some(key => !['candidateId', 'category', 'actedAt', 'cooldownUntil'].includes(key))) {
      throw new Error('HEALTH_INTERVENTION_INVALID_HISTORY')
    }
    const recent = value as unknown as HealthRecentAction
    assertBoundedIdentifier(recent.candidateId, 'HEALTH_INTERVENTION_INVALID_HISTORY')
    if (!CATEGORIES.has(recent.category)) throw new Error('HEALTH_INTERVENTION_INVALID_HISTORY')
    const acted = canonicalTimestamp(recent.actedAt, 'HEALTH_INTERVENTION_INVALID_HISTORY')
    const cooldown = recent.cooldownUntil === undefined ? null : canonicalTimestamp(recent.cooldownUntil, 'HEALTH_INTERVENTION_INVALID_HISTORY')
    if (cooldown && cooldown.nanoseconds < acted.nanoseconds) throw new Error('HEALTH_INTERVENTION_INVALID_HISTORY')
    return {
      candidateId: recent.candidateId, category: recent.category, actedAt: acted.canonical,
      ...(cooldown ? { cooldownUntil: cooldown.canonical } : {}), actedNs: acted.nanoseconds, cooldownNs: cooldown?.nanoseconds ?? null,
    }
  }).sort((left, right) => compareUtf8(left.candidateId, right.candidateId) || compareBigInt(left.actedNs, right.actedNs))
}

function normalizeActiveActions(values: readonly HealthActiveAction[] | undefined): HealthActiveAction[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > MAX_HISTORY_ITEMS) throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
  const seen = new Set<string>()
  const result = values.map(value => {
    if (!plain(value) || Object.keys(value).sort().join(',') !== 'candidateId,id,priority,supersedable') {
      throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    }
    const active = value as unknown as HealthActiveAction
    assertBoundedIdentifier(active.id, 'HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    assertBoundedIdentifier(active.candidateId, 'HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    if (seen.has(active.id) || !Number.isSafeInteger(active.priority) || active.priority < 0 || active.priority > 100
      || typeof active.supersedable !== 'boolean') throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    seen.add(active.id)
    return { id: active.id, candidateId: active.candidateId, priority: active.priority, supersedable: active.supersedable }
  })
  return result.sort((left, right) => compareUtf8(left.id, right.id))
}

function projectionGate(item: HealthRuleProjection | undefined, nowNs: bigint): string | null {
  if (!item) return 'source_missing'
  const value = item.envelope
  if (value.freshness.status === 'conflict' || value.conflictCount > 0 || value.conflicts.length > 0) return 'source_conflict'
  if (value.freshness.status === 'missing' || value.missing.length > 0) return 'source_missing'
  if (value.freshness.status === 'stale') return 'source_stale'
  if (value.freshness.status !== 'fresh') return 'source_unavailable'
  if (value.confidence < 0.6) return 'source_low_confidence'
  const computed = canonicalTimestamp(value.computedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION')
  if (computed.nanoseconds > nowNs) return 'source_future'
  const ageAtComputation = value.freshness.ageMs
  if (ageAtComputation === null) return 'source_missing'
  const elapsedNs = nowNs - computed.nanoseconds
  const effectiveAgeNs = BigInt(Math.ceil(ageAtComputation * 1_000_000)) + elapsedNs
  if (effectiveAgeNs > BigInt(value.freshness.thresholdMs) * 1_000_000n) return 'source_stale'
  return null
}

function ruleGate(candidate: HealthRuleCandidate, projections: ReadonlyMap<HealthProjectionKey, HealthRuleProjection>, nowNs: bigint): string | null {
  for (const key of candidate.requiredProjectionKeys) {
    const reason = projectionGate(projections.get(key), nowNs)
    if (reason) return reason
  }
  return null
}

function cooldownActive(candidate: HealthRuleCandidate,
  recent: readonly (HealthRecentAction & { actedNs: bigint; cooldownNs: bigint | null })[], nowNs: bigint): boolean {
  return recent.some(item => {
    if (item.candidateId !== candidate.id && item.category !== candidate.category) return false
    const until = item.cooldownNs ?? item.actedNs + BigInt(candidate.cooldownMs) * 1_000_000n
    return nowNs <= until
  })
}

function assertRiskAuthority(candidate: HealthRuleCandidate): void {
  if (candidate.authority === 'auto' && RISK_ORDER[candidate.risk] > RISK_ORDER.low) throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
  if (candidate.authority === 'approval' && RISK_ORDER[candidate.risk] < RISK_ORDER.medium) throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
  if (RISK_ORDER[candidate.risk] >= RISK_ORDER.high && (candidate.authority !== 'inform_only' || candidate.capabilityId !== null)) {
    throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
  }
  if (candidate.authority === 'inform_only' && candidate.capabilityId !== null) throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
}

function candidateConfidence(candidate: HealthRuleCandidate, projections: ReadonlyMap<HealthProjectionKey, HealthRuleProjection>): number {
  return Math.min(...candidate.requiredProjectionKeys.map(key => projections.get(key)?.envelope.confidence ?? 0))
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function compareBigInt(left: bigint, right: bigint): number { return left < right ? -1 : left > right ? 1 : 0 }

function compareScore(left: HealthActionCandidate, right: HealthActionCandidate): number {
  for (let index = 0; index < left.scoreTuple.length; index += 1) {
    const difference = right.scoreTuple[index] - left.scoreTuple[index]
    if (difference) return difference
  }
  return compareUtf8(left.id, right.id)
}

function stableVersionMaterial(versions: Record<string, number>): string {
  return `{${Object.keys(versions).sort(compareUtf8).map(key => `${JSON.stringify(key)}:${versions[key]}`).join(',')}}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort(compareUtf8)
    .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
}

function publicCandidate(candidate: HealthRuleCandidate, projections: ReadonlyMap<HealthProjectionKey, HealthRuleProjection>,
  versions: Record<string, number>): HealthActionCandidate {
  assertRiskAuthority(candidate)
  const confidence = Math.round(candidateConfidence(candidate, projections) * 100)
  const scoreTuple: HealthActionCandidate['scoreTuple'] = [candidate.priority, candidate.urgency, candidate.expectedBenefit,
    confidence, candidate.goalRelevance, 100 - candidate.executionBurden, candidate.timing]
  const digest = createHash('sha256').update(`${HEALTH_INTERVENTION_RULE_VERSION}\0${candidate.id}\0${stableVersionMaterial(versions)}\0${stableJson(candidate.parameters)}`).digest('hex')
  return {
    id: candidate.id, ruleId: candidate.ruleId, category: candidate.category, capabilityId: candidate.capabilityId,
    risk: candidate.risk, authority: candidate.authority, priority: candidate.priority, scoreTuple,
    sourceProjectionKeys: [...candidate.requiredProjectionKeys], parameters: candidate.parameters,
    rationale: candidate.rationale, idempotencyKey: `health-intervention-${digest}`, supersedes: [],
  }
}

export function decideHealthInterventions(input: DecideHealthInterventionsInput): HealthInterventionDecision {
  if (!plain(input)) throw new Error('HEALTH_INTERVENTION_INVALID_INPUT')
  const now = canonicalTimestamp(input.now, 'HEALTH_INTERVENTION_INVALID_NOW')
  const { projections, versions } = normalizeProjections(input.projections)
  const plan = normalizePlan(input.plan)
  const quietHours = normalizeQuietHours(input.quietHours)
  const recentActions = normalizeRecentActions(input.recentActions)
  const activeActions = normalizeActiveActions(input.activeActions)
  const considered: HealthInterventionDecision['considered'] = []
  const accepted: HealthActionCandidate[] = []

  for (const candidate of evaluateHealthInterventionRules({ projections, plan })) {
    assertRiskAuthority(candidate)
    const sourceReason = ruleGate(candidate, projections, now.nanoseconds)
    if (sourceReason) {
      considered.push({ id: candidate.id, accepted: false, reason: sourceReason })
      continue
    }
    if (candidate.authority === 'auto' && isQuietTime(now.nanoseconds, quietHours)) {
      considered.push({ id: candidate.id, accepted: false, reason: 'quiet_time' })
      continue
    }
    if (candidate.authority !== 'inform_only' && cooldownActive(candidate, recentActions, now.nanoseconds)) {
      considered.push({ id: candidate.id, accepted: false, reason: 'cooldown_active' })
      continue
    }
    accepted.push(publicCandidate(candidate, projections, versions))
    considered.push({ id: candidate.id, accepted: true, reason: 'ranked' })
  }

  accepted.sort(compareScore)
  let primary = accepted[0] ?? null
  if (primary) {
    const supersedes = activeActions.filter(item => item.supersedable && primary!.priority > item.priority).map(item => item.id)
    if (supersedes.length) primary = { ...primary, supersedes }
    for (const id of supersedes) considered.push({ id, accepted: false, reason: `superseded_by:${primary.id}` })
  }
  considered.sort((left, right) => compareUtf8(left.id, right.id))
  return {
    primary,
    alternatives: accepted.slice(1),
    considered,
    projectionVersions: versions,
    ruleVersion: HEALTH_INTERVENTION_RULE_VERSION,
    decidedAt: now.canonical,
  }
}
