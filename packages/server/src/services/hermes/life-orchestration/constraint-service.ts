import { createHash } from 'crypto'
import {
  ensurePrimarySubject,
  getTwinPreference,
  getTwinProjection,
  listTwinObservations,
  type TwinPreference,
  type TwinProjection,
} from '../personal-twin'
import { isLifeCurrency, LifeContractError, parseLifeTimeWindow } from './contracts'
import { createLifeConstraintSnapshot, listLifeCommitments } from './store'
import type {
  LifeConstraintFactRef,
  LifeConstraintSnapshot,
  LifeMoney,
  LifeReadinessBand,
  LifeRecoveryBand,
  LifeSleepDebtBand,
  LifeTimeWindow,
} from './types'

const DEFAULT_HEALTH_FRESHNESS_MS = 36 * 60 * 60_000
const DEFAULT_SCREEN_FRESHNESS_MS = 24 * 60 * 60_000
const MAX_FRESHNESS_MS = 30 * 24 * 60 * 60_000

export interface LifeConstraintPolicy {
  budget: LifeMoney
  screenTimeLimitMinutes: number
  leisureTimeLimitMinutes: number
  quietStartMinute: number
  quietEndMinute: number
  maxTravelRadiusKm: number
  excludedCategories: string[]
  preferredCategories: string[]
}

export interface BuildLifeConstraintSnapshotInput {
  subjectId?: string
  horizon: LifeTimeWindow
  timezone: string
  policy: LifeConstraintPolicy
  createdAt: string
  expiresAt: string
  healthFreshnessMs?: number
  screenTimeFreshnessMs?: number
  useTwinPreferences?: boolean
}

export function buildLifeConstraintSnapshot(input: BuildLifeConstraintSnapshotInput): LifeConstraintSnapshot {
  const subjectId = input.subjectId ?? 'person:self'
  const horizon = parseLifeTimeWindow(input.horizon)
  const createdAt = canonicalTimestamp(input.createdAt)
  const requestedExpiresAt = canonicalTimestamp(input.expiresAt)
  const healthFreshnessMs = freshness(input.healthFreshnessMs ?? DEFAULT_HEALTH_FRESHNESS_MS)
  const screenFreshnessMs = freshness(input.screenTimeFreshnessMs ?? DEFAULT_SCREEN_FRESHNESS_MS)
  validatePolicy(input.policy)
  if (Date.parse(requestedExpiresAt) <= Date.parse(createdAt)) {
    throw new LifeContractError('LIFE_CONSTRAINT_EXPIRED')
  }
  ensurePrimarySubject()
  const commitments = listLifeCommitments({ startsBefore: horizon.endsAt, endsAfter: horizon.startsAt, limit: 200 })
  const stale = commitments.find(commitment => Date.parse(commitment.expiresAt) <= Date.parse(createdAt))
  if (stale) throw new LifeContractError('LIFE_CONSTRAINT_COMMITMENT_STALE')
  const factRefs: LifeConstraintFactRef[] = commitments.map(commitment => ({
    recordId: commitment.id,
    recordDigest: commitment.sourceDigest,
    observedAt: commitment.observedAt,
  }))
  const hardWindows = commitments.filter(commitment => commitment.busy)
    .map(commitment => clipWindow(commitment, horizon)).filter((window): window is LifeTimeWindow => window !== null)
  const freeWindows = invertWindows(horizon, mergeWindows(hardWindows))

  const readinessProjection = getTwinProjection('health.readiness_state', subjectId)
  const recoveryProjection = getTwinProjection('health.recovery_state', subjectId)
  if (readinessProjection) factRefs.push(projectionFactRef(readinessProjection))
  if (recoveryProjection) factRefs.push(projectionFactRef(recoveryProjection))
  const readinessFresh = freshProjection(readinessProjection, createdAt, healthFreshnessMs)
  const recoveryFresh = freshProjection(recoveryProjection, createdAt, healthFreshnessMs)
  const readiness = readinessFresh && readinessProjection ? readinessBand(readinessProjection) : 'unknown'
  const recovery = recoveryFresh && recoveryProjection ? recoveryBand(recoveryProjection) : 'unknown'
  const sleepDebt = recoveryFresh && recoveryProjection ? sleepDebtBand(recoveryProjection) : 'unknown'

  const screenObservation = listTwinObservations({ entityId: subjectId,
    metric: 'digital.screen_time.used_minutes', limit: 1 })[0] ?? null
  if (screenObservation) factRefs.push({ recordId: semanticFactId('twin-observation', screenObservation.id),
    recordDigest: digest({ id: screenObservation.id, metric: screenObservation.metric,
      observedAt: screenObservation.observedAt, provenance: screenObservation.provenance,
      unit: screenObservation.unit, value: screenObservation.value }), observedAt: screenObservation.observedAt })
  const screenTimeUsedMinutes = freshScreenMinutes(screenObservation, createdAt, screenFreshnessMs)
    ?? input.policy.screenTimeLimitMinutes

  const preferredPreference = input.useTwinPreferences === false ? null
    : getTwinPreference(subjectId, 'life', 'preferred_categories')
  const excludedPreference = input.useTwinPreferences === false ? null
    : getTwinPreference(subjectId, 'life', 'excluded_categories')
  const preferredCategories = preferenceCategories(preferredPreference, input.policy.preferredCategories)
  const excludedCategories = preferenceCategories(excludedPreference, input.policy.excludedCategories)
  if (preferredPreference) factRefs.push(preferenceFactRef(preferredPreference))
  if (excludedPreference) factRefs.push(preferenceFactRef(excludedPreference))
  const policyMaterial = { ...input.policy, excludedCategories, preferredCategories }
  factRefs.push({ recordId: 'policy:life-planning', recordDigest: digest(policyMaterial), observedAt: createdAt })

  const expiryCandidates = [requestedExpiresAt, ...commitments.map(commitment => commitment.expiresAt)]
  if (readinessFresh && readinessProjection) expiryCandidates.push(freshUntil(readinessProjection, healthFreshnessMs))
  if (recoveryFresh && recoveryProjection) expiryCandidates.push(freshUntil(recoveryProjection, healthFreshnessMs))
  if (screenObservation && freshScreenMinutes(screenObservation, createdAt, screenFreshnessMs) !== null) {
    expiryCandidates.push(new Date(Date.parse(screenObservation.observedAt) + screenFreshnessMs).toISOString())
  }
  const expiresAt = expiryCandidates.sort(compare)[0]!
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new LifeContractError('LIFE_CONSTRAINT_EXPIRED')
  return createLifeConstraintSnapshot({ subjectId, horizon, timezone: input.timezone, freeWindows,
    commitmentIds: commitments.map(commitment => commitment.id), readiness, recovery, sleepDebt,
    screenTimeUsedMinutes, screenTimeLimitMinutes: input.policy.screenTimeLimitMinutes,
    leisureTimeLimitMinutes: input.policy.leisureTimeLimitMinutes, budget: input.policy.budget,
    quietStartMinute: input.policy.quietStartMinute, quietEndMinute: input.policy.quietEndMinute,
    maxTravelRadiusKm: input.policy.maxTravelRadiusKm, excludedCategories, preferredCategories,
    factRefs, createdAt, expiresAt })
}

