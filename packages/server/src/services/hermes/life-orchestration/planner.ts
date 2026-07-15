import {
  createLifeHandoff,
  createLifePlanRevision,
  getLifeCommitment,
  getLifeConstraintSnapshot,
  getLifeOption,
  getLifePlanRevision,
  listLifeCommitments,
  listLifeOptions,
  type CreateLifeHandoffInput,
} from './store'
import { LifeContractError } from './contracts'
import type {
  LifeConstraintSnapshot,
  LifeHandoff,
  LifeOption,
  LifePlanCandidate,
  LifePlanRevision,
  LifePlanSession,
  LifeTimeWindow,
} from './types'

const MAX_OPTIONS = 64
const MAX_SESSIONS = 32
const MAX_HORIZON_MS = 7 * 24 * 60 * 60_000
const TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

interface CandidateWork {
  option: LifeOption
  candidate: LifePlanCandidate
  baseScore: number
}

export interface LifePlannerResult {
  plan: LifePlanRevision
  handoffs: LifeHandoff[]
}

export interface LifePlanVerification {
  valid: boolean
  reasonCodes: string[]
  checkedAt: string
}

export function planLifeLeisure(input: {
  constraintSnapshotId: string
  activeAt: string
  maxOptions?: number
  maxSessions?: number
}): LifePlannerResult {
  const activeAt = timestamp(input.activeAt)
  const maxOptions = bounded(input.maxOptions ?? MAX_OPTIONS, 1, MAX_OPTIONS, 'LIFE_PLAN_OPTION_LIMIT_INVALID')
  const maxSessions = bounded(input.maxSessions ?? 8, 1, MAX_SESSIONS, 'LIFE_PLAN_SESSION_LIMIT_INVALID')
  const constraint = getLifeConstraintSnapshot(input.constraintSnapshotId)
  if (!constraint) throw new LifeContractError('LIFE_CONSTRAINT_NOT_FOUND')
  if (Date.parse(constraint.expiresAt) <= Date.parse(activeAt)) throw new LifeContractError('LIFE_CONSTRAINT_EXPIRED')
  if (Date.parse(activeAt) >= Date.parse(constraint.horizon.endsAt)) {
    throw new LifeContractError('LIFE_PLAN_HORIZON_EXPIRED')
  }
  if (Date.parse(constraint.horizon.endsAt) - Date.parse(constraint.horizon.startsAt) > MAX_HORIZON_MS) {
    throw new LifeContractError('LIFE_PLAN_HORIZON_TOO_LARGE')
  }
  const options = currentOptions(listLifeOptions({ limit: 200 })).sort((left, right) => compare(left.id, right.id))
    .slice(0, maxOptions)
  if (options.length === 0) throw new LifeContractError('LIFE_PLAN_OPTIONS_EMPTY')
  const works = options.map(option => staticCandidate(option, constraint, activeAt))
  const sessions: LifePlanSession[] = []
  const selectedKinds = new Set<string>()
  let usedMinutes = 0
  let usedScreenMinutes = 0
  let usedCostMinor = 0
  const pending = works.filter(work => work.candidate.eligible)
  while (pending.length > 0 && sessions.length < maxSessions) {
    pending.sort((left, right) => dynamicScore(right, selectedKinds) - dynamicScore(left, selectedKinds)
      || compare(left.option.id, right.option.id))
    const work = pending.shift()!
    const option = work.option
    const exclusionCodes: string[] = []
    const optionCost = option.cost?.amountMinor ?? 0
    if (usedMinutes + option.durationMinutes > constraint.leisureTimeLimitMinutes) {
      exclusionCodes.push('LEISURE_TIME_LIMIT')
    }
    if (option.screenBased && usedScreenMinutes + option.durationMinutes
      > Math.max(0, constraint.screenTimeLimitMinutes - constraint.screenTimeUsedMinutes)) {
      exclusionCodes.push('SCREEN_TIME_LIMIT')
    }
    if (usedCostMinor + optionCost > constraint.budget.amountMinor) exclusionCodes.push('BUDGET_EXCEEDED')
    const slot = exclusionCodes.length ? null : findEarliestSlot(constraint, option, sessions, activeAt)
    if (exclusionCodes.length === 0 && !slot) exclusionCodes.push('SCHEDULE_UNAVAILABLE')
    if (exclusionCodes.length > 0) {
      work.candidate = { ...work.candidate, eligible: false, score: null,
        exclusionCodes: uniqueCodes([...work.candidate.exclusionCodes, ...exclusionCodes]) }
      continue
    }
    const variety = selectedKinds.has(option.kind) ? 0 : 25_000
    const rationaleCodes = uniqueCodes([...work.candidate.rationaleCodes, 'SCHEDULE_FIT',
      ...(variety ? ['VARIETY_BONUS'] : [])])
    work.candidate = { ...work.candidate, score: Math.min(1_000_000, work.baseScore + variety), rationaleCodes }
    sessions.push({ optionId: option.id, ...slot!, cost: option.cost ? { ...option.cost } : null, rationaleCodes })
    usedMinutes += option.durationMinutes
    if (option.screenBased) usedScreenMinutes += option.durationMinutes
    usedCostMinor += optionCost
    selectedKinds.add(option.kind)
  }
  const candidates = works.map(work => work.candidate)
  const plan = createLifePlanRevision({ constraintSnapshotId: constraint.id, candidates, sessions, createdAt: activeAt })
  const handoffs = createPlanHandoffs(plan, sessions, options, activeAt)
  return { plan, handoffs }
}

