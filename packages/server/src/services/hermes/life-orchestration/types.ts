export const LIFE_SOURCE_KINDS = [
  'calendar', 'contacts', 'travel', 'music', 'games', 'subscriptions',
] as const
export type LifeSourceKind = typeof LIFE_SOURCE_KINDS[number]

export const LIFE_EXECUTION_MODES = ['observe', 'shadow', 'live'] as const
export type LifeExecutionMode = typeof LIFE_EXECUTION_MODES[number]

export const LIFE_ACCOUNT_HEALTH = ['unknown', 'healthy', 'degraded', 'unhealthy', 'revoked'] as const
export type LifeAccountHealth = typeof LIFE_ACCOUNT_HEALTH[number]

export const LIFE_OPTION_KINDS = ['travel', 'video', 'music', 'game'] as const
export type LifeOptionKind = typeof LIFE_OPTION_KINDS[number]

export const LIFE_COMMITMENT_CATEGORIES = [
  'work', 'personal', 'health', 'travel', 'leisure', 'other',
] as const
export type LifeCommitmentCategory = typeof LIFE_COMMITMENT_CATEGORIES[number]

export const LIFE_LOCATION_CLASSES = ['remote', 'home', 'local', 'out_of_area', 'unknown'] as const
export type LifeLocationClass = typeof LIFE_LOCATION_CLASSES[number]

export const LIFE_READINESS_BANDS = ['unknown', 'low', 'normal', 'high'] as const
export type LifeReadinessBand = typeof LIFE_READINESS_BANDS[number]

export const LIFE_RECOVERY_BANDS = ['unknown', 'poor', 'fair', 'good'] as const
export type LifeRecoveryBand = typeof LIFE_RECOVERY_BANDS[number]

export const LIFE_SLEEP_DEBT_BANDS = ['unknown', 'none', 'moderate', 'high'] as const
export type LifeSleepDebtBand = typeof LIFE_SLEEP_DEBT_BANDS[number]

export const LIFE_SUBSCRIPTION_STATES = [
  'active', 'trial', 'paused', 'cancel_pending', 'cancelled', 'expired',
] as const
export type LifeSubscriptionState = typeof LIFE_SUBSCRIPTION_STATES[number]

export const LIFE_PLAN_STATES = ['proposed', 'reserved', 'superseded', 'completed', 'expired'] as const
export type LifePlanState = typeof LIFE_PLAN_STATES[number]

export const LIFE_HOLD_STATES = [
  'requested', 'submitting', 'confirmed', 'cancel_requested', 'cancelling', 'cancelled',
  'lookup_required', 'waiting_user', 'failed',
] as const
export type LifeCalendarHoldState = typeof LIFE_HOLD_STATES[number]

export const LIFE_CANCELLATION_STATES = [
  'requested', 'submitting', 'processing', 'cancelled', 'rejected', 'lookup_required', 'waiting_user', 'failed',
] as const
export type LifeSubscriptionCancellationState = typeof LIFE_CANCELLATION_STATES[number]

export const LIFE_HANDOFF_KINDS = ['commerce', 'internet', 'android'] as const
export type LifeHandoffKind = typeof LIFE_HANDOFF_KINDS[number]

export const LIFE_HANDOFF_STATES = ['proposed', 'accepted', 'expired', 'cancelled'] as const
export type LifeHandoffState = typeof LIFE_HANDOFF_STATES[number]

export interface LifeMoney { currency: string; amountMinor: number }
export interface LifeTimeWindow { startsAt: string; endsAt: string }

export interface LifeSourceAccount {
  id: string
  sourceKind: LifeSourceKind
  mode: LifeExecutionMode
  executorId: string | null
  displayName: string
  health: LifeAccountHealth
  enabled: boolean
  policyEpoch: number
  version: number
  createdAt: string
  updatedAt: string
  revokedAt: string | null
}