function validatePolicy(policy: LifeConstraintPolicy): void {
  if (!policy || !policy.budget || !isLifeCurrency(policy.budget.currency)
    || !Number.isSafeInteger(policy.budget.amountMinor) || policy.budget.amountMinor < 0
    || !validMinutes(policy.screenTimeLimitMinutes) || !validMinutes(policy.leisureTimeLimitMinutes)
    || ![policy.quietStartMinute, policy.quietEndMinute].every(value => Number.isSafeInteger(value)
      && value >= 0 && value <= 1_439)
    || !Number.isSafeInteger(policy.maxTravelRadiusKm) || policy.maxTravelRadiusKm < 0
    || policy.maxTravelRadiusKm > 40_075 || !validCategories(policy.excludedCategories)
    || !validCategories(policy.preferredCategories)) throw new LifeContractError('LIFE_CONSTRAINT_POLICY_INVALID')
}

function freshProjection(projection: TwinProjection | null, createdAt: string, maxAgeMs: number): boolean {
  if (!projection) return false
  const computedAt = projectionComputedAt(projection)
  const freshnessStatus = nested(projection.value, 'freshness', 'status')
  const conflictCount = projection.value.conflictCount
  return freshnessStatus === 'fresh' && (conflictCount === undefined || conflictCount === 0)
    && computedAt !== null && Date.parse(computedAt) <= Date.parse(createdAt)
    && Date.parse(createdAt) - Date.parse(computedAt) <= maxAgeMs
}

function readinessBand(projection: TwinProjection): LifeReadinessBand {
  const status = nested(projection.value, 'state', 'status')
  const score = nested(projection.value, 'state', 'score')
  if (status === 'caution') return 'low'
  if (status !== 'ready' || typeof score !== 'number' || !Number.isFinite(score)) return 'unknown'
  return score >= 80 ? 'high' : score >= 50 ? 'normal' : 'low'
}

function recoveryBand(projection: TwinProjection): LifeRecoveryBand {
  const score = currentNumber(projection, 'recovery_score')
  if (score === null) return 'unknown'
  return score >= 80 ? 'good' : score >= 60 ? 'fair' : 'poor'
}

function sleepDebtBand(projection: TwinProjection): LifeSleepDebtBand {
  const duration = currentNumber(projection, 'duration_minutes')
  if (duration === null) return 'unknown'
  return duration >= 420 ? 'none' : duration >= 300 ? 'moderate' : 'high'
}