export function verifyLifePlanRevision(input: { planId: string; activeAt: string }): LifePlanVerification {
  const checkedAt = timestamp(input.activeAt)
  const plan = getLifePlanRevision(input.planId)
  if (!plan) throw new LifeContractError('LIFE_PLAN_NOT_FOUND')
  const constraint = getLifeConstraintSnapshot(plan.constraintSnapshotId)
  if (!constraint || constraint.materialDigest !== plan.constraintDigest) {
    return { valid: false, reasonCodes: ['CONSTRAINT_MATERIAL_MISMATCH'], checkedAt }
  }
  const reasons: string[] = []
  if (Date.parse(constraint.expiresAt) <= Date.parse(checkedAt)) reasons.push('CONSTRAINT_EXPIRED')
  if (['superseded', 'completed', 'expired'].includes(plan.state)) reasons.push('PLAN_TERMINAL')
  const allOptions = listLifeOptions({ limit: 200 })
  const latestOptions = new Map(currentOptions(allOptions).map(option => [optionIdentity(option), option]))
  for (const session of plan.sessions) {
    const option = getLifeOption(session.optionId)
    if (!option) { reasons.push('OPTION_MISSING'); continue }
    if (!option.available || Date.parse(option.expiresAt) <= Math.max(Date.parse(session.endsAt), Date.parse(checkedAt))) {
      reasons.push('OPTION_EXPIRED')
    }
    if (Date.parse(session.startsAt) < Date.parse(checkedAt)) reasons.push('SESSION_STARTED')
    if (latestOptions.get(optionIdentity(option))?.id !== option.id) reasons.push('OPTION_MATERIAL_CHANGED')
  }
  const allCommitments = listLifeCommitments({ limit: 200 }).sort((left, right) =>
    compare(right.observedAt, left.observedAt) || compare(right.id, left.id))
  const latestCommitments = new Map<string, typeof allCommitments[number]>()
  for (const commitment of allCommitments) {
    const identity = `${commitment.accountId}\0${commitment.providerItemId}`
    if (!latestCommitments.has(identity)) latestCommitments.set(identity, commitment)
  }
  for (const commitmentId of constraint.commitmentIds) {
    const commitment = getLifeCommitment(commitmentId)
    if (!commitment) { reasons.push('COMMITMENT_MISSING'); continue }
    if (latestCommitments.get(`${commitment.accountId}\0${commitment.providerItemId}`)?.id !== commitment.id) {
      reasons.push('COMMITMENT_MATERIAL_CHANGED')
    }
  }
  const reasonCodes = uniqueCodes(reasons)
  return { valid: reasonCodes.length === 0, reasonCodes, checkedAt }
}