export interface LifeCommitment {
  id: string
  accountId: string
  providerItemId: string
  label: string
  category: LifeCommitmentCategory
  startsAt: string
  endsAt: string
  allDay: boolean
  busy: boolean
  locationClass: LifeLocationClass
  participantAliasIds: string[]
  observedAt: string
  expiresAt: string
  sourceDigest: string
}

export interface LifeContactAlias {
  id: string
  accountId: string
  providerContactId: string
  alias: string
  relationshipTags: string[]
  availabilityTags: string[]
  observedAt: string
  sourceDigest: string
}

export interface LifeOption {
  id: string
  accountId: string | null
  kind: LifeOptionKind
  source: string
  providerItemId: string
  title: string
  categoryTags: string[]
  durationMinutes: number
  exertion: 'low' | 'medium' | 'high'
  screenBased: boolean
  locationClass: LifeLocationClass
  cost: LifeMoney | null
  available: boolean
  observedAt: string
  expiresAt: string
  sourceDigest: string
}

export interface LifeSubscription {
  id: string
  accountId: string
  providerSubscriptionId: string
  serviceLabel: string
  planLabel: string
  recurringCost: LifeMoney
  renewalAt: string
  cancellationDeadline: string | null
  state: LifeSubscriptionState
  observedAt: string
  sourceDigest: string
  version: number
}

export interface LifeConstraintFactRef {
  recordId: string
  recordDigest: string
  observedAt: string
}

export interface LifeConstraintSnapshot {
  id: string
  subjectId: string
  horizon: LifeTimeWindow
  timezone: string
  freeWindows: LifeTimeWindow[]
  commitmentIds: string[]
  readiness: LifeReadinessBand
  recovery: LifeRecoveryBand
  sleepDebt: LifeSleepDebtBand
  screenTimeUsedMinutes: number
  screenTimeLimitMinutes: number
  leisureTimeLimitMinutes: number
  budget: LifeMoney
  quietStartMinute: number
  quietEndMinute: number
  maxTravelRadiusKm: number
  excludedCategories: string[]
  preferredCategories: string[]
  factRefs: LifeConstraintFactRef[]
  materialDigest: string
  createdAt: string
  expiresAt: string
}

export interface LifePlanCandidate {
  optionId: string
  eligible: boolean
  score: number | null
  exclusionCodes: string[]
  rationaleCodes: string[]
}

export interface LifePlanSession extends LifeTimeWindow {
  optionId: string
  cost: LifeMoney | null
  rationaleCodes: string[]
}

export interface LifePlanRevision {
  id: string
  constraintSnapshotId: string
  constraintDigest: string
  candidates: LifePlanCandidate[]
  sessions: LifePlanSession[]
  totalMinutes: number
  totalCost: LifeMoney
  planDigest: string
  state: LifePlanState
  version: number
  createdAt: string
  updatedAt: string
}

export interface LifeCalendarHold {
  id: string
  workflowId: string
  intentId: string
  accountId: string
  planRevisionId: string
  planDigest: string
  optionId: string
  window: LifeTimeWindow
  providerRequestId: string
  providerHoldId: string | null
  receiptDigest: string | null
  state: LifeCalendarHoldState
  policyEpoch: number
  version: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface LifeSubscriptionCancellation {
  id: string
  workflowId: string
  intentId: string
  accountId: string
  subscriptionId: string
  subscriptionDigest: string
  providerRequestId: string
  reasonCode: string
  providerReceiptId: string | null
  receiptDigest: string | null
  state: LifeSubscriptionCancellationState
  policyEpoch: number
  version: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface LifeHandoff {
  id: string
  planRevisionId: string
  optionId: string
  kind: LifeHandoffKind
  targetCapabilityId: string
  materialDigest: string
  state: LifeHandoffState
  version: number
  createdAt: string
  updatedAt: string
}

export interface LifeCheckpoint {
  id: string
  aggregateId: string
  ordinal: number
  stage: string
  evidenceDigest: string | null
  errorCode: string | null
  details: Record<string, unknown>
  observedAt: string
}