function currentNumber(projection: TwinProjection, key: string): number | null {
  const current = nested(projection.value, 'state', 'current')
  if (!plainRecord(current)) return null
  const candidate = current[key]
  const value = plainRecord(candidate) ? candidate.value : candidate
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function freshScreenMinutes(observation: ReturnType<typeof listTwinObservations>[number] | null,
  createdAt: string, maxAgeMs: number): number | null {
  if (!observation || !['min', 'minutes'].includes(observation.unit ?? '')
    || !Number.isSafeInteger(observation.value) || Number(observation.value) < 0
    || Number(observation.value) > 10_080 || Date.parse(observation.observedAt) > Date.parse(createdAt)
    || Date.parse(createdAt) - Date.parse(observation.observedAt) > maxAgeMs) return null
  return Number(observation.value)
}

function preferenceCategories(preference: TwinPreference | null, fallback: string[]): string[] {
  if (!preference) return [...fallback]
  if (!validCategories(preference.value)) throw new LifeContractError('LIFE_CONSTRAINT_PREFERENCE_INVALID')
  return [...preference.value]
}

function projectionFactRef(projection: TwinProjection): LifeConstraintFactRef {
  const observedAt = projectionComputedAt(projection) ?? projection.updatedAt
  return { recordId: semanticFactId('twin-projection', `${projection.key}:${projection.sourceRecordId}`),
    recordDigest: digest({ key: projection.key, sourceRecordId: projection.sourceRecordId,
      value: projection.value, version: projection.version, updatedAt: projection.updatedAt }), observedAt }
}

function preferenceFactRef(preference: TwinPreference): LifeConstraintFactRef {
  return { recordId: semanticFactId('twin-preference', preference.id),
    recordDigest: digest({ id: preference.id, domain: preference.domain, key: preference.key,
      value: preference.value, source: preference.provenance.source,
      sourceId: preference.provenance.sourceId, version: preference.version, updatedAt: preference.updatedAt }),
    observedAt: preference.updatedAt }
}

function freshUntil(projection: TwinProjection, maxAgeMs: number): string {
  const computedAt = projectionComputedAt(projection)
  if (!computedAt) throw new LifeContractError('LIFE_CONSTRAINT_HEALTH_INVALID')
  return new Date(Date.parse(computedAt) + maxAgeMs).toISOString()
}

function projectionComputedAt(projection: TwinProjection): string | null {
  const value = projection.value.computedAt
  return validTimestamp(value) ? value : validTimestamp(projection.updatedAt) ? projection.updatedAt : null
}

function clipWindow(window: { startsAt: string; endsAt: string }, horizon: LifeTimeWindow): LifeTimeWindow | null {
  const startsAt = window.startsAt < horizon.startsAt ? horizon.startsAt : window.startsAt
  const endsAt = window.endsAt > horizon.endsAt ? horizon.endsAt : window.endsAt
  return startsAt < endsAt ? { startsAt, endsAt } : null
}

function mergeWindows(windows: LifeTimeWindow[]): LifeTimeWindow[] {
  const ordered = [...windows].sort((left, right) => compare(left.startsAt, right.startsAt)
    || compare(left.endsAt, right.endsAt))
  const merged: LifeTimeWindow[] = []
  for (const window of ordered) {
    const previous = merged[merged.length - 1]
    if (!previous || window.startsAt > previous.endsAt) merged.push({ ...window })
    else if (window.endsAt > previous.endsAt) previous.endsAt = window.endsAt
  }
  return merged
}

function invertWindows(horizon: LifeTimeWindow, busy: LifeTimeWindow[]): LifeTimeWindow[] {
  const result: LifeTimeWindow[] = []
  let cursor = horizon.startsAt
  for (const window of busy) {
    if (cursor < window.startsAt) result.push({ startsAt: cursor, endsAt: window.startsAt })
    if (window.endsAt > cursor) cursor = window.endsAt
  }
  if (cursor < horizon.endsAt) result.push({ startsAt: cursor, endsAt: horizon.endsAt })
  return result
}

function semanticFactId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function digest(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex') }
function freshness(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FRESHNESS_MS) {
    throw new LifeContractError('LIFE_CONSTRAINT_FRESHNESS_INVALID')
  }
  return value
}
function validMinutes(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 10_080 }
function validCategories(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(item)) && new Set(value).size === value.length
}
function canonicalTimestamp(value: string): string {
  if (!validTimestamp(value)) throw new LifeContractError('LIFE_TIME_INVALID')
  return value
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}
function nested(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!plainRecord(current)) return undefined
    current = current[key]
  }
  return current
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LifeContractError('LIFE_CONSTRAINT_FACT_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!plainRecord(value)) throw new LifeContractError('LIFE_CONSTRAINT_FACT_INVALID')
  return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
