import {
  assertLifeSafeData,
  isLifeCurrency,
  isLifeExecutionMode,
  isLifeSemanticId,
  LifeContractError,
} from './contracts'
import {
  getLifeSourceAccount,
  getLifeSubscription,
  getRecentLifeShadowEvidence,
  lifeCanonicalDigest,
  recordLifeActivationReview,
  updateLifeSourceAccount,
} from './store'
import type { LifeActivationReview, LifeExecutionMode, LifeSourceAccount } from './types'

export const LIFE_SOURCE_EXECUTOR_ID = 'life-source'
export const LIFE_SHADOW_EXECUTOR_ID = 'life-shadow'
export const LIFE_LIVE_EXECUTOR_ID = 'life-live'
const RECENT_SHADOW_MS = 7 * 24 * 60 * 60_000

export interface LifeActivationLimits {
  currency: string
  calendarIds: string[]
  subscriptionIds: string[]
}

export interface LifeModeTransitionResult {
  account: LifeSourceAccount
  review: LifeActivationReview
}

export function transitionLifeSourceAccountMode(input: {
  accountId: string
  toMode: LifeExecutionMode
  actorUserId: string
  actorIsSuperAdmin: boolean
  limits: LifeActivationLimits
  now?: string
}): LifeModeTransitionResult {
  const now = validNow(input.now)
  const account = getLifeSourceAccount(input.accountId)
  if (!account) throw new LifeContractError('LIFE_ACCOUNT_NOT_FOUND')
  const limits = validateLimits(input.limits, account)
  const limitsDigest = lifeCanonicalDigest(limits)
  if (!input.actorIsSuperAdmin || !isLifeSemanticId(input.actorUserId)) {
    throw new LifeContractError('LIFE_ACTIVATION_SUPER_ADMIN_REQUIRED')
  }
  if (!isLifeExecutionMode(input.toMode) || account.mode === input.toMode) {
    throw new LifeContractError('LIFE_ACTIVATION_MODE_INVALID')
  }
  if (account.health === 'revoked') throw new LifeContractError('LIFE_ACCOUNT_REVOKED')
  if (account.mode === 'observe' && input.toMode === 'live') {
    return denied(account, input, limitsDigest, null, now, 'LIFE_ACTIVATION_SHADOW_REQUIRED')
  }
  let shadowEvidenceDigest: string | null = null
  if (input.toMode === 'live') {
    const evidence = getRecentLifeShadowEvidence({ accountId: account.id,
      since: new Date(Date.parse(now) - RECENT_SHADOW_MS).toISOString() })
    shadowEvidenceDigest = evidence?.evidenceDigest ?? null
    const targetBound = account.sourceKind === 'calendar' ? limits.calendarIds.includes(account.id)
      : account.sourceKind === 'subscriptions' && limits.subscriptionIds.length > 0
    if (account.mode !== 'shadow' || account.health !== 'healthy' || !account.enabled || !evidence || !targetBound) {
      return denied(account, input, limitsDigest, shadowEvidenceDigest, now, 'LIFE_ACTIVATION_GATE_FAILED')
    }
  }
  const review = recordLifeActivationReview({ accountId: account.id, fromMode: account.mode,
    toMode: input.toMode, actorUserId: input.actorUserId, shadowEvidenceDigest, limitsDigest,
    approved: true, createdAt: now })
  const executorId = input.toMode === 'live' ? LIFE_LIVE_EXECUTOR_ID
    : input.toMode === 'shadow' ? LIFE_SHADOW_EXECUTOR_ID : LIFE_SOURCE_EXECUTOR_ID
  const updated = updateLifeSourceAccount({ accountId: account.id, expectedVersion: account.version,
    mode: input.toMode, executorId, enabled: true, activationReviewId: review.id, updatedAt: now })
  return { account: updated, review }
}

export function updateLifeSourceAccountHealth(input: {
  accountId: string
  health: Exclude<LifeSourceAccount['health'], 'revoked'>
  expectedVersion: number
  now?: string
}): LifeSourceAccount {
  return updateLifeSourceAccount({ accountId: input.accountId, expectedVersion: input.expectedVersion,
    health: input.health, updatedAt: validNow(input.now) })
}

export function revokeLifeSourceAccount(input: {
  accountId: string
  actorUserId: string
  actorIsSuperAdmin: boolean
  expectedVersion: number
  now?: string
}): LifeSourceAccount {
  if (!input.actorIsSuperAdmin || !isLifeSemanticId(input.actorUserId)) {
    throw new LifeContractError('LIFE_ACTIVATION_SUPER_ADMIN_REQUIRED')
  }
  return updateLifeSourceAccount({ accountId: input.accountId, expectedVersion: input.expectedVersion,
    revoke: true, updatedAt: validNow(input.now) })
}

function denied(
  account: LifeSourceAccount,
  input: Parameters<typeof transitionLifeSourceAccountMode>[0],
  limitsDigest: string,
  shadowEvidenceDigest: string | null,
  now: string,
  code: string,
): never {
  recordLifeActivationReview({ accountId: account.id, fromMode: account.mode, toMode: input.toMode,
    actorUserId: input.actorUserId, shadowEvidenceDigest, limitsDigest, approved: false, createdAt: now })
  throw new LifeContractError(code)
}

function validateLimits(input: LifeActivationLimits, account: LifeSourceAccount): LifeActivationLimits {
  assertLifeSafeData(input)
  if (!input || !isLifeCurrency(input.currency)
    || !Array.isArray(input.calendarIds) || input.calendarIds.length > 30
    || input.calendarIds.some(item => !isLifeSemanticId(item))
    || !Array.isArray(input.subscriptionIds) || input.subscriptionIds.length > 30
    || input.subscriptionIds.some(item => !isLifeSemanticId(item))) {
    throw new LifeContractError('LIFE_ACTIVATION_LIMITS_INVALID')
  }
  const calendarIds = uniqueSorted(input.calendarIds)
  const subscriptionIds = uniqueSorted(input.subscriptionIds)
  if (calendarIds.length !== input.calendarIds.length || subscriptionIds.length !== input.subscriptionIds.length
    || account.sourceKind !== 'calendar' && calendarIds.length > 0
    || account.sourceKind !== 'subscriptions' && subscriptionIds.length > 0
    || calendarIds.some(id => id !== account.id)
    || subscriptionIds.some(id => getLifeSubscription(id)?.accountId !== account.id)) {
    throw new LifeContractError('LIFE_ACTIVATION_LIMITS_INVALID')
  }
  return { currency: input.currency, calendarIds, subscriptionIds }
}

function uniqueSorted(values: string[]): string[] { return [...new Set(values)].sort(compare) }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function validNow(value?: string): string {
  const now = value ?? new Date().toISOString()
  const parsed = Date.parse(now)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== now) {
    throw new LifeContractError('LIFE_TIME_INVALID')
  }
  return now
}