function staticCandidate(option: LifeOption, constraint: LifeConstraintSnapshot, activeAt: string): CandidateWork {
  const exclusionCodes: string[] = []
  const rationaleCodes: string[] = []
  if (!option.available) exclusionCodes.push('OPTION_UNAVAILABLE')
  if (Date.parse(option.expiresAt) <= Date.parse(activeAt)) exclusionCodes.push('OPTION_EXPIRED')
  if (option.categoryTags.some(tag => constraint.excludedCategories.includes(tag))) {
    exclusionCodes.push('CATEGORY_EXCLUDED')
  }
  if (option.cost && option.cost.currency !== constraint.budget.currency) exclusionCodes.push('CURRENCY_MISMATCH')
  if ((option.cost?.amountMinor ?? 0) > constraint.budget.amountMinor) exclusionCodes.push('BUDGET_EXCEEDED')
  if (option.durationMinutes > constraint.leisureTimeLimitMinutes) exclusionCodes.push('LEISURE_TIME_LIMIT')
  const remainingScreen = Math.max(0, constraint.screenTimeLimitMinutes - constraint.screenTimeUsedMinutes)
  if (option.screenBased && option.durationMinutes > remainingScreen) exclusionCodes.push('SCREEN_TIME_LIMIT')
  if (constraint.readiness === 'unknown' && (option.exertion !== 'low' || option.durationMinutes > 30)) {
    exclusionCodes.push('READINESS_UNKNOWN_SCOPE')
  }
  if (constraint.readiness === 'low' && option.exertion === 'high'
    || constraint.recovery === 'poor' && option.exertion === 'high') exclusionCodes.push('HEALTH_EXERTION_LIMIT')
  if (option.screenBased && (constraint.sleepDebt === 'high' && option.durationMinutes > 30
    || constraint.sleepDebt === 'moderate' && option.durationMinutes > 60)) exclusionCodes.push('SLEEP_DEBT_SCREEN_LIMIT')
  if (option.kind === 'travel') {
    if (option.locationClass === 'unknown') exclusionCodes.push('TRAVEL_RADIUS_UNKNOWN')
    else if (option.locationClass === 'out_of_area'
      || constraint.maxTravelRadiusKm === 0 && option.locationClass === 'local') {
      exclusionCodes.push('TRAVEL_RADIUS_EXCEEDED')
    }
  }
  const preferenceMatches = option.categoryTags.filter(tag => constraint.preferredCategories.includes(tag)).length
  if (preferenceMatches) rationaleCodes.push('PREFERENCE_MATCH')
  if (!exclusionCodes.includes('BUDGET_EXCEEDED') && !exclusionCodes.includes('CURRENCY_MISMATCH')) {
    rationaleCodes.push('WITHIN_BUDGET')
  }
  if (!exclusionCodes.some(code => code.includes('HEALTH') || code.includes('READINESS') || code.includes('SLEEP'))) {
    rationaleCodes.push('HEALTH_FIT')
  }
  const baseScore = score(option, constraint, activeAt, preferenceMatches)
  const eligible = exclusionCodes.length === 0
  return { option, baseScore, candidate: { optionId: option.id, eligible,
    score: eligible ? baseScore : null, exclusionCodes: uniqueCodes(exclusionCodes),
    rationaleCodes: uniqueCodes(rationaleCodes) } }
}

function score(option: LifeOption, constraint: LifeConstraintSnapshot, activeAt: string,
  preferenceMatches: number): number {
  const preference = Math.min(preferenceMatches, 2) * 100_000
  const duration = Math.max(0, 60_000 - option.durationMinutes * 500)
  const cost = option.cost?.amountMinor ?? 0
  const costEfficiency = constraint.budget.amountMinor === 0 ? (cost === 0 ? 100_000 : 0)
    : Math.max(0, 100_000 - Math.floor(cost * 100_000 / constraint.budget.amountMinor))
  const health = option.exertion === 'low' ? 50_000 : option.exertion === 'medium' ? 25_000 : 0
  const validityMs = Math.max(0, Math.min(7 * 24 * 60 * 60_000,
    Date.parse(option.expiresAt) - Date.parse(activeAt)))
  const recency = Math.floor(validityMs / (7 * 24 * 60 * 60_000) * 40_000)
  return Math.min(975_000, 500_000 + preference + duration + costEfficiency + health + recency)
}

function dynamicScore(work: CandidateWork, selectedKinds: Set<string>): number {
  return work.baseScore + (selectedKinds.has(work.option.kind) ? 0 : 25_000)
}

