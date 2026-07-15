import { CommerceContractError, assertCommerceSafeData, isCommerceCurrency, isCommerceDigest,
  isCommerceSemanticId } from './contracts'
import { ensureBuiltInAssistantRoles, updateAssistantRole } from '../personal-twin'
import {
  commerceCanonicalDigest,
  getCommerceAccount,
  getRecentCommerceShadowEvidence,
  recordCommerceActivationReview,
  updateCommerceAccount,
} from './store'
import type { CommerceActivationReview, CommerceExecutionMode, CommerceProviderAccount } from './types'

export const COMMERCE_SHADOW_EXECUTOR_ID = 'commerce-shadow'
export const COMMERCE_LIVE_EXECUTOR_ID = 'commerce-live'
const RECENT_SHADOW_MS = 7 * 24 * 60 * 60_000

export interface CommerceActivationLimits {
  currency: string
  perActionMinor: number
  dailyMinor: number
  merchantIds: string[]
  destinationDigests: string[]
}

export interface CommerceModeTransitionResult {
  account: CommerceProviderAccount
  review: CommerceActivationReview
}

export function transitionCommerceAccountMode(input: {
  accountId: string
  toMode: CommerceExecutionMode
  actorUserId: string
  actorIsSuperAdmin: boolean
  limits: CommerceActivationLimits
  now?: string
}): CommerceModeTransitionResult {
  const now = validNow(input.now)
  const account = getCommerceAccount(input.accountId)
  if (!account) throw new CommerceContractError('COMMERCE_ACCOUNT_NOT_FOUND')
  const limits = validateLimits(input.limits, account)
  const limitsDigest = commerceCanonicalDigest(limits)
  if (!input.actorIsSuperAdmin || !isCommerceSemanticId(input.actorUserId)) {
    throw new CommerceContractError('COMMERCE_ACTIVATION_SUPER_ADMIN_REQUIRED')
  }
  if (account.mode === input.toMode) throw new CommerceContractError('COMMERCE_ACTIVATION_MODE_UNCHANGED')
  if (account.health === 'revoked') throw new CommerceContractError('COMMERCE_ACCOUNT_REVOKED')
  if (account.mode === 'observe' && input.toMode === 'live') {
    return denied(account, input, limitsDigest, null, now, 'COMMERCE_ACTIVATION_SHADOW_REQUIRED')
  }
  let shadowEvidenceDigest: string | null = null
  if (input.toMode === 'live') {
    const evidence = getRecentCommerceShadowEvidence({ accountId: account.id,
      since: new Date(Date.parse(now) - RECENT_SHADOW_MS).toISOString() })
    shadowEvidenceDigest = evidence?.evidenceDigest ?? null
    if (account.mode !== 'shadow' || account.health !== 'healthy' || !account.enabled || !evidence
      || limits.perActionMinor < 1 || limits.dailyMinor < limits.perActionMinor
      || limits.destinationDigests.length < 1) {
      return denied(account, input, limitsDigest, shadowEvidenceDigest, now, 'COMMERCE_ACTIVATION_GATE_FAILED')
    }
  }
  const review = recordCommerceActivationReview({ accountId: account.id, fromMode: account.mode,
    toMode: input.toMode, actorUserId: input.actorUserId, shadowEvidenceDigest, limitsDigest,
    approved: true, createdAt: now })
  const executorId = input.toMode === 'live' ? COMMERCE_LIVE_EXECUTOR_ID
    : input.toMode === 'shadow' ? COMMERCE_SHADOW_EXECUTOR_ID : null
  const updated = updateCommerceAccount({ accountId: account.id, expectedVersion: account.version,
    mode: input.toMode, executorId, enabled: true, activationReviewId: review.id, updatedAt: now })
  ensureBuiltInAssistantRoles()
  updateAssistantRole('commerce-assistant', { spendingLimits: { currency: limits.currency,
    perAction: limits.perActionMinor, daily: limits.dailyMinor } })
  return { account: updated, review }
}

export function updateCommerceAccountHealth(input: {
  accountId: string
  health: Exclude<CommerceProviderAccount['health'], 'revoked'>
  expectedVersion: number
  now?: string
}): CommerceProviderAccount {
  return updateCommerceAccount({ accountId: input.accountId, expectedVersion: input.expectedVersion,
    health: input.health, updatedAt: validNow(input.now) })
}

export function revokeCommerceAccount(input: {
  accountId: string
  actorUserId: string
  actorIsSuperAdmin: boolean
  expectedVersion: number
  now?: string
}): CommerceProviderAccount {
  if (!input.actorIsSuperAdmin || !isCommerceSemanticId(input.actorUserId)) {
    throw new CommerceContractError('COMMERCE_ACTIVATION_SUPER_ADMIN_REQUIRED')
  }
  return updateCommerceAccount({ accountId: input.accountId, expectedVersion: input.expectedVersion,
    revoke: true, updatedAt: validNow(input.now) })
}

function denied(
  account: CommerceProviderAccount,
  input: Parameters<typeof transitionCommerceAccountMode>[0],
  limitsDigest: string,
  shadowEvidenceDigest: string | null,
  now: string,
  code: string,
): never {
  recordCommerceActivationReview({ accountId: account.id, fromMode: account.mode, toMode: input.toMode,
    actorUserId: input.actorUserId, shadowEvidenceDigest, limitsDigest, approved: false, createdAt: now })
  throw new CommerceContractError(code)
}

function validateLimits(input: CommerceActivationLimits, account: CommerceProviderAccount): CommerceActivationLimits {
  assertCommerceSafeData(input)
  if (!input || !isCommerceCurrency(input.currency) || input.currency !== account.currency
    || !Number.isSafeInteger(input.perActionMinor) || input.perActionMinor < 0
    || !Number.isSafeInteger(input.dailyMinor) || input.dailyMinor < 0
    || !Array.isArray(input.merchantIds) || input.merchantIds.length > 30
    || input.merchantIds.some(item => !isCommerceSemanticId(item))
    || !Array.isArray(input.destinationDigests) || input.destinationDigests.length > 30
    || input.destinationDigests.some(item => !isCommerceDigest(item))) {
    throw new CommerceContractError('COMMERCE_ACTIVATION_LIMITS_INVALID')
  }
  const merchantIds = [...new Set(input.merchantIds)].sort()
  const destinationDigests = [...new Set(input.destinationDigests)].sort()
  if (merchantIds.length !== input.merchantIds.length || destinationDigests.length !== input.destinationDigests.length) {
    throw new CommerceContractError('COMMERCE_ACTIVATION_LIMITS_INVALID')
  }
  return { currency: input.currency, perActionMinor: input.perActionMinor,
    dailyMinor: input.dailyMinor, merchantIds, destinationDigests }
}

function validNow(value?: string): string {
  const now = value ?? new Date().toISOString()
  if (new Date(now).toISOString() !== now) throw new CommerceContractError('COMMERCE_TIME_INVALID')
  return now
}
