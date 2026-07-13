import { createHash } from 'crypto'
import { types as utilTypes } from 'util'
import type { TwinProjection } from '../personal-twin'
import { canonicalizeHealthTimestamp, healthTimestampEpochNanoseconds } from './normalizers'
import {
  HEALTH_PROJECTION_KEYS,
  healthProjectionSourceRecordId,
  type HealthProjectionEnvelope,
  type HealthProjectionKey,
  type HealthProjectionSet,
} from './projectors'
import {
  evaluateHealthInterventionRules,
  HEALTH_ACTION_SAFETY_CATALOG,
  HEALTH_INTERVENTION_RULE_VERSION,
  type HealthInterventionAuthority,
  type HealthInterventionCategory,
  type HealthInterventionPlan,
  type HealthInterventionRisk,
  type HealthRuleCandidate,
  type HealthRuleGatePolicy,
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
  risk: HealthInterventionRisk
  authority: HealthInterventionAuthority
}

export interface DecideHealthInterventionsInput {
  projections: readonly TwinProjection[]
  now: string
  plan?: HealthInterventionPlan
  quietHours?: HealthInterventionQuietHours
  recentActions?: readonly HealthRecentAction[]
  activeActions?: readonly HealthActiveAction[]
  effectiveDate?: string
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
  effectiveDate: string
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
const MAX_FRESHNESS_AGE_MS = Number.MAX_SAFE_INTEGER
const MAX_COOLDOWN_MS = 366 * 86_400_000
const MAX_BOUNDARY_DEPTH = 32
const MAX_BOUNDARY_NODES = 200_000
const MAX_BOUNDARY_BYTES = 16 * 1024 * 1024
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const INPUT_KEYS = new Set(['projections', 'now', 'plan', 'quietHours', 'recentActions', 'activeActions', 'effectiveDate'])
const AUTHORITY_ORDER: Record<HealthInterventionAuthority, number> = { auto: 0, approval: 1, inform_only: 2 }

function assertSafeBoundary(root: unknown): void {
  const seen = new WeakSet<object>()
  let nodes = 0
  let bytes = 0
  const addBytes = (value: string): void => {
    bytes += Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_BOUNDARY_BYTES) throw new Error('boundary bytes')
  }
  const visit = (value: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_BOUNDARY_NODES || depth > MAX_BOUNDARY_DEPTH) throw new Error('boundary size')
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'string') { addBytes(value); return }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('boundary number')
      return
    }
    if (typeof value !== 'object' || utilTypes.isProxy(value)) throw new Error('boundary type')
    if (seen.has(value)) throw new Error('boundary cycle')
    seen.add(value)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('boundary array')
      const keys = Reflect.ownKeys(value)
      if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key)))) throw new Error('boundary array key')
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('boundary array hole')
        visit(descriptor.value, depth + 1)
      }
      if (keys.length !== value.length + 1) throw new Error('boundary array extra')
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('boundary object')
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || POISON_KEYS.has(key)) throw new Error('boundary key')
      addBytes(key)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('boundary accessor')
      visit(descriptor.value, depth + 1)
    }
  }
  try { visit(root, 0) } catch { throw new Error('HEALTH_INTERVENTION_INVALID_INPUT') }
}

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
  const envelopeKeys = ['schemaVersion', 'ruleVersion', 'state', 'inputRecordIds', 'effectiveAt', 'computedAt',
    'freshness', 'confidence', 'conflicts', 'conflictCount', 'conflictOmittedCount', 'missing', 'rationale'].sort().join(',')
  const freshnessKeys = ['policyVersion', 'status', 'thresholdMs', 'ageMs'].sort().join(',')
  if (!plain(value) || Object.keys(value).sort().join(',') !== envelopeKeys
    || value.schemaVersion !== 1 || typeof value.ruleVersion !== 'string' || !value.ruleVersion
    || !plain(value.state) || !Array.isArray(value.inputRecordIds) || typeof value.computedAt !== 'string'
    || !plain(value.freshness) || Object.keys(value.freshness).sort().join(',') !== freshnessKeys
    || !FRESHNESS.has(String(value.freshness.status))
    || typeof value.freshness.thresholdMs !== 'number' || !Number.isSafeInteger(value.freshness.thresholdMs) || value.freshness.thresholdMs < 0
    || (value.freshness.ageMs !== null && (typeof value.freshness.ageMs !== 'number' || !Number.isFinite(value.freshness.ageMs)
      || value.freshness.ageMs < 0 || value.freshness.ageMs > MAX_FRESHNESS_AGE_MS))
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
    || !Array.isArray(value.conflicts) || typeof value.conflictCount !== 'number'
    || !Number.isSafeInteger(value.conflictCount) || value.conflictCount < 0
    || typeof value.conflictOmittedCount !== 'number'
    || !Number.isSafeInteger(value.conflictOmittedCount) || value.conflictOmittedCount < 0
    || !Array.isArray(value.missing) || !Array.isArray(value.rationale)) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTION')
  canonicalTimestamp(value.computedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION')
  if (value.effectiveAt !== null) canonicalTimestamp(value.effectiveAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION')
  if (value.inputRecordIds.length > 4_096 || value.inputRecordIds.some(item => typeof item !== 'string' || !item || item.length > 200)
    || new Set(value.inputRecordIds).size !== value.inputRecordIds.length
    || value.missing.length > 256 || value.missing.some(item => typeof item !== 'string' || !item || item.length > 200)
    || new Set(value.missing).size !== value.missing.length || value.conflicts.length > 32 || value.rationale.length > 64
    || typeof value.freshness.policyVersion !== 'string' || !value.freshness.policyVersion
    || value.conflictCount < value.conflicts.length || value.conflictOmittedCount !== value.conflictCount - value.conflicts.length
    || value.rationale.some(item => !plain(item) || Object.keys(item).sort().join(',') !== 'code,message'
      || typeof item.code !== 'string' || !item.code || item.code.length > 100
      || typeof item.message !== 'string' || !item.message || item.message.length > 1_000)
    || value.conflicts.some(item => !plain(item) || Object.keys(item).sort().join(',') !== 'code,message,metric,omittedRecordCount,recordCount,recordIds'
      || !['FUTURE_RECORD', 'INVALID_RECORD', 'UNIT_CONFLICT', 'VALUE_CONFLICT', 'SOURCE_CONFLICT'].includes(String(item.code))
      || typeof item.metric !== 'string' || !item.metric || item.metric.length > 200
      || !Array.isArray(item.recordIds) || item.recordIds.some(id => typeof id !== 'string' || !id || id.length > 200)
      || typeof item.recordCount !== 'number' || !Number.isSafeInteger(item.recordCount) || item.recordCount < item.recordIds.length
      || typeof item.omittedRecordCount !== 'number' || !Number.isSafeInteger(item.omittedRecordCount)
      || item.omittedRecordCount !== item.recordCount - item.recordIds.length
      || typeof item.message !== 'string' || !item.message || item.message.length > 1_000)) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTION')
  return value as unknown as HealthProjectionEnvelope
}

function normalizeProjections(values: readonly TwinProjection[], nowNs: bigint): {
  projections: Map<HealthProjectionKey, HealthRuleProjection>
  versions: Record<string, number>
} {
  if (!Array.isArray(values) || values.length !== HEALTH_PROJECTION_KEYS.length) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
  const projections = new Map<HealthProjectionKey, HealthRuleProjection>()
  let snapshotNs: bigint | null = null
  let sourceRecordId: string | null = null
  let projectorRuleVersion: string | null = null
  for (const value of values) {
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'key,sourceRecordId,subjectId,updatedAt,value,version'
      || !PROJECTION_KEY_SET.has(value.key) || value.subjectId !== 'person:self'
      || typeof value.sourceRecordId !== 'string' || !/^health-projection-[a-f0-9]{64}$/.test(value.sourceRecordId)
      || typeof value.updatedAt !== 'string'
      || !Number.isSafeInteger(value.version) || value.version < 1 || projections.has(value.key as HealthProjectionKey)) {
      throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    }
    const updated = canonicalTimestamp(value.updatedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    const key = value.key as HealthProjectionKey
    const envelope = validateEnvelope(value.value)
    if ((sourceRecordId !== null && sourceRecordId !== value.sourceRecordId)
      || (projectorRuleVersion !== null && projectorRuleVersion !== envelope.ruleVersion)) {
      throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    }
    sourceRecordId = value.sourceRecordId
    projectorRuleVersion = envelope.ruleVersion
    const computed = canonicalTimestamp(envelope.computedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION')
    if (computed.nanoseconds > nowNs || updated.nanoseconds > nowNs) throw new Error('HEALTH_INTERVENTION_FUTURE_SNAPSHOT')
    if (computed.nanoseconds !== updated.nanoseconds || (snapshotNs !== null && snapshotNs !== computed.nanoseconds)) {
      throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    }
    snapshotNs = computed.nanoseconds
    projections.set(key, { key, version: value.version, envelope })
  }
  const versions: Record<string, number> = {}
  for (const key of HEALTH_PROJECTION_KEYS) {
    const item = projections.get(key)
    if (!item) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
    versions[key] = item.version
  }
  const projectionSet = Object.fromEntries(HEALTH_PROJECTION_KEYS.map(key => [key, projections.get(key)!.envelope])) as HealthProjectionSet
  if (sourceRecordId !== healthProjectionSourceRecordId(projectionSet)) throw new Error('HEALTH_INTERVENTION_INVALID_PROJECTIONS')
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

function normalizeEffectiveDate(value: string | undefined, canonicalNow: string): string {
  const date = value ?? canonicalNow.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('HEALTH_INTERVENTION_INVALID_EFFECTIVE_DATE')
  const parsed = canonicalTimestamp(`${date}T00:00:00Z`, 'HEALTH_INTERVENTION_INVALID_EFFECTIVE_DATE')
  if (parsed.canonical.slice(0, 10) !== date) throw new Error('HEALTH_INTERVENTION_INVALID_EFFECTIVE_DATE')
  return date
}

function normalizeRecentActions(values: readonly HealthRecentAction[] | undefined, nowNs: bigint): Array<HealthRecentAction & { actedNs: bigint; cooldownNs: bigint | null }> {
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
    if (acted.nanoseconds > nowNs || (cooldown && (cooldown.nanoseconds < acted.nanoseconds
      || cooldown.nanoseconds - acted.nanoseconds > BigInt(MAX_COOLDOWN_MS) * 1_000_000n))) throw new Error('HEALTH_INTERVENTION_INVALID_HISTORY')
    return {
      candidateId: recent.candidateId, category: recent.category, actedAt: acted.canonical,
      ...(cooldown ? { cooldownUntil: cooldown.canonical } : {}), actedNs: acted.nanoseconds, cooldownNs: cooldown?.nanoseconds ?? null,
    }
  }).sort((left, right) => compareUtf8(left.candidateId, right.candidateId) || compareBigInt(left.actedNs, right.actedNs))
}

interface NormalizedActiveAction extends HealthActiveAction { knownSafety: boolean }

function normalizeActiveActions(values: readonly HealthActiveAction[] | undefined): NormalizedActiveAction[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > MAX_HISTORY_ITEMS) throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
  const seen = new Set<string>()
  const result = values.map(value => {
    if (!plain(value) || Object.keys(value).sort().join(',') !== 'authority,candidateId,id,priority,risk,supersedable') {
      throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    }
    const active = value as unknown as HealthActiveAction
    assertBoundedIdentifier(active.id, 'HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    assertBoundedIdentifier(active.candidateId, 'HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    if (seen.has(active.id) || !Number.isSafeInteger(active.priority) || active.priority < 0 || active.priority > 100
      || typeof active.supersedable !== 'boolean' || !Object.prototype.hasOwnProperty.call(RISK_ORDER, active.risk)
      || !Object.prototype.hasOwnProperty.call(AUTHORITY_ORDER, active.authority)) throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    try { assertRiskAuthorityPair(active.risk, active.authority, active.authority === 'inform_only' ? null : 'active') } catch {
      throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    }
    const catalog = HEALTH_ACTION_SAFETY_CATALOG[active.candidateId]
    if (catalog && (catalog.risk !== active.risk || catalog.authority !== active.authority)) {
      throw new Error('HEALTH_INTERVENTION_INVALID_ACTIVE_ACTIONS')
    }
    seen.add(active.id)
    return { id: active.id, candidateId: active.candidateId, priority: active.priority,
      supersedable: catalog ? active.supersedable : false, risk: active.risk, authority: active.authority, knownSafety: !!catalog }
  })
  return result.sort((left, right) => compareUtf8(left.id, right.id))
}

function millisecondsToNanoseconds(value: number): bigint {
  const whole = Math.trunc(value)
  const fractional = Math.ceil((value - whole) * 1_000_000)
  return BigInt(whole) * 1_000_000n + BigInt(fractional)
}

function pathValue(root: Record<string, unknown>, path: string): unknown {
  let value: unknown = root
  const segments = path.split('.')
  for (let index = 0; index < segments.length; index += 1) {
    if (!plain(value)) return undefined
    const remainder = segments.slice(index).join('.')
    if (Object.prototype.hasOwnProperty.call(value, remainder)) return value[remainder]
    const segment = segments[index]
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

function presentSignal(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

interface SignalMetadata {
  recordIds: Set<string>
  observed: bigint[]
  confidences: number[]
}

function collectMetadata(value: unknown, output: SignalMetadata): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMetadata(item, output)
    return
  }
  if (!plain(value)) return
  if (typeof value.recordId === 'string') output.recordIds.add(value.recordId)
  if (typeof value.observedAt === 'string') output.observed.push(
    canonicalTimestamp(value.observedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION').nanoseconds,
  )
  if (typeof value.confidence === 'number' && Number.isFinite(value.confidence)) output.confidences.push(value.confidence)
  for (const [key, item] of Object.entries(value)) {
    if (!['recordId', 'observedAt', 'confidence'].includes(key)) collectMetadata(item, output)
  }
}

function collectMetadataForRecords(value: unknown, expected: ReadonlySet<string>, output: SignalMetadata): void {
  if (Array.isArray(value)) { for (const item of value) collectMetadataForRecords(item, expected, output); return }
  if (!plain(value)) return
  if (typeof value.recordId === 'string' && expected.has(value.recordId)) {
    output.recordIds.add(value.recordId)
    if (typeof value.observedAt === 'string') output.observed.push(
      canonicalTimestamp(value.observedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION').nanoseconds,
    )
    if (typeof value.confidence === 'number' && Number.isFinite(value.confidence)) output.confidences.push(value.confidence)
  }
  for (const item of Object.values(value)) collectMetadataForRecords(item, expected, output)
}

function signalMetadata(policy: HealthRuleGatePolicy, projections: ReadonlyMap<HealthProjectionKey, HealthRuleProjection>): SignalMetadata | null {
  const combined: SignalMetadata = { recordIds: new Set(), observed: [], confidences: [] }
  for (const requirement of policy.signals) {
    const projection = projections.get(requirement.projectionKey)
    if (!projection) return null
    const values = requirement.statePaths.map(path => pathValue(projection.envelope.state, path))
    const present = values.map(presentSignal)
    if (requirement.match === 'all' ? present.some(item => !item) : present.every(item => !item)) return null
    let local: SignalMetadata = { recordIds: new Set(), observed: [], confidences: [] }
    for (let index = 0; index < values.length; index += 1) if (present[index]) collectMetadata(values[index], local)
    if (requirement.recordIds?.length) {
      const expected = new Set(requirement.recordIds)
      const selected: SignalMetadata = { recordIds: new Set(), observed: [], confidences: [] }
      for (let index = 0; index < values.length; index += 1) if (present[index]) collectMetadataForRecords(values[index], expected, selected)
      if (requirement.recordIds.some(id => !selected.recordIds.has(id))) return null
      local = selected
    }
    const evidence = pathValue(projection.envelope.state, 'evidence')
    if (evidence !== undefined) {
      if (local.recordIds.size > 0) {
        const matchingEvidence = Array.isArray(evidence) ? evidence : Object.values(evidence as Record<string, unknown>)
        const visitEvidence = (value: unknown): void => {
          if (Array.isArray(value)) { for (const item of value) visitEvidence(item); return }
          if (!plain(value)) return
          if (typeof value.recordId === 'string' && local.recordIds.has(value.recordId)
            && typeof value.confidence === 'number' && Number.isFinite(value.confidence)) local.confidences.push(value.confidence)
          for (const item of Object.values(value)) visitEvidence(item)
        }
        visitEvidence(matchingEvidence)
      }
    }
    for (const id of local.recordIds) combined.recordIds.add(id)
    combined.observed.push(...local.observed)
    combined.confidences.push(...local.confidences)
  }
  return combined
}

function ruleGate(candidate: HealthRuleCandidate, projections: ReadonlyMap<HealthProjectionKey, HealthRuleProjection>, nowNs: bigint): string | null {
  const policy = candidate.gatePolicy
  const signals = signalMetadata(policy, projections)
  if (!signals) return 'source_missing'
  const envelopes = policy.signals.map(item => projections.get(item.projectionKey)!.envelope)
  if (policy.conflicts === 'projection' && envelopes.some(item => item.conflictCount > 0 || item.conflicts.length > 0)) return 'source_conflict'
  if (policy.conflicts === 'signal') {
    const signalMetrics = new Set(policy.signals.flatMap(item => item.metrics))
    const related = envelopes.some(item => item.conflicts.some(conflict => !Array.isArray(conflict.recordIds)
      || conflict.recordIds.some(id => signals.recordIds.has(id)) || signalMetrics.has(conflict.metric)))
    if (related || (signals.recordIds.size === 0 && envelopes.some(item => item.conflicts.length > 0))) return 'source_conflict'
  }
  if (policy.freshness === 'projection') {
    for (const value of envelopes) {
      if (value.freshness.status === 'missing' || value.missing.length > 0 || value.freshness.ageMs === null) return 'source_missing'
      if (value.freshness.status === 'stale') return 'source_stale'
      if (value.freshness.status !== 'fresh') return 'source_unavailable'
      const computed = canonicalTimestamp(value.computedAt, 'HEALTH_INTERVENTION_INVALID_PROJECTION')
      if (computed.nanoseconds > nowNs) return 'source_future'
      const effectiveAgeNs = millisecondsToNanoseconds(value.freshness.ageMs) + nowNs - computed.nanoseconds
      if (effectiveAgeNs > BigInt(value.freshness.thresholdMs) * 1_000_000n) return 'source_stale'
    }
  } else if (policy.freshness === 'signal') {
    if (!signals.observed.length) return 'source_missing'
    if (signals.observed.some(item => item > nowNs)) return 'source_future'
    const oldest = signals.observed.reduce((earliest, item) => item < earliest ? item : earliest)
    const threshold = Math.min(...envelopes.map(item => item.freshness.thresholdMs))
    if (nowNs - oldest > BigInt(threshold) * 1_000_000n) return 'source_stale'
  }
  if (policy.confidence === 'projection' && envelopes.some(item => item.confidence < policy.minimumConfidence)) return 'source_low_confidence'
  if (policy.confidence === 'signal') {
    if (!signals.confidences.length || Math.min(...signals.confidences) < policy.minimumConfidence) return 'source_low_confidence'
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

function assertRiskAuthorityPair(risk: HealthInterventionRisk, authority: HealthInterventionAuthority, capabilityId: string | null): void {
  if (authority === 'auto' && RISK_ORDER[risk] > RISK_ORDER.low) throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
  if (authority === 'approval' && RISK_ORDER[risk] < RISK_ORDER.medium) throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
  if (RISK_ORDER[risk] >= RISK_ORDER.high && (authority !== 'inform_only' || capabilityId !== null)) {
    throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
  }
  if (authority === 'inform_only' && capabilityId !== null) throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
}

function assertRiskAuthority(candidate: HealthRuleCandidate): void {
  assertRiskAuthorityPair(candidate.risk, candidate.authority, candidate.capabilityId)
  const catalog = HEALTH_ACTION_SAFETY_CATALOG[candidate.id]
  if (!catalog || catalog.risk !== candidate.risk || catalog.authority !== candidate.authority) {
    throw new Error('HEALTH_INTERVENTION_UNSAFE_RULE')
  }
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
  versions: Record<string, number>, effectiveDate: string): HealthActionCandidate {
  assertRiskAuthority(candidate)
  const confidence = Math.round(candidateConfidence(candidate, projections) * 100)
  const safetyLayer = candidate.risk === 'critical' ? 2 : candidate.risk === 'high' ? 1 : 0
  const scoreTuple: HealthActionCandidate['scoreTuple'] = [safetyLayer, candidate.priority, candidate.urgency,
    candidate.expectedBenefit, confidence, candidate.goalRelevance, candidate.timing - candidate.executionBurden]
  const digest = createHash('sha256').update(`${HEALTH_INTERVENTION_RULE_VERSION}\0${effectiveDate}\0${candidate.id}\0${stableVersionMaterial(versions)}\0${stableJson(candidate.parameters)}`).digest('hex')
  return {
    id: candidate.id, ruleId: candidate.ruleId, category: candidate.category, capabilityId: candidate.capabilityId,
    risk: candidate.risk, authority: candidate.authority, priority: candidate.priority, scoreTuple,
    sourceProjectionKeys: [...candidate.requiredProjectionKeys], parameters: candidate.parameters,
    rationale: candidate.rationale, idempotencyKey: `health-intervention-${digest}`, supersedes: [], effectiveDate,
  }
}

function activeDisposition(candidate: HealthActionCandidate, activeActions: readonly NormalizedActiveAction[]): {
  reason: string | null
  supersedes: string[]
} {
  const duplicate = activeActions.find(active => active.candidateId === candidate.id)
  if (duplicate) return { reason: `duplicate_active_action:${duplicate.id}`, supersedes: [] }
  if (candidate.authority === 'inform_only') return { reason: null, supersedes: [] }
  const supersedes: string[] = []
  for (const active of activeActions) {
    if (!active.knownSafety) return { reason: `active_action_unknown_safety:${active.id}`, supersedes: [] }
    if (!active.supersedable) return { reason: `active_action_not_supersedable:${active.id}`, supersedes: [] }
    if (RISK_ORDER[candidate.risk] < RISK_ORDER[active.risk]) return { reason: `active_action_higher_risk:${active.id}`, supersedes: [] }
    if (AUTHORITY_ORDER[candidate.authority] < AUTHORITY_ORDER[active.authority]) {
      return { reason: `active_action_stronger_authority:${active.id}`, supersedes: [] }
    }
    if (candidate.priority <= active.priority) return { reason: `active_action_priority_not_higher:${active.id}`, supersedes: [] }
    supersedes.push(active.id)
  }
  return { reason: null, supersedes }
}

export function decideHealthInterventions(input: DecideHealthInterventionsInput): HealthInterventionDecision {
  assertSafeBoundary(input)
  if (!plain(input) || Object.keys(input).some(key => !INPUT_KEYS.has(key))) throw new Error('HEALTH_INTERVENTION_INVALID_INPUT')
  const now = canonicalTimestamp(input.now, 'HEALTH_INTERVENTION_INVALID_NOW')
  const effectiveDate = normalizeEffectiveDate(input.effectiveDate, now.canonical)
  const { projections, versions } = normalizeProjections(input.projections, now.nanoseconds)
  const plan = normalizePlan(input.plan)
  const quietHours = normalizeQuietHours(input.quietHours)
  const recentActions = normalizeRecentActions(input.recentActions, now.nanoseconds)
  const activeActions = normalizeActiveActions(input.activeActions)
  const considered: HealthInterventionDecision['considered'] = []
  const eligible: HealthActionCandidate[] = []

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
    eligible.push(publicCandidate(candidate, projections, versions, effectiveDate))
  }

  eligible.sort(compareScore)
  const accepted: HealthActionCandidate[] = []
  const supersedesByCandidate = new Map<string, string[]>()
  for (const candidate of eligible) {
    const disposition = activeDisposition(candidate, activeActions)
    if (disposition.reason) {
      considered.push({ id: candidate.id, accepted: false, reason: disposition.reason })
      continue
    }
    accepted.push(candidate)
    supersedesByCandidate.set(candidate.id, disposition.supersedes)
    considered.push({ id: candidate.id, accepted: true, reason: 'ranked' })
  }
  const selected = accepted[0] ?? null
  const primarySupersedes = selected ? supersedesByCandidate.get(selected.id) ?? [] : []
  const primary = selected && primarySupersedes.length ? { ...selected, supersedes: primarySupersedes } : selected
  if (primary) for (const id of primary.supersedes) considered.push({ id, accepted: false, reason: `superseded_by:${primary.id}` })
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