function findEarliestSlot(constraint: LifeConstraintSnapshot, option: LifeOption,
  sessions: LifePlanSession[], activeAt: string): LifeTimeWindow | null {
  const durationMs = option.durationMinutes * 60_000
  const available = subtractSessions(constraint.freeWindows, sessions)
  for (const window of available) {
    const effectiveEnd = option.expiresAt < window.endsAt ? option.expiresAt : window.endsAt
    let candidateMs = Math.max(Date.parse(window.startsAt), Date.parse(activeAt))
    const latestStart = Date.parse(effectiveEnd) - durationMs
    while (candidateMs <= latestStart) {
      const endsMs = candidateMs + durationMs
      if (!touchesQuiet(candidateMs, endsMs, constraint)) {
        return { startsAt: new Date(candidateMs).toISOString(), endsAt: new Date(endsMs).toISOString() }
      }
      candidateMs += 60_000
    }
  }
  return null
}

function subtractSessions(windows: LifeTimeWindow[], sessions: LifePlanSession[]): LifeTimeWindow[] {
  let result = windows.map(window => ({ ...window }))
  for (const session of [...sessions].sort((left, right) => compare(left.startsAt, right.startsAt))) {
    const next: LifeTimeWindow[] = []
    for (const window of result) {
      if (session.endsAt <= window.startsAt || session.startsAt >= window.endsAt) next.push(window)
      else {
        if (window.startsAt < session.startsAt) next.push({ startsAt: window.startsAt, endsAt: session.startsAt })
        if (session.endsAt < window.endsAt) next.push({ startsAt: session.endsAt, endsAt: window.endsAt })
      }
    }
    result = next
  }
  return result.sort((left, right) => compare(left.startsAt, right.startsAt))
}

function touchesQuiet(startsMs: number, endsMs: number, constraint: LifeConstraintSnapshot): boolean {
  if (constraint.quietStartMinute === constraint.quietEndMinute) return false
  for (let value = startsMs; value < endsMs; value += 60_000) {
    if (isQuietMinute(localMinute(value, constraint.timezone), constraint.quietStartMinute,
      constraint.quietEndMinute)) return true
  }
  return isQuietMinute(localMinute(Math.max(startsMs, endsMs - 1), constraint.timezone),
    constraint.quietStartMinute, constraint.quietEndMinute)
}

function localMinute(timestampMs: number, timezone: string): number {
  let formatter = TIME_FORMATTERS.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23' })
    TIME_FORMATTERS.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(new Date(timestampMs))
  const hour = Number(parts.find(part => part.type === 'hour')?.value)
  const minute = Number(parts.find(part => part.type === 'minute')?.value)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new LifeContractError('LIFE_TIMEZONE_INVALID')
  return hour * 60 + minute
}

function isQuietMinute(value: number, start: number, end: number): boolean {
  return start < end ? value >= start && value < end : value >= start || value < end
}

function createPlanHandoffs(plan: LifePlanRevision, sessions: LifePlanSession[], options: LifeOption[],
  createdAt: string): LifeHandoff[] {
  const byId = new Map(options.map(option => [option.id, option]))
  const inputs: CreateLifeHandoffInput[] = []
  for (const session of sessions) {
    const option = byId.get(session.optionId)
    if (!option) continue
    if ((option.cost?.amountMinor ?? 0) > 0) inputs.push({ planRevisionId: plan.id, optionId: option.id,
      kind: 'commerce', targetCapabilityId: 'commerce.product.search', createdAt })
    else if (option.kind === 'video' && option.source === 'bilibili') inputs.push({ planRevisionId: plan.id,
      optionId: option.id, kind: 'internet', targetCapabilityId: 'bilibili.video.search', createdAt })
    else if (option.kind === 'music' || option.kind === 'game') inputs.push({ planRevisionId: plan.id,
      optionId: option.id, kind: 'android', targetCapabilityId: 'android.app.launch', createdAt })
  }
  return inputs.map(createLifeHandoff)
}

function currentOptions(options: LifeOption[]): LifeOption[] {
  const result = new Map<string, LifeOption>()
  for (const option of [...options].sort((left, right) => compare(right.observedAt, left.observedAt)
    || compare(right.id, left.id))) {
    const identity = optionIdentity(option)
    if (!result.has(identity)) result.set(identity, option)
  }
  return [...result.values()]
}

function optionIdentity(option: LifeOption): string {
  return `${option.accountId ?? 'bilibili'}\0${option.source}\0${option.providerItemId}`
}

function uniqueCodes(values: string[]): string[] { return [...new Set(values)].sort(compare) }
function bounded(value: number, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new LifeContractError(code)
  return value
}
function timestamp(value: string): string {
  const parsed = Date.parse(value)
  if (typeof value !== 'string' || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new LifeContractError('LIFE_TIME_INVALID')
  }
  return value
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
