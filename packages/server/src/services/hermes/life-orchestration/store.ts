import { createHash } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  assertLifeSafeData,
  isLegalLifeCancellationTransition,
  isLegalLifeHandoffTransition,
  isLegalLifeHoldTransition,
  isLegalLifePlanTransition,
  isLifeAccountHealth,
  isLifeCalendarHoldState,
  isLifeCurrency,
  isLifeDigest,
  isLifeErrorCode,
  isLifeExecutionMode,
  isLifeHandoffKind,
  isLifeHandoffState,
  isLifeOptionKind,
  isLifePlanState,
  isLifeSemanticId,
  isLifeSourceKind,
  isLifeSubscriptionCancellationState,
  isLifeSubscriptionState,
  isLifeTimezone,
  LifeContractError,
  parseLifeTimeWindow,
} from './contracts'
import { withLifeOrchestrationDb } from './database'
import type {
  LifeActivationReview,
  LifeCalendarHold,
  LifeCalendarHoldState,
  LifeCheckpoint,
  LifeCommitment,
  LifeConstraintFactRef,
  LifeConstraintSnapshot,
  LifeContactAlias,
  LifeHandoff,
  LifeHandoffState,
  LifeMoney,
  LifeOption,
  LifePlanCandidate,
  LifePlanRevision,
  LifePlanSession,
  LifePlanState,
  LifeSourceAccount,
  LifeSubscription,
  LifeSubscriptionCancellation,
  LifeSubscriptionCancellationState,
  LifeTimeWindow,
} from './types'

const MAX_LIST = 200
const MAX_SAFE_MONEY = Number.MAX_SAFE_INTEGER
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const WORKFLOW_ID = /^workflow-[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/
const INTENT_ID = /^intent-[A-Za-z0-9][A-Za-z0-9._:-]{0,192}$/
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const STAGE = /^[a-z][a-z0-9_]{1,79}$/

type AccountRow = {
  id: string; source_kind: LifeSourceAccount['sourceKind']; mode: LifeSourceAccount['mode']; executor_id: string | null
  display_name: string; health: LifeSourceAccount['health']; enabled: number; policy_epoch: number; version: number
  created_at: string; updated_at: string; revoked_at: string | null
}
type CommitmentRow = {
  id: string; account_id: string; provider_item_id: string; label: string; category: LifeCommitment['category']
  starts_at: string; ends_at: string; all_day: number; busy: number; location_class: LifeCommitment['locationClass']
  participant_alias_ids_json: string; observed_at: string; expires_at: string; source_digest: string; created_at: string
}
type ContactRow = {
  id: string; account_id: string; provider_contact_id: string; alias: string; relationship_tags_json: string
  availability_tags_json: string; observed_at: string; source_digest: string; created_at: string
}
type OptionRow = {
  id: string; account_id: string | null; kind: LifeOption['kind']; source: string; provider_item_id: string
  title: string; category_tags_json: string; duration_minutes: number; exertion: LifeOption['exertion']
  screen_based: number; location_class: LifeOption['locationClass']; cost_currency: string | null
  cost_minor: number | null; available: number; observed_at: string; expires_at: string; source_digest: string
  created_at: string
}
type SubscriptionRow = {
  id: string; account_id: string; provider_subscription_id: string; service_label: string; plan_label: string
  currency: string; recurring_cost_minor: number; renewal_at: string; cancellation_deadline: string | null
  state: LifeSubscription['state']; observed_at: string; source_digest: string; version: number
  created_at: string; updated_at: string
}
type ConstraintRow = {
  id: string; subject_id: string; horizon_start: string; horizon_end: string; timezone: string
  free_windows_json: string; commitment_ids_json: string; readiness: LifeConstraintSnapshot['readiness']
  recovery: LifeConstraintSnapshot['recovery']; sleep_debt: LifeConstraintSnapshot['sleepDebt']
  screen_time_used_minutes: number; screen_time_limit_minutes: number; leisure_time_limit_minutes: number
  budget_currency: string; budget_minor: number; quiet_start_minute: number; quiet_end_minute: number
  max_travel_radius_km: number; excluded_categories_json: string; preferred_categories_json: string
  fact_refs_json: string; material_digest: string; created_at: string; expires_at: string
}
type PlanRow = {
  id: string; constraint_snapshot_id: string; constraint_digest: string; candidates_json: string
  sessions_json: string; total_minutes: number; total_currency: string; total_cost_minor: number
  plan_digest: string; state: LifePlanState; version: number; created_at: string; updated_at: string
}
type HoldRow = {
  id: string; workflow_id: string; intent_id: string; account_id: string; plan_revision_id: string
  plan_digest: string; option_id: string; starts_at: string; ends_at: string; provider_request_id: string
  provider_hold_id: string | null; receipt_digest: string | null; state: LifeCalendarHoldState
  policy_epoch: number; version: number; created_at: string; updated_at: string; completed_at: string | null
}
type CancellationRow = {
  id: string; workflow_id: string; intent_id: string; account_id: string; subscription_id: string
  subscription_digest: string; provider_request_id: string; reason_code: string; provider_receipt_id: string | null
  receipt_digest: string | null; state: LifeSubscriptionCancellationState; policy_epoch: number; version: number
  created_at: string; updated_at: string; completed_at: string | null
}
type HandoffRow = {
  id: string; plan_revision_id: string; option_id: string; kind: LifeHandoff['kind']; target_capability_id: string
  material_digest: string; state: LifeHandoffState; version: number; created_at: string; updated_at: string
}
type CheckpointRow = {
  aggregate_kind: 'calendar_hold' | 'subscription_cancellation'; aggregate_id: string; ordinal: number
  stage: string; evidence_digest: string | null; error_code: string | null; details_json: string
  observed_at: string; created_at: string
}
type ActivationRow = {
  id: string; account_id: string; from_mode: LifeActivationReview['fromMode']; to_mode: LifeActivationReview['toMode']
  actor_user_id: string; shadow_evidence_digest: string | null; limits_digest: string; approved: number; created_at: string
}

export interface CreateLifeSourceAccountInput {
  id: string
  sourceKind: LifeSourceAccount['sourceKind']
  mode: LifeSourceAccount['mode']
  executorId?: string | null
  displayName: string
  enabled?: boolean
}
export interface UpdateLifeSourceAccountInput {
  accountId: string
  expectedVersion: number
  mode?: LifeSourceAccount['mode']
  health?: Exclude<LifeSourceAccount['health'], 'revoked'>
  enabled?: boolean
  executorId?: string | null
  revoke?: boolean
  activationReviewId?: string
  updatedAt?: string
}
export interface RecordLifeCommitmentInput extends Omit<LifeCommitment, 'id'> {}
export interface RecordLifeContactAliasInput extends Omit<LifeContactAlias, 'id'> {}
export interface RecordLifeOptionInput extends Omit<LifeOption, 'id'> {}
export interface RecordLifeSubscriptionInput extends Omit<LifeSubscription, 'id' | 'version'> {}
export interface CreateLifeConstraintSnapshotInput extends Omit<LifeConstraintSnapshot, 'id' | 'materialDigest'> {}
export interface CreateLifePlanRevisionInput {
  constraintSnapshotId: string
  candidates: LifePlanCandidate[]
  sessions: LifePlanSession[]
  createdAt?: string
}
export interface TransitionLifePlanInput { planId: string; expectedVersion: number; state: LifePlanState; updatedAt?: string }
export interface CreateLifeCalendarHoldInput {
  workflowId: string; intentId: string; accountId: string; planRevisionId: string; optionId: string
  window: LifeTimeWindow; providerRequestId: string; createdAt?: string
}
export interface TransitionLifeCalendarHoldInput {
  holdId: string; expectedVersion: number; state: LifeCalendarHoldState
  providerHoldId?: string | null; receiptDigest?: string | null; completedAt?: string | null; updatedAt?: string
}
export interface CreateLifeSubscriptionCancellationInput {
  workflowId: string; intentId: string; accountId: string; subscriptionId: string
  providerRequestId: string; reasonCode: string; createdAt?: string
}
export interface TransitionLifeSubscriptionCancellationInput {
  cancellationId: string; expectedVersion: number; state: LifeSubscriptionCancellationState
  providerReceiptId?: string | null; receiptDigest?: string | null; completedAt?: string | null; updatedAt?: string
}
export interface CreateLifeHandoffInput {
  planRevisionId: string; optionId: string; kind: LifeHandoff['kind']; targetCapabilityId: string; createdAt?: string
}

export function lifeCanonicalDigest(value: unknown): string {
  assertLifeSafeData(value)
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function lifeSubscriptionMaterialDigest(value: LifeSubscription): string {
  return lifeCanonicalDigest(subscriptionMaterial(value))
}

export function createLifeSourceAccount(input: CreateLifeSourceAccountInput): LifeSourceAccount {
  validateId(input.id, 'LIFE_ACCOUNT_ID_INVALID')
  if (!isLifeSourceKind(input.sourceKind) || !isLifeExecutionMode(input.mode) || input.mode === 'live'
    || input.executorId !== undefined && input.executorId !== null && !isLifeSemanticId(input.executorId)
    || !cleanText(input.displayName, 160) || input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new LifeContractError('LIFE_ACCOUNT_INPUT_INVALID')
  }
  assertLifeSafeData({ displayName: input.displayName })
  const createdAt = new Date().toISOString()
  return withLifeOrchestrationDb(db => {
    const existing = accountById(db, input.id)
    if (existing) {
      if (existing.sourceKind !== input.sourceKind || existing.mode !== input.mode
        || existing.executorId !== (input.executorId ?? null) || existing.displayName !== input.displayName
        || existing.enabled !== (input.enabled ?? true)) throw new LifeContractError('LIFE_ACCOUNT_REPLAY_MISMATCH')
      return existing
    }
    db.prepare(`INSERT INTO life_accounts(id,source_kind,mode,executor_id,display_name,health,enabled,policy_epoch,
      version,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,'unknown',?,1,1,?,?,NULL)`).run(
      input.id, input.sourceKind, input.mode, input.executorId ?? null, input.displayName,
      (input.enabled ?? true) ? 1 : 0, createdAt, createdAt,
    )
    return required(accountById(db, input.id), 'LIFE_ACCOUNT_CREATE_FAILED')
  })
}

export function getLifeSourceAccount(accountId: string): LifeSourceAccount | null {
  validateId(accountId, 'LIFE_ACCOUNT_ID_INVALID')
  return withLifeOrchestrationDb(db => accountById(db, accountId))
}
export function listLifeSourceAccounts(limit = 100): LifeSourceAccount[] {
  const bounded = listLimit(limit)
  return withLifeOrchestrationDb(db => (db.prepare('SELECT * FROM life_accounts ORDER BY id LIMIT ?')
    .all(bounded) as AccountRow[]).map(accountFromRow))
}
export function updateLifeSourceAccount(input: UpdateLifeSourceAccountInput): LifeSourceAccount {
  validateId(input.accountId, 'LIFE_ACCOUNT_ID_INVALID')
  if (!validVersion(input.expectedVersion) || input.mode !== undefined && !isLifeExecutionMode(input.mode)
    || input.health !== undefined && !isLifeAccountHealth(input.health)
    || input.enabled !== undefined && typeof input.enabled !== 'boolean'
    || input.executorId !== undefined && input.executorId !== null && !isLifeSemanticId(input.executorId)
    || input.activationReviewId !== undefined && !isLifeSemanticId(input.activationReviewId)) {
    throw new LifeContractError('LIFE_ACCOUNT_UPDATE_INVALID')
  }
  const updatedAt = timestamp(input.updatedAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const current = required(accountById(db, input.accountId), 'LIFE_ACCOUNT_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new LifeContractError('LIFE_ACCOUNT_VERSION_CONFLICT')
    if (current.health === 'revoked') throw new LifeContractError('LIFE_ACCOUNT_REVOKED')
    const mode = input.mode ?? current.mode
    const health = input.revoke ? 'revoked' : input.health ?? current.health
    const enabled = input.revoke ? false : input.enabled ?? current.enabled
    const executorId = input.executorId === undefined ? current.executorId : input.executorId
    if (mode === 'live' && current.mode !== 'live') {
      const review = input.activationReviewId ? activationById(db, input.activationReviewId) : null
      if (!review?.approved || review.accountId !== current.id || review.fromMode !== current.mode
        || review.toMode !== 'live') throw new LifeContractError('LIFE_LIVE_ACTIVATION_REQUIRED')
    }
    const authorityChanged = mode !== current.mode || health === 'revoked' || enabled !== current.enabled
      || executorId !== current.executorId
    const result = db.prepare(`UPDATE life_accounts SET mode=?,health=?,enabled=?,executor_id=?,policy_epoch=?,
      version=version+1,updated_at=?,revoked_at=? WHERE id=? AND version=?`).run(
      mode, health, enabled ? 1 : 0, executorId, current.policyEpoch + (authorityChanged ? 1 : 0), updatedAt,
      health === 'revoked' ? updatedAt : current.revokedAt, current.id, current.version,
    )
    if (result.changes !== 1) throw new LifeContractError('LIFE_ACCOUNT_VERSION_CONFLICT')
    return required(accountById(db, current.id), 'LIFE_ACCOUNT_UPDATE_FAILED')
  })
}

export function recordLifeCommitment(input: RecordLifeCommitmentInput): LifeCommitment {
  validateCommitment(input)
  const normalized = { ...input, participantAliasIds: sortedUnique(input.participantAliasIds, 'LIFE_CONTACT_ALIAS_ID_INVALID') }
  const id = `commitment-${stableId({ accountId: input.accountId, providerItemId: input.providerItemId,
    sourceDigest: input.sourceDigest })}`
  return withLifeOrchestrationDb(db => {
    const account = required(accountById(db, input.accountId), 'LIFE_ACCOUNT_NOT_FOUND')
    if (account.sourceKind !== 'calendar' || account.health === 'revoked') {
      throw new LifeContractError('LIFE_COMMITMENT_ACCOUNT_MISMATCH')
    }
    for (const aliasId of normalized.participantAliasIds) {
      if (!contactById(db, aliasId)) throw new LifeContractError('LIFE_CONTACT_ALIAS_NOT_FOUND')
    }
    const existing = commitmentById(db, id)
    if (existing) {
      if (lifeCanonicalDigest(commitmentMaterial(existing)) !== lifeCanonicalDigest(commitmentMaterial(normalized))) {
        throw new LifeContractError('LIFE_COMMITMENT_REPLAY_MISMATCH')
      }
      return existing
    }
    db.prepare(`INSERT INTO life_commitments(id,account_id,provider_item_id,label,category,starts_at,ends_at,
      all_day,busy,location_class,participant_alias_ids_json,observed_at,expires_at,source_digest,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, normalized.accountId, normalized.providerItemId, normalized.label, normalized.category,
      normalized.startsAt, normalized.endsAt, normalized.allDay ? 1 : 0, normalized.busy ? 1 : 0,
      normalized.locationClass, canonicalJson(normalized.participantAliasIds), normalized.observedAt,
      normalized.expiresAt, normalized.sourceDigest, normalized.observedAt,
    )
    return required(commitmentById(db, id), 'LIFE_COMMITMENT_CREATE_FAILED')
  })
}
export function getLifeCommitment(id: string): LifeCommitment | null {
  validateId(id, 'LIFE_COMMITMENT_ID_INVALID'); return withLifeOrchestrationDb(db => commitmentById(db, id))
}
export function listLifeCommitments(options: { accountId?: string; startsBefore?: string; endsAfter?: string;
  limit?: number } = {}): LifeCommitment[] {
  if (options.accountId !== undefined) validateId(options.accountId, 'LIFE_ACCOUNT_ID_INVALID')
  if (options.startsBefore !== undefined) timestamp(options.startsBefore, 'LIFE_TIME_INVALID')
  if (options.endsAfter !== undefined) timestamp(options.endsAfter, 'LIFE_TIME_INVALID')
  const limit = listLimit(options.limit ?? 100)
  return withLifeOrchestrationDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.accountId) { clauses.push('account_id=?'); values.push(options.accountId) }
    if (options.startsBefore) { clauses.push('starts_at<?'); values.push(options.startsBefore) }
    if (options.endsAfter) { clauses.push('ends_at>?'); values.push(options.endsAfter) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`SELECT * FROM life_commitments ${where} ORDER BY starts_at,id LIMIT ?`)
      .all(...values, limit) as CommitmentRow[]).map(commitmentFromRow)
  })
}

export function recordLifeContactAlias(input: RecordLifeContactAliasInput): LifeContactAlias {
  validateId(input.accountId, 'LIFE_ACCOUNT_ID_INVALID'); validateId(input.providerContactId, 'LIFE_PROVIDER_ITEM_ID_INVALID')
  if (!cleanText(input.alias, 160) || !isLifeDigest(input.sourceDigest)) throw new LifeContractError('LIFE_CONTACT_INPUT_INVALID')
  const observedAt = timestamp(input.observedAt, 'LIFE_TIME_INVALID')
  const normalized = { ...input, observedAt,
    relationshipTags: sortedTags(input.relationshipTags), availabilityTags: sortedTags(input.availabilityTags) }
  assertLifeSafeData({ alias: normalized.alias, relationshipTags: normalized.relationshipTags,
    availabilityTags: normalized.availabilityTags })
  const id = `contact-${stableId({ accountId: input.accountId, providerContactId: input.providerContactId,
    sourceDigest: input.sourceDigest })}`
  return withLifeOrchestrationDb(db => {
    const account = required(accountById(db, input.accountId), 'LIFE_ACCOUNT_NOT_FOUND')
    if (account.sourceKind !== 'contacts' || account.health === 'revoked') throw new LifeContractError('LIFE_CONTACT_ACCOUNT_MISMATCH')
    const existing = contactById(db, id)
    if (existing) {
      if (lifeCanonicalDigest(contactMaterial(existing)) !== lifeCanonicalDigest(contactMaterial(normalized))) {
        throw new LifeContractError('LIFE_CONTACT_REPLAY_MISMATCH')
      }
      return existing
    }
    db.prepare(`INSERT INTO life_contact_aliases(id,account_id,provider_contact_id,alias,relationship_tags_json,
      availability_tags_json,observed_at,source_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, normalized.accountId, normalized.providerContactId, normalized.alias,
      canonicalJson(normalized.relationshipTags), canonicalJson(normalized.availabilityTags), normalized.observedAt,
      normalized.sourceDigest, normalized.observedAt,
    )
    return required(contactById(db, id), 'LIFE_CONTACT_CREATE_FAILED')
  })
}
export function getLifeContactAlias(id: string): LifeContactAlias | null {
  validateId(id, 'LIFE_CONTACT_ALIAS_ID_INVALID'); return withLifeOrchestrationDb(db => contactById(db, id))
}
export function listLifeContactAliases(accountId?: string, limit = 100): LifeContactAlias[] {
  if (accountId !== undefined) validateId(accountId, 'LIFE_ACCOUNT_ID_INVALID')
  const bounded = listLimit(limit)
  return withLifeOrchestrationDb(db => (db.prepare(accountId
    ? 'SELECT * FROM life_contact_aliases WHERE account_id=? ORDER BY observed_at DESC,id LIMIT ?'
    : 'SELECT * FROM life_contact_aliases ORDER BY observed_at DESC,id LIMIT ?')
    .all(...(accountId ? [accountId, bounded] : [bounded])) as ContactRow[]).map(contactFromRow))
}

export function recordLifeOption(input: RecordLifeOptionInput): LifeOption {
  validateOption(input)
  const normalized = { ...input, categoryTags: sortedTags(input.categoryTags) }
  const id = `option-${stableId({ source: input.source, providerItemId: input.providerItemId,
    sourceDigest: input.sourceDigest })}`
  return withLifeOrchestrationDb(db => {
    if (input.accountId !== null) {
      const account = required(accountById(db, input.accountId), 'LIFE_ACCOUNT_NOT_FOUND')
      const allowed = input.kind === 'travel' ? account.sourceKind === 'travel'
        : input.kind === 'music' ? account.sourceKind === 'music'
          : input.kind === 'game' ? account.sourceKind === 'games' : false
      if (!allowed || account.health === 'revoked') throw new LifeContractError('LIFE_OPTION_ACCOUNT_MISMATCH')
    } else if (input.kind !== 'video' || input.source !== 'bilibili') {
      throw new LifeContractError('LIFE_OPTION_ACCOUNT_MISMATCH')
    }
    const existing = optionById(db, id)
    if (existing) {
      if (lifeCanonicalDigest(optionMaterial(existing)) !== lifeCanonicalDigest(optionMaterial(normalized))) {
        throw new LifeContractError('LIFE_OPTION_REPLAY_MISMATCH')
      }
      return existing
    }
    db.prepare(`INSERT INTO life_options(id,account_id,kind,source,provider_item_id,title,category_tags_json,
      duration_minutes,exertion,screen_based,location_class,cost_currency,cost_minor,available,observed_at,
      expires_at,source_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, normalized.accountId, normalized.kind, normalized.source, normalized.providerItemId, normalized.title,
      canonicalJson(normalized.categoryTags), normalized.durationMinutes, normalized.exertion,
      normalized.screenBased ? 1 : 0, normalized.locationClass, normalized.cost?.currency ?? null,
      normalized.cost?.amountMinor ?? null, normalized.available ? 1 : 0, normalized.observedAt,
      normalized.expiresAt, normalized.sourceDigest, normalized.observedAt,
    )
    return required(optionById(db, id), 'LIFE_OPTION_CREATE_FAILED')
  })
}
export function getLifeOption(id: string): LifeOption | null {
  validateId(id, 'LIFE_OPTION_ID_INVALID'); return withLifeOrchestrationDb(db => optionById(db, id))
}
export function listLifeOptions(options: { kind?: LifeOption['kind']; activeAt?: string; limit?: number } = {}): LifeOption[] {
  if (options.kind !== undefined && !isLifeOptionKind(options.kind)) throw new LifeContractError('LIFE_OPTION_KIND_INVALID')
  if (options.activeAt !== undefined) timestamp(options.activeAt, 'LIFE_TIME_INVALID')
  const limit = listLimit(options.limit ?? 100)
  return withLifeOrchestrationDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.kind) { clauses.push('kind=?'); values.push(options.kind) }
    if (options.activeAt) { clauses.push('available=1 AND expires_at>?'); values.push(options.activeAt) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`SELECT * FROM life_options ${where} ORDER BY observed_at DESC,id LIMIT ?`)
      .all(...values, limit) as OptionRow[]).map(optionFromRow)
  })
}

export function recordLifeSubscription(input: RecordLifeSubscriptionInput): LifeSubscription {
  validateSubscription(input)
  return withLifeOrchestrationDb(db => {
    const account = required(accountById(db, input.accountId), 'LIFE_ACCOUNT_NOT_FOUND')
    if (account.sourceKind !== 'subscriptions' || account.health === 'revoked') {
      throw new LifeContractError('LIFE_SUBSCRIPTION_ACCOUNT_MISMATCH')
    }
    const existing = subscriptionByProvider(db, input.accountId, input.providerSubscriptionId)
    if (existing?.sourceDigest === input.sourceDigest) {
      if (lifeCanonicalDigest(subscriptionMaterial(existing)) !== lifeCanonicalDigest(subscriptionMaterial(input))) {
        throw new LifeContractError('LIFE_SUBSCRIPTION_REPLAY_MISMATCH')
      }
      return existing
    }
    if (!existing) {
      const id = `subscription-${stableId({ accountId: input.accountId,
        providerSubscriptionId: input.providerSubscriptionId })}`
      db.prepare(`INSERT INTO life_subscriptions(id,account_id,provider_subscription_id,service_label,plan_label,
        currency,recurring_cost_minor,renewal_at,cancellation_deadline,state,observed_at,source_digest,version,
        created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
        id, input.accountId, input.providerSubscriptionId, input.serviceLabel, input.planLabel,
        input.recurringCost.currency, input.recurringCost.amountMinor, input.renewalAt, input.cancellationDeadline,
        input.state, input.observedAt, input.sourceDigest, input.observedAt, input.observedAt,
      )
      return required(subscriptionById(db, id), 'LIFE_SUBSCRIPTION_CREATE_FAILED')
    }
    const result = db.prepare(`UPDATE life_subscriptions SET service_label=?,plan_label=?,currency=?,
      recurring_cost_minor=?,renewal_at=?,cancellation_deadline=?,state=?,observed_at=?,source_digest=?,
      version=version+1,updated_at=? WHERE id=? AND version=?`).run(
      input.serviceLabel, input.planLabel, input.recurringCost.currency, input.recurringCost.amountMinor,
      input.renewalAt, input.cancellationDeadline, input.state, input.observedAt, input.sourceDigest,
      input.observedAt, existing.id, existing.version,
    )
    if (result.changes !== 1) throw new LifeContractError('LIFE_SUBSCRIPTION_VERSION_CONFLICT')
    return required(subscriptionById(db, existing.id), 'LIFE_SUBSCRIPTION_UPDATE_FAILED')
  })
}
export function getLifeSubscription(id: string): LifeSubscription | null {
  validateId(id, 'LIFE_SUBSCRIPTION_ID_INVALID'); return withLifeOrchestrationDb(db => subscriptionById(db, id))
}
export function listLifeSubscriptions(options: { accountId?: string; state?: LifeSubscription['state']; limit?: number } = {}): LifeSubscription[] {
  if (options.accountId !== undefined) validateId(options.accountId, 'LIFE_ACCOUNT_ID_INVALID')
  if (options.state !== undefined && !isLifeSubscriptionState(options.state)) throw new LifeContractError('LIFE_SUBSCRIPTION_STATE_INVALID')
  const limit = listLimit(options.limit ?? 100)
  return withLifeOrchestrationDb(db => {
    const clauses: string[] = []; const values: Array<string | number> = []
    if (options.accountId) { clauses.push('account_id=?'); values.push(options.accountId) }
    if (options.state) { clauses.push('state=?'); values.push(options.state) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`SELECT * FROM life_subscriptions ${where} ORDER BY renewal_at,id LIMIT ?`)
      .all(...values, limit) as SubscriptionRow[]).map(subscriptionFromRow)
  })
}

export function createLifeConstraintSnapshot(input: CreateLifeConstraintSnapshotInput): LifeConstraintSnapshot {
  const normalized = normalizeConstraint(input)
  const materialDigest = lifeCanonicalDigest(constraintMaterial(normalized))
  const id = `constraint-${materialDigest.slice(0, 32)}`
  return withLifeOrchestrationDb(db => {
    const existing = constraintByDigest(db, materialDigest)
    if (existing) return existing
    for (const commitmentId of normalized.commitmentIds) {
      if (!commitmentById(db, commitmentId)) throw new LifeContractError('LIFE_COMMITMENT_NOT_FOUND')
    }
    db.prepare(`INSERT INTO life_constraint_snapshots(id,subject_id,horizon_start,horizon_end,timezone,
      free_windows_json,commitment_ids_json,readiness,recovery,sleep_debt,screen_time_used_minutes,
      screen_time_limit_minutes,leisure_time_limit_minutes,budget_currency,budget_minor,quiet_start_minute,
      quiet_end_minute,max_travel_radius_km,excluded_categories_json,preferred_categories_json,fact_refs_json,
      material_digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, normalized.subjectId, normalized.horizon.startsAt, normalized.horizon.endsAt, normalized.timezone,
      canonicalJson(normalized.freeWindows), canonicalJson(normalized.commitmentIds), normalized.readiness,
      normalized.recovery, normalized.sleepDebt, normalized.screenTimeUsedMinutes,
      normalized.screenTimeLimitMinutes, normalized.leisureTimeLimitMinutes, normalized.budget.currency,
      normalized.budget.amountMinor, normalized.quietStartMinute, normalized.quietEndMinute,
      normalized.maxTravelRadiusKm, canonicalJson(normalized.excludedCategories),
      canonicalJson(normalized.preferredCategories), canonicalJson(normalized.factRefs), materialDigest,
      normalized.createdAt, normalized.expiresAt,
    )
    return required(constraintById(db, id), 'LIFE_CONSTRAINT_CREATE_FAILED')
  })
}
export function getLifeConstraintSnapshot(id: string): LifeConstraintSnapshot | null {
  validateId(id, 'LIFE_CONSTRAINT_ID_INVALID'); return withLifeOrchestrationDb(db => constraintById(db, id))
}
export function listLifeConstraintSnapshots(limit = 100): LifeConstraintSnapshot[] {
  const bounded = listLimit(limit)
  return withLifeOrchestrationDb(db => (db.prepare(`SELECT * FROM life_constraint_snapshots
    ORDER BY created_at DESC,id DESC LIMIT ?`).all(bounded) as ConstraintRow[]).map(constraintFromRow))
}

export function createLifePlanRevision(input: CreateLifePlanRevisionInput): LifePlanRevision {
  validateId(input.constraintSnapshotId, 'LIFE_CONSTRAINT_ID_INVALID')
  const createdAt = timestamp(input.createdAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const constraint = required(constraintById(db, input.constraintSnapshotId), 'LIFE_CONSTRAINT_NOT_FOUND')
    if (Date.parse(constraint.expiresAt) <= Date.parse(createdAt)) throw new LifeContractError('LIFE_CONSTRAINT_EXPIRED')
    const candidates = normalizeCandidates(input.candidates)
    const sessions = normalizeSessions(input.sessions)
    validatePlanMaterial(db, constraint, candidates, sessions)
    const totalMinutes = sessions.reduce((sum, session) => sum
      + (Date.parse(session.endsAt) - Date.parse(session.startsAt)) / 60_000, 0)
    const totalCostMinor = sessions.reduce((sum, session) => sum + (session.cost?.amountMinor ?? 0), 0)
    if (!Number.isSafeInteger(totalMinutes) || !Number.isSafeInteger(totalCostMinor)) {
      throw new LifeContractError('LIFE_PLAN_TOTAL_INVALID')
    }
    const material = { candidates, constraintDigest: constraint.materialDigest,
      constraintSnapshotId: constraint.id, sessions, totalCost: { currency: constraint.budget.currency,
        amountMinor: totalCostMinor }, totalMinutes }
    const planDigest = lifeCanonicalDigest(material)
    const existing = planByDigest(db, planDigest)
    if (existing) return existing
    const id = `plan-${planDigest.slice(0, 32)}`
    db.prepare(`INSERT INTO life_plan_revisions(id,constraint_snapshot_id,constraint_digest,candidates_json,
      sessions_json,total_minutes,total_currency,total_cost_minor,plan_digest,state,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'proposed',1,?,?)`).run(
      id, constraint.id, constraint.materialDigest, canonicalJson(candidates), canonicalJson(sessions), totalMinutes,
      constraint.budget.currency, totalCostMinor, planDigest, createdAt, createdAt,
    )
    return required(planById(db, id), 'LIFE_PLAN_CREATE_FAILED')
  })
}
export function getLifePlanRevision(id: string): LifePlanRevision | null {
  validateId(id, 'LIFE_PLAN_ID_INVALID'); return withLifeOrchestrationDb(db => planById(db, id))
}
export function listLifePlanRevisions(options: { state?: LifePlanState; limit?: number } = {}): LifePlanRevision[] {
  if (options.state !== undefined && !isLifePlanState(options.state)) throw new LifeContractError('LIFE_PLAN_STATE_INVALID')
  const limit = listLimit(options.limit ?? 100)
  return withLifeOrchestrationDb(db => (db.prepare(options.state
    ? 'SELECT * FROM life_plan_revisions WHERE state=? ORDER BY created_at DESC,id DESC LIMIT ?'
    : 'SELECT * FROM life_plan_revisions ORDER BY created_at DESC,id DESC LIMIT ?')
    .all(...(options.state ? [options.state, limit] : [limit])) as PlanRow[]).map(planFromRow))
}
export function transitionLifePlanRevision(input: TransitionLifePlanInput): LifePlanRevision {
  validateId(input.planId, 'LIFE_PLAN_ID_INVALID')
  if (!validVersion(input.expectedVersion) || !isLifePlanState(input.state)) {
    throw new LifeContractError('LIFE_PLAN_TRANSITION_INVALID')
  }
  const updatedAt = timestamp(input.updatedAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const current = required(planById(db, input.planId), 'LIFE_PLAN_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new LifeContractError('LIFE_PLAN_VERSION_CONFLICT')
    if (!isLegalLifePlanTransition(current.state, input.state)) throw new LifeContractError('LIFE_PLAN_TRANSITION_INVALID')
    const result = db.prepare(`UPDATE life_plan_revisions SET state=?,version=version+1,updated_at=?
      WHERE id=? AND version=?`).run(input.state, updatedAt, current.id, current.version)
    if (result.changes !== 1) throw new LifeContractError('LIFE_PLAN_VERSION_CONFLICT')
    return required(planById(db, current.id), 'LIFE_PLAN_UPDATE_FAILED')
  })
}

export function createLifeCalendarHold(input: CreateLifeCalendarHoldInput): LifeCalendarHold {
  validateWorkflow(input.workflowId, input.intentId); validateId(input.accountId, 'LIFE_ACCOUNT_ID_INVALID')
  validateId(input.planRevisionId, 'LIFE_PLAN_ID_INVALID'); validateId(input.optionId, 'LIFE_OPTION_ID_INVALID')
  if (!TOKEN.test(input.providerRequestId)) throw new LifeContractError('LIFE_PROVIDER_REQUEST_ID_INVALID')
  const window = parseLifeTimeWindow(input.window)
  const createdAt = timestamp(input.createdAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const account = required(accountById(db, input.accountId), 'LIFE_ACCOUNT_NOT_FOUND')
    const plan = required(planById(db, input.planRevisionId), 'LIFE_PLAN_NOT_FOUND')
    const session = plan.sessions.find(item => item.optionId === input.optionId
      && item.startsAt === window.startsAt && item.endsAt === window.endsAt)
    const replay = holdByWorkflow(db, input.workflowId)
    if (replay) {
      if (replay.accountId !== account.id || replay.planRevisionId !== plan.id || replay.optionId !== input.optionId
        || replay.providerRequestId !== input.providerRequestId || replay.window.startsAt !== window.startsAt
        || replay.window.endsAt !== window.endsAt) throw new LifeContractError('LIFE_CALENDAR_HOLD_REPLAY_MISMATCH')
      return replay
    }
    const requestOwner = holdByProviderRequest(db, account.id, input.providerRequestId)
    if (requestOwner) throw new LifeContractError('LIFE_PROVIDER_REQUEST_OWNED_BY_OTHER_WORKFLOW')
    if (account.sourceKind !== 'calendar' || account.mode === 'observe' || account.health === 'revoked'
      || plan.state !== 'proposed' || !session) throw new LifeContractError('LIFE_CALENDAR_HOLD_MATERIAL_MISMATCH')
    const id = `hold-${stableId({ providerRequestId: input.providerRequestId, workflowId: input.workflowId })}`
    db.prepare(`INSERT INTO life_calendar_holds(id,workflow_id,intent_id,account_id,plan_revision_id,plan_digest,
      option_id,starts_at,ends_at,provider_request_id,provider_hold_id,receipt_digest,state,policy_epoch,version,
      created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,'requested',?,1,?,?,NULL)`).run(
      id, input.workflowId, input.intentId, account.id, plan.id, plan.planDigest, input.optionId,
      window.startsAt, window.endsAt, input.providerRequestId, account.policyEpoch, createdAt, createdAt,
    )
    return required(holdById(db, id), 'LIFE_CALENDAR_HOLD_CREATE_FAILED')
  })
}
export function getLifeCalendarHold(id: string): LifeCalendarHold | null {
  validateId(id, 'LIFE_CALENDAR_HOLD_ID_INVALID'); return withLifeOrchestrationDb(db => holdById(db, id))
}
export function getLifeCalendarHoldByWorkflow(workflowId: string): LifeCalendarHold | null {
  if (!WORKFLOW_ID.test(workflowId)) throw new LifeContractError('LIFE_WORKFLOW_ID_INVALID')
  return withLifeOrchestrationDb(db => holdByWorkflow(db, workflowId))
}
export function getLifeCalendarHoldByProviderRequest(accountId: string,
  providerRequestId: string): LifeCalendarHold | null {
  validateId(accountId, 'LIFE_ACCOUNT_ID_INVALID')
  if (!TOKEN.test(providerRequestId)) throw new LifeContractError('LIFE_PROVIDER_REQUEST_ID_INVALID')
  return withLifeOrchestrationDb(db => holdByProviderRequest(db, accountId, providerRequestId))
}
export function transitionLifeCalendarHold(input: TransitionLifeCalendarHoldInput): LifeCalendarHold {
  validateId(input.holdId, 'LIFE_CALENDAR_HOLD_ID_INVALID')
  if (!validVersion(input.expectedVersion) || !isLifeCalendarHoldState(input.state)) {
    throw new LifeContractError('LIFE_CALENDAR_HOLD_TRANSITION_INVALID')
  }
  validateOptionalId(input.providerHoldId, 'LIFE_PROVIDER_HOLD_ID_INVALID')
  validateOptionalDigest(input.receiptDigest)
  const updatedAt = timestamp(input.updatedAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  const completedAt = input.completedAt === undefined || input.completedAt === null ? input.completedAt
    : timestamp(input.completedAt, 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const current = required(holdById(db, input.holdId), 'LIFE_CALENDAR_HOLD_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new LifeContractError('LIFE_CALENDAR_HOLD_VERSION_CONFLICT')
    if (!isLegalLifeHoldTransition(current.state, input.state)) {
      throw new LifeContractError('LIFE_CALENDAR_HOLD_TRANSITION_INVALID')
    }
    const providerHoldId = input.providerHoldId === undefined ? current.providerHoldId : input.providerHoldId
    const receiptDigest = input.receiptDigest === undefined ? current.receiptDigest : input.receiptDigest
    if (current.providerHoldId && providerHoldId !== current.providerHoldId) {
      throw new LifeContractError('LIFE_PROVIDER_HOLD_ID_SUBSTITUTION')
    }
    if (current.receiptDigest && receiptDigest !== current.receiptDigest) {
      throw new LifeContractError('LIFE_RECEIPT_SUBSTITUTION')
    }
    const result = db.prepare(`UPDATE life_calendar_holds SET state=?,provider_hold_id=?,receipt_digest=?,
      version=version+1,updated_at=?,completed_at=? WHERE id=? AND version=?`).run(
      input.state, providerHoldId, receiptDigest, updatedAt,
      completedAt === undefined ? current.completedAt : completedAt, current.id, current.version,
    )
    if (result.changes !== 1) throw new LifeContractError('LIFE_CALENDAR_HOLD_VERSION_CONFLICT')
    return required(holdById(db, current.id), 'LIFE_CALENDAR_HOLD_UPDATE_FAILED')
  })
}

export function createLifeSubscriptionCancellation(
  input: CreateLifeSubscriptionCancellationInput,
): LifeSubscriptionCancellation {
  validateWorkflow(input.workflowId, input.intentId); validateId(input.accountId, 'LIFE_ACCOUNT_ID_INVALID')
  validateId(input.subscriptionId, 'LIFE_SUBSCRIPTION_ID_INVALID')
  if (!TOKEN.test(input.providerRequestId) || !isLifeErrorCode(input.reasonCode)) {
    throw new LifeContractError('LIFE_SUBSCRIPTION_CANCELLATION_INPUT_INVALID')
  }
  const createdAt = timestamp(input.createdAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const account = required(accountById(db, input.accountId), 'LIFE_ACCOUNT_NOT_FOUND')
    const subscription = required(subscriptionById(db, input.subscriptionId), 'LIFE_SUBSCRIPTION_NOT_FOUND')
    const replay = cancellationByWorkflow(db, input.workflowId)
    if (replay) {
      if (replay.accountId !== account.id || replay.subscriptionId !== subscription.id
        || replay.providerRequestId !== input.providerRequestId || replay.reasonCode !== input.reasonCode) {
        throw new LifeContractError('LIFE_SUBSCRIPTION_CANCELLATION_REPLAY_MISMATCH')
      }
      return replay
    }
    const requestOwner = cancellationByProviderRequest(db, account.id, input.providerRequestId)
    if (requestOwner) throw new LifeContractError('LIFE_PROVIDER_REQUEST_OWNED_BY_OTHER_WORKFLOW')
    if (account.sourceKind !== 'subscriptions' || account.mode === 'observe' || account.health === 'revoked'
      || subscription.accountId !== account.id || !['active', 'trial', 'paused', 'cancel_pending'].includes(subscription.state)) {
      throw new LifeContractError('LIFE_SUBSCRIPTION_CANCELLATION_NOT_ELIGIBLE')
    }
    const subscriptionDigest = lifeCanonicalDigest(subscriptionMaterial(subscription))
    const id = `cancellation-${stableId({ providerRequestId: input.providerRequestId,
      workflowId: input.workflowId })}`
    db.prepare(`INSERT INTO life_subscription_cancellations(id,workflow_id,intent_id,account_id,subscription_id,
      subscription_digest,provider_request_id,reason_code,provider_receipt_id,receipt_digest,state,policy_epoch,
      version,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,'requested',?,1,?,?,NULL)`).run(
      id, input.workflowId, input.intentId, account.id, subscription.id, subscriptionDigest,
      input.providerRequestId, input.reasonCode, account.policyEpoch, createdAt, createdAt,
    )
    return required(cancellationById(db, id), 'LIFE_SUBSCRIPTION_CANCELLATION_CREATE_FAILED')
  })
}
export function getLifeSubscriptionCancellation(id: string): LifeSubscriptionCancellation | null {
  validateId(id, 'LIFE_SUBSCRIPTION_CANCELLATION_ID_INVALID')
  return withLifeOrchestrationDb(db => cancellationById(db, id))
}
export function getLifeSubscriptionCancellationByWorkflow(workflowId: string): LifeSubscriptionCancellation | null {
  if (!WORKFLOW_ID.test(workflowId)) throw new LifeContractError('LIFE_WORKFLOW_ID_INVALID')
  return withLifeOrchestrationDb(db => cancellationByWorkflow(db, workflowId))
}
export function getLifeSubscriptionCancellationByProviderRequest(accountId: string,
  providerRequestId: string): LifeSubscriptionCancellation | null {
  validateId(accountId, 'LIFE_ACCOUNT_ID_INVALID')
  if (!TOKEN.test(providerRequestId)) throw new LifeContractError('LIFE_PROVIDER_REQUEST_ID_INVALID')
  return withLifeOrchestrationDb(db => cancellationByProviderRequest(db, accountId, providerRequestId))
}
export function transitionLifeSubscriptionCancellation(
  input: TransitionLifeSubscriptionCancellationInput,
): LifeSubscriptionCancellation {
  validateId(input.cancellationId, 'LIFE_SUBSCRIPTION_CANCELLATION_ID_INVALID')
  if (!validVersion(input.expectedVersion) || !isLifeSubscriptionCancellationState(input.state)) {
    throw new LifeContractError('LIFE_SUBSCRIPTION_CANCELLATION_TRANSITION_INVALID')
  }
  validateOptionalId(input.providerReceiptId, 'LIFE_PROVIDER_RECEIPT_ID_INVALID')
  validateOptionalDigest(input.receiptDigest)
  const updatedAt = timestamp(input.updatedAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  const completedAt = input.completedAt === undefined || input.completedAt === null ? input.completedAt
    : timestamp(input.completedAt, 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const current = required(cancellationById(db, input.cancellationId), 'LIFE_SUBSCRIPTION_CANCELLATION_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new LifeContractError('LIFE_CANCELLATION_VERSION_CONFLICT')
    if (!isLegalLifeCancellationTransition(current.state, input.state)) {
      throw new LifeContractError('LIFE_SUBSCRIPTION_CANCELLATION_TRANSITION_INVALID')
    }
    const receiptId = input.providerReceiptId === undefined ? current.providerReceiptId : input.providerReceiptId
    const receiptDigest = input.receiptDigest === undefined ? current.receiptDigest : input.receiptDigest
    if (current.providerReceiptId && receiptId !== current.providerReceiptId || current.receiptDigest
      && receiptDigest !== current.receiptDigest) throw new LifeContractError('LIFE_RECEIPT_SUBSTITUTION')
    const result = db.prepare(`UPDATE life_subscription_cancellations SET state=?,provider_receipt_id=?,
      receipt_digest=?,version=version+1,updated_at=?,completed_at=? WHERE id=? AND version=?`).run(
      input.state, receiptId, receiptDigest, updatedAt,
      completedAt === undefined ? current.completedAt : completedAt, current.id, current.version,
    )
    if (result.changes !== 1) throw new LifeContractError('LIFE_CANCELLATION_VERSION_CONFLICT')
    return required(cancellationById(db, current.id), 'LIFE_SUBSCRIPTION_CANCELLATION_UPDATE_FAILED')
  })
}

export function createLifeHandoff(input: CreateLifeHandoffInput): LifeHandoff {
  validateId(input.planRevisionId, 'LIFE_PLAN_ID_INVALID'); validateId(input.optionId, 'LIFE_OPTION_ID_INVALID')
  validateId(input.targetCapabilityId, 'LIFE_TARGET_CAPABILITY_INVALID')
  if (!isLifeHandoffKind(input.kind)) throw new LifeContractError('LIFE_HANDOFF_KIND_INVALID')
  const createdAt = timestamp(input.createdAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const plan = required(planById(db, input.planRevisionId), 'LIFE_PLAN_NOT_FOUND')
    if (!plan.sessions.some(item => item.optionId === input.optionId) || !optionById(db, input.optionId)) {
      throw new LifeContractError('LIFE_HANDOFF_MATERIAL_MISMATCH')
    }
    const expectedCapability = input.kind === 'commerce' ? 'commerce.product.search'
      : input.kind === 'internet' ? 'bilibili.video.search' : 'android.app.launch'
    if (input.targetCapabilityId !== expectedCapability) throw new LifeContractError('LIFE_HANDOFF_TARGET_INVALID')
    const materialDigest = lifeCanonicalDigest({ kind: input.kind, optionId: input.optionId,
      planDigest: plan.planDigest, targetCapabilityId: input.targetCapabilityId })
    const id = `handoff-${stableId({ kind: input.kind, optionId: input.optionId, planRevisionId: plan.id })}`
    const existing = handoffById(db, id)
    if (existing) return existing
    db.prepare(`INSERT INTO life_handoffs(id,plan_revision_id,option_id,kind,target_capability_id,
      material_digest,state,version,created_at,updated_at) VALUES(?,?,?,?,?,?,'proposed',1,?,?)`).run(
      id, plan.id, input.optionId, input.kind, input.targetCapabilityId, materialDigest, createdAt, createdAt,
    )
    return required(handoffById(db, id), 'LIFE_HANDOFF_CREATE_FAILED')
  })
}
export function transitionLifeHandoff(input: { handoffId: string; expectedVersion: number;
  state: LifeHandoffState; updatedAt?: string }): LifeHandoff {
  validateId(input.handoffId, 'LIFE_HANDOFF_ID_INVALID')
  if (!validVersion(input.expectedVersion) || !isLifeHandoffState(input.state)) {
    throw new LifeContractError('LIFE_HANDOFF_TRANSITION_INVALID')
  }
  const updatedAt = timestamp(input.updatedAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  return withLifeOrchestrationDb(db => {
    const current = required(handoffById(db, input.handoffId), 'LIFE_HANDOFF_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new LifeContractError('LIFE_HANDOFF_VERSION_CONFLICT')
    if (!isLegalLifeHandoffTransition(current.state, input.state)) throw new LifeContractError('LIFE_HANDOFF_TRANSITION_INVALID')
    const result = db.prepare(`UPDATE life_handoffs SET state=?,version=version+1,updated_at=?
      WHERE id=? AND version=?`).run(input.state, updatedAt, current.id, current.version)
    if (result.changes !== 1) throw new LifeContractError('LIFE_HANDOFF_VERSION_CONFLICT')
    return required(handoffById(db, current.id), 'LIFE_HANDOFF_UPDATE_FAILED')
  })
}
export function listLifeHandoffs(planRevisionId?: string, limit = 100): LifeHandoff[] {
  if (planRevisionId !== undefined) validateId(planRevisionId, 'LIFE_PLAN_ID_INVALID')
  const bounded = listLimit(limit)
  return withLifeOrchestrationDb(db => (db.prepare(planRevisionId
    ? 'SELECT * FROM life_handoffs WHERE plan_revision_id=? ORDER BY created_at,id LIMIT ?'
    : 'SELECT * FROM life_handoffs ORDER BY created_at,id LIMIT ?')
    .all(...(planRevisionId ? [planRevisionId, bounded] : [bounded])) as HandoffRow[]).map(handoffFromRow))
}

export function appendLifeCheckpoint(input: {
  aggregateKind: 'calendar_hold' | 'subscription_cancellation'; aggregateId: string; stage: string
  evidenceDigest?: string | null; errorCode?: string | null; details?: Record<string, unknown>; observedAt?: string
}): LifeCheckpoint {
  validateId(input.aggregateId, 'LIFE_AGGREGATE_ID_INVALID')
  if (!STAGE.test(input.stage)) throw new LifeContractError('LIFE_CHECKPOINT_STAGE_INVALID')
  validateOptionalDigest(input.evidenceDigest)
  if (input.errorCode !== undefined && input.errorCode !== null && !isLifeErrorCode(input.errorCode)) {
    throw new LifeContractError('LIFE_ERROR_CODE_INVALID')
  }
  const details = input.details ?? {}; assertLifeSafeData(details)
  const observedAt = timestamp(input.observedAt ?? new Date().toISOString(), 'LIFE_TIME_INVALID')
  const detailsJson = canonicalJson(details)
  return withLifeOrchestrationDb(db => {
    const aggregate = input.aggregateKind === 'calendar_hold' ? holdById(db, input.aggregateId)
      : cancellationById(db, input.aggregateId)
    if (!aggregate) throw new LifeContractError('LIFE_AGGREGATE_NOT_FOUND')
    const duplicate = db.prepare(`SELECT * FROM life_checkpoints WHERE aggregate_kind=? AND aggregate_id=?
      AND stage=? AND evidence_digest IS ? AND error_code IS ? AND details_json=? ORDER BY ordinal DESC LIMIT 1`).get(
      input.aggregateKind, input.aggregateId, input.stage, input.evidenceDigest ?? null,
      input.errorCode ?? null, detailsJson,
    ) as CheckpointRow | undefined
    if (duplicate) return checkpointFromRow(duplicate)
    const ordinal = Number((db.prepare(`SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM life_checkpoints
      WHERE aggregate_kind=? AND aggregate_id=?`).get(input.aggregateKind, input.aggregateId) as { ordinal: number }).ordinal)
    db.prepare(`INSERT INTO life_checkpoints(aggregate_kind,aggregate_id,ordinal,stage,evidence_digest,error_code,
      details_json,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      input.aggregateKind, input.aggregateId, ordinal, input.stage, input.evidenceDigest ?? null,
      input.errorCode ?? null, detailsJson, observedAt, observedAt,
    )
    return checkpointFromRow(required(db.prepare(`SELECT * FROM life_checkpoints WHERE aggregate_kind=?
      AND aggregate_id=? AND ordinal=?`).get(input.aggregateKind, input.aggregateId, ordinal) as
      CheckpointRow | undefined, 'LIFE_CHECKPOINT_CREATE_FAILED'))
  })
}
export function listLifeCheckpoints(aggregateKind: 'calendar_hold' | 'subscription_cancellation',
  aggregateId: string, limit = 100): LifeCheckpoint[] {
  validateId(aggregateId, 'LIFE_AGGREGATE_ID_INVALID'); const bounded = listLimit(limit)
  return withLifeOrchestrationDb(db => (db.prepare(`SELECT * FROM life_checkpoints WHERE aggregate_kind=?
    AND aggregate_id=? ORDER BY ordinal LIMIT ?`).all(aggregateKind, aggregateId, bounded) as CheckpointRow[])
    .map(checkpointFromRow))
}

function validateCommitment(input: RecordLifeCommitmentInput): void {
  validateId(input.accountId, 'LIFE_ACCOUNT_ID_INVALID'); validateId(input.providerItemId, 'LIFE_PROVIDER_ITEM_ID_INVALID')
  if (!cleanText(input.label, 300) || !['work', 'personal', 'health', 'travel', 'leisure', 'other'].includes(input.category)
    || typeof input.allDay !== 'boolean' || typeof input.busy !== 'boolean'
    || !['remote', 'home', 'local', 'out_of_area', 'unknown'].includes(input.locationClass)
    || !isLifeDigest(input.sourceDigest)) throw new LifeContractError('LIFE_COMMITMENT_INPUT_INVALID')
  parseLifeTimeWindow({ startsAt: input.startsAt, endsAt: input.endsAt })
  const observed = timestamp(input.observedAt, 'LIFE_TIME_INVALID')
  const expires = timestamp(input.expiresAt, 'LIFE_TIME_INVALID')
  if (Date.parse(expires) <= Date.parse(observed)) throw new LifeContractError('LIFE_COMMITMENT_TIME_INVALID')
  assertLifeSafeData({ label: input.label })
}
function validateOption(input: RecordLifeOptionInput): void {
  if (input.accountId !== null) validateId(input.accountId, 'LIFE_ACCOUNT_ID_INVALID')
  validateId(input.providerItemId, 'LIFE_PROVIDER_ITEM_ID_INVALID')
  if (!isLifeOptionKind(input.kind) || !cleanText(input.source, 80) || !cleanText(input.title, 500)
    || !Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 10_080
    || !['low', 'medium', 'high'].includes(input.exertion) || typeof input.screenBased !== 'boolean'
    || !['remote', 'home', 'local', 'out_of_area', 'unknown'].includes(input.locationClass)
    || typeof input.available !== 'boolean' || !isLifeDigest(input.sourceDigest)) {
    throw new LifeContractError('LIFE_OPTION_INPUT_INVALID')
  }
  if (input.cost) validateMoney(input.cost)
  const observed = timestamp(input.observedAt, 'LIFE_TIME_INVALID'); const expires = timestamp(input.expiresAt, 'LIFE_TIME_INVALID')
  if (Date.parse(expires) <= Date.parse(observed)) throw new LifeContractError('LIFE_OPTION_TIME_INVALID')
  assertLifeSafeData({ source: input.source, title: input.title })
}
function validateSubscription(input: RecordLifeSubscriptionInput): void {
  validateId(input.accountId, 'LIFE_ACCOUNT_ID_INVALID')
  validateId(input.providerSubscriptionId, 'LIFE_PROVIDER_ITEM_ID_INVALID')
  if (!cleanText(input.serviceLabel, 200) || !cleanText(input.planLabel, 200)
    || !isLifeSubscriptionState(input.state) || !isLifeDigest(input.sourceDigest)) {
    throw new LifeContractError('LIFE_SUBSCRIPTION_INPUT_INVALID')
  }
  validateMoney(input.recurringCost); timestamp(input.renewalAt, 'LIFE_TIME_INVALID')
  if (input.cancellationDeadline !== null) timestamp(input.cancellationDeadline, 'LIFE_TIME_INVALID')
  timestamp(input.observedAt, 'LIFE_TIME_INVALID')
  assertLifeSafeData({ planLabel: input.planLabel, serviceLabel: input.serviceLabel })
}
function normalizeConstraint(input: CreateLifeConstraintSnapshotInput): CreateLifeConstraintSnapshotInput {
  validateId(input.subjectId, 'LIFE_SUBJECT_ID_INVALID')
  const horizon = parseLifeTimeWindow(input.horizon)
  if (!isLifeTimezone(input.timezone) || !['unknown', 'low', 'normal', 'high'].includes(input.readiness)
    || !['unknown', 'poor', 'fair', 'good'].includes(input.recovery)
    || !['unknown', 'none', 'moderate', 'high'].includes(input.sleepDebt)) {
    throw new LifeContractError('LIFE_CONSTRAINT_INPUT_INVALID')
  }
  const freeWindows = normalizeWindows(input.freeWindows, horizon)
  const commitmentIds = sortedUnique(input.commitmentIds, 'LIFE_COMMITMENT_ID_INVALID')
  for (const value of [input.screenTimeUsedMinutes, input.screenTimeLimitMinutes, input.leisureTimeLimitMinutes]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_080) throw new LifeContractError('LIFE_CONSTRAINT_INPUT_INVALID')
  }
  validateMoney(input.budget)
  if (![input.quietStartMinute, input.quietEndMinute].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1_439)
    || !Number.isSafeInteger(input.maxTravelRadiusKm) || input.maxTravelRadiusKm < 0 || input.maxTravelRadiusKm > 40_075) {
    throw new LifeContractError('LIFE_CONSTRAINT_INPUT_INVALID')
  }
  const excludedCategories = sortedTags(input.excludedCategories)
  const preferredCategories = sortedTags(input.preferredCategories)
  if (excludedCategories.some(value => preferredCategories.includes(value))) {
    throw new LifeContractError('LIFE_CONSTRAINT_CATEGORY_CONFLICT')
  }
  const factRefs = normalizeFactRefs(input.factRefs)
  const createdAt = timestamp(input.createdAt, 'LIFE_TIME_INVALID')
  const expiresAt = timestamp(input.expiresAt, 'LIFE_TIME_INVALID')
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new LifeContractError('LIFE_CONSTRAINT_EXPIRED')
  return { ...input, horizon, freeWindows, commitmentIds, excludedCategories, preferredCategories,
    factRefs, createdAt, expiresAt }
}
function normalizeCandidates(values: LifePlanCandidate[]): LifePlanCandidate[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) throw new LifeContractError('LIFE_PLAN_CANDIDATES_INVALID')
  const ids = new Set<string>()
  const result = values.map(value => {
    validateId(value.optionId, 'LIFE_OPTION_ID_INVALID')
    if (ids.has(value.optionId) || typeof value.eligible !== 'boolean'
      || value.score !== null && (!Number.isSafeInteger(value.score) || value.score < 0 || value.score > 1_000_000)) {
      throw new LifeContractError('LIFE_PLAN_CANDIDATES_INVALID')
    }
    ids.add(value.optionId)
    const exclusionCodes = sortedReasonCodes(value.exclusionCodes)
    const rationaleCodes = sortedReasonCodes(value.rationaleCodes)
    if (value.eligible && (value.score === null || exclusionCodes.length) || !value.eligible && value.score !== null) {
      throw new LifeContractError('LIFE_PLAN_CANDIDATES_INVALID')
    }
    return { optionId: value.optionId, eligible: value.eligible, score: value.score, exclusionCodes, rationaleCodes }
  }).sort((left, right) => compare(left.optionId, right.optionId))
  assertLifeSafeData(result); return result
}
function normalizeSessions(values: LifePlanSession[]): LifePlanSession[] {
  if (!Array.isArray(values) || values.length > 32) throw new LifeContractError('LIFE_PLAN_SESSIONS_INVALID')
  const result = values.map(value => {
    validateId(value.optionId, 'LIFE_OPTION_ID_INVALID')
    const window = parseLifeTimeWindow({ startsAt: value.startsAt, endsAt: value.endsAt })
    if (value.cost) validateMoney(value.cost)
    return { optionId: value.optionId, ...window, cost: value.cost ? { ...value.cost } : null,
      rationaleCodes: sortedReasonCodes(value.rationaleCodes) }
  }).sort((left, right) => compare(left.startsAt, right.startsAt) || compare(left.optionId, right.optionId))
  for (let index = 1; index < result.length; index += 1) {
    if (Date.parse(result[index]!.startsAt) < Date.parse(result[index - 1]!.endsAt)) {
      throw new LifeContractError('LIFE_PLAN_SESSION_OVERLAP')
    }
  }
  assertLifeSafeData(result); return result
}
function validatePlanMaterial(db: DatabaseSync, constraint: LifeConstraintSnapshot,
  candidates: LifePlanCandidate[], sessions: LifePlanSession[]): void {
  const map = new Map<string, LifeOption>()
  for (const candidate of candidates) map.set(candidate.optionId,
    required(optionById(db, candidate.optionId), 'LIFE_OPTION_NOT_FOUND'))
  for (const session of sessions) {
    const candidate = candidates.find(item => item.optionId === session.optionId)
    const option = map.get(session.optionId)
    if (!candidate?.eligible || !option || !option.available || Date.parse(option.expiresAt) <= Date.parse(session.startsAt)
      || Date.parse(session.startsAt) < Date.parse(constraint.horizon.startsAt)
      || Date.parse(session.endsAt) > Date.parse(constraint.horizon.endsAt)
      || !constraint.freeWindows.some(window => window.startsAt <= session.startsAt && window.endsAt >= session.endsAt)
      || lifeCanonicalDigest(session.cost) !== lifeCanonicalDigest(option.cost)) {
      throw new LifeContractError('LIFE_PLAN_SESSION_MATERIAL_MISMATCH')
    }
  }
}
function normalizeWindows(values: LifeTimeWindow[], horizon: LifeTimeWindow): LifeTimeWindow[] {
  if (!Array.isArray(values) || values.length > 64) throw new LifeContractError('LIFE_TIME_WINDOWS_INVALID')
  const result = values.map(parseLifeTimeWindow).sort((left, right) => compare(left.startsAt, right.startsAt))
  for (let index = 0; index < result.length; index += 1) {
    const current = result[index]!
    if (current.startsAt < horizon.startsAt || current.endsAt > horizon.endsAt
      || index > 0 && current.startsAt < result[index - 1]!.endsAt) throw new LifeContractError('LIFE_TIME_WINDOWS_INVALID')
  }
  return result
}
function normalizeFactRefs(values: LifeConstraintFactRef[]): LifeConstraintFactRef[] {
  if (!Array.isArray(values) || values.length > 64) throw new LifeContractError('LIFE_FACT_REFS_INVALID')
  const result = values.map(value => {
    validateId(value.recordId, 'LIFE_FACT_REF_ID_INVALID')
    if (!isLifeDigest(value.recordDigest)) throw new LifeContractError('LIFE_FACT_REFS_INVALID')
    return { ...value, observedAt: timestamp(value.observedAt, 'LIFE_TIME_INVALID') }
  }).sort((left, right) => compare(left.recordId, right.recordId))
  if (result.some((item, index) => index > 0 && item.recordId === result[index - 1]!.recordId)) {
    throw new LifeContractError('LIFE_FACT_REFS_INVALID')
  }
  return result
}

function accountById(db: DatabaseSync, id: string): LifeSourceAccount | null {
  const row = db.prepare('SELECT * FROM life_accounts WHERE id=?').get(id) as AccountRow | undefined
  return row ? accountFromRow(row) : null
}
function commitmentById(db: DatabaseSync, id: string): LifeCommitment | null {
  const row = db.prepare('SELECT * FROM life_commitments WHERE id=?').get(id) as CommitmentRow | undefined
  return row ? commitmentFromRow(row) : null
}
function contactById(db: DatabaseSync, id: string): LifeContactAlias | null {
  const row = db.prepare('SELECT * FROM life_contact_aliases WHERE id=?').get(id) as ContactRow | undefined
  return row ? contactFromRow(row) : null
}
function optionById(db: DatabaseSync, id: string): LifeOption | null {
  const row = db.prepare('SELECT * FROM life_options WHERE id=?').get(id) as OptionRow | undefined
  return row ? optionFromRow(row) : null
}
function subscriptionById(db: DatabaseSync, id: string): LifeSubscription | null {
  const row = db.prepare('SELECT * FROM life_subscriptions WHERE id=?').get(id) as SubscriptionRow | undefined
  return row ? subscriptionFromRow(row) : null
}
function subscriptionByProvider(db: DatabaseSync, accountId: string, providerId: string): LifeSubscription | null {
  const row = db.prepare(`SELECT * FROM life_subscriptions WHERE account_id=? AND provider_subscription_id=?`)
    .get(accountId, providerId) as SubscriptionRow | undefined
  return row ? subscriptionFromRow(row) : null
}
function constraintById(db: DatabaseSync, id: string): LifeConstraintSnapshot | null {
  const row = db.prepare('SELECT * FROM life_constraint_snapshots WHERE id=?').get(id) as ConstraintRow | undefined
  return row ? constraintFromRow(row) : null
}
function constraintByDigest(db: DatabaseSync, digest: string): LifeConstraintSnapshot | null {
  const row = db.prepare('SELECT * FROM life_constraint_snapshots WHERE material_digest=?').get(digest) as ConstraintRow | undefined
  return row ? constraintFromRow(row) : null
}
function planById(db: DatabaseSync, id: string): LifePlanRevision | null {
  const row = db.prepare('SELECT * FROM life_plan_revisions WHERE id=?').get(id) as PlanRow | undefined
  return row ? planFromRow(row) : null
}
function planByDigest(db: DatabaseSync, digest: string): LifePlanRevision | null {
  const row = db.prepare('SELECT * FROM life_plan_revisions WHERE plan_digest=?').get(digest) as PlanRow | undefined
  return row ? planFromRow(row) : null
}
function holdById(db: DatabaseSync, id: string): LifeCalendarHold | null {
  const row = db.prepare('SELECT * FROM life_calendar_holds WHERE id=?').get(id) as HoldRow | undefined
  return row ? holdFromRow(row) : null
}
function holdByWorkflow(db: DatabaseSync, workflowId: string): LifeCalendarHold | null {
  const row = db.prepare('SELECT * FROM life_calendar_holds WHERE workflow_id=?').get(workflowId) as HoldRow | undefined
  return row ? holdFromRow(row) : null
}
function holdByProviderRequest(db: DatabaseSync, accountId: string, providerRequestId: string): LifeCalendarHold | null {
  const row = db.prepare('SELECT * FROM life_calendar_holds WHERE account_id=? AND provider_request_id=?')
    .get(accountId, providerRequestId) as HoldRow | undefined
  return row ? holdFromRow(row) : null
}
function cancellationById(db: DatabaseSync, id: string): LifeSubscriptionCancellation | null {
  const row = db.prepare('SELECT * FROM life_subscription_cancellations WHERE id=?').get(id) as CancellationRow | undefined
  return row ? cancellationFromRow(row) : null
}
function cancellationByWorkflow(db: DatabaseSync, workflowId: string): LifeSubscriptionCancellation | null {
  const row = db.prepare('SELECT * FROM life_subscription_cancellations WHERE workflow_id=?')
    .get(workflowId) as CancellationRow | undefined
  return row ? cancellationFromRow(row) : null
}
function cancellationByProviderRequest(db: DatabaseSync, accountId: string,
  providerRequestId: string): LifeSubscriptionCancellation | null {
  const row = db.prepare(`SELECT * FROM life_subscription_cancellations
    WHERE account_id=? AND provider_request_id=?`).get(accountId, providerRequestId) as CancellationRow | undefined
  return row ? cancellationFromRow(row) : null
}
function handoffById(db: DatabaseSync, id: string): LifeHandoff | null {
  const row = db.prepare('SELECT * FROM life_handoffs WHERE id=?').get(id) as HandoffRow | undefined
  return row ? handoffFromRow(row) : null
}
function activationById(db: DatabaseSync, id: string): LifeActivationReview | null {
  const row = db.prepare('SELECT * FROM life_activation_reviews WHERE id=?').get(id) as ActivationRow | undefined
  return row ? activationFromRow(row) : null
}

function accountFromRow(row: AccountRow): LifeSourceAccount {
  return { id: row.id, sourceKind: row.source_kind, mode: row.mode, executorId: row.executor_id,
    displayName: row.display_name, health: row.health, enabled: row.enabled === 1, policyEpoch: row.policy_epoch,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at }
}
function commitmentFromRow(row: CommitmentRow): LifeCommitment {
  return { id: row.id, accountId: row.account_id, providerItemId: row.provider_item_id, label: row.label,
    category: row.category, startsAt: row.starts_at, endsAt: row.ends_at, allDay: row.all_day === 1,
    busy: row.busy === 1, locationClass: row.location_class,
    participantAliasIds: JSON.parse(row.participant_alias_ids_json) as string[], observedAt: row.observed_at,
    expiresAt: row.expires_at, sourceDigest: row.source_digest }
}
function contactFromRow(row: ContactRow): LifeContactAlias {
  return { id: row.id, accountId: row.account_id, providerContactId: row.provider_contact_id, alias: row.alias,
    relationshipTags: JSON.parse(row.relationship_tags_json) as string[],
    availabilityTags: JSON.parse(row.availability_tags_json) as string[], observedAt: row.observed_at,
    sourceDigest: row.source_digest }
}
function optionFromRow(row: OptionRow): LifeOption {
  return { id: row.id, accountId: row.account_id, kind: row.kind, source: row.source,
    providerItemId: row.provider_item_id, title: row.title,
    categoryTags: JSON.parse(row.category_tags_json) as string[], durationMinutes: row.duration_minutes,
    exertion: row.exertion, screenBased: row.screen_based === 1, locationClass: row.location_class,
    cost: row.cost_currency === null || row.cost_minor === null ? null
      : { currency: row.cost_currency, amountMinor: row.cost_minor }, available: row.available === 1,
    observedAt: row.observed_at, expiresAt: row.expires_at, sourceDigest: row.source_digest }
}
function subscriptionFromRow(row: SubscriptionRow): LifeSubscription {
  return { id: row.id, accountId: row.account_id, providerSubscriptionId: row.provider_subscription_id,
    serviceLabel: row.service_label, planLabel: row.plan_label,
    recurringCost: { currency: row.currency, amountMinor: row.recurring_cost_minor }, renewalAt: row.renewal_at,
    cancellationDeadline: row.cancellation_deadline, state: row.state, observedAt: row.observed_at,
    sourceDigest: row.source_digest, version: row.version }
}
function constraintFromRow(row: ConstraintRow): LifeConstraintSnapshot {
  return { id: row.id, subjectId: row.subject_id, horizon: { startsAt: row.horizon_start, endsAt: row.horizon_end },
    timezone: row.timezone, freeWindows: JSON.parse(row.free_windows_json) as LifeTimeWindow[],
    commitmentIds: JSON.parse(row.commitment_ids_json) as string[], readiness: row.readiness,
    recovery: row.recovery, sleepDebt: row.sleep_debt, screenTimeUsedMinutes: row.screen_time_used_minutes,
    screenTimeLimitMinutes: row.screen_time_limit_minutes, leisureTimeLimitMinutes: row.leisure_time_limit_minutes,
    budget: { currency: row.budget_currency, amountMinor: row.budget_minor },
    quietStartMinute: row.quiet_start_minute, quietEndMinute: row.quiet_end_minute,
    maxTravelRadiusKm: row.max_travel_radius_km,
    excludedCategories: JSON.parse(row.excluded_categories_json) as string[],
    preferredCategories: JSON.parse(row.preferred_categories_json) as string[],
    factRefs: JSON.parse(row.fact_refs_json) as LifeConstraintFactRef[], materialDigest: row.material_digest,
    createdAt: row.created_at, expiresAt: row.expires_at }
}
function planFromRow(row: PlanRow): LifePlanRevision {
  return { id: row.id, constraintSnapshotId: row.constraint_snapshot_id, constraintDigest: row.constraint_digest,
    candidates: JSON.parse(row.candidates_json) as LifePlanCandidate[],
    sessions: JSON.parse(row.sessions_json) as LifePlanSession[], totalMinutes: row.total_minutes,
    totalCost: { currency: row.total_currency, amountMinor: row.total_cost_minor }, planDigest: row.plan_digest,
    state: row.state, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
}
function holdFromRow(row: HoldRow): LifeCalendarHold {
  return { id: row.id, workflowId: row.workflow_id, intentId: row.intent_id, accountId: row.account_id,
    planRevisionId: row.plan_revision_id, planDigest: row.plan_digest, optionId: row.option_id,
    window: { startsAt: row.starts_at, endsAt: row.ends_at }, providerRequestId: row.provider_request_id,
    providerHoldId: row.provider_hold_id, receiptDigest: row.receipt_digest, state: row.state,
    policyEpoch: row.policy_epoch, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at }
}
function cancellationFromRow(row: CancellationRow): LifeSubscriptionCancellation {
  return { id: row.id, workflowId: row.workflow_id, intentId: row.intent_id, accountId: row.account_id,
    subscriptionId: row.subscription_id, subscriptionDigest: row.subscription_digest,
    providerRequestId: row.provider_request_id, reasonCode: row.reason_code,
    providerReceiptId: row.provider_receipt_id, receiptDigest: row.receipt_digest, state: row.state,
    policyEpoch: row.policy_epoch, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at }
}
function handoffFromRow(row: HandoffRow): LifeHandoff {
  return { id: row.id, planRevisionId: row.plan_revision_id, optionId: row.option_id, kind: row.kind,
    targetCapabilityId: row.target_capability_id, materialDigest: row.material_digest, state: row.state,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
}
function checkpointFromRow(row: CheckpointRow): LifeCheckpoint {
  return { id: `${row.aggregate_kind}:${row.aggregate_id}:${row.ordinal}`, aggregateId: row.aggregate_id,
    ordinal: row.ordinal, stage: row.stage, evidenceDigest: row.evidence_digest, errorCode: row.error_code,
    details: JSON.parse(row.details_json) as Record<string, unknown>, observedAt: row.observed_at }
}
function activationFromRow(row: ActivationRow): LifeActivationReview {
  return { id: row.id, accountId: row.account_id, fromMode: row.from_mode, toMode: row.to_mode,
    actorUserId: row.actor_user_id, shadowEvidenceDigest: row.shadow_evidence_digest,
    limitsDigest: row.limits_digest, approved: row.approved === 1, createdAt: row.created_at }
}

function commitmentMaterial(value: Omit<LifeCommitment, 'id'> | LifeCommitment): Record<string, unknown> {
  return { accountId: value.accountId, providerItemId: value.providerItemId, label: value.label,
    category: value.category, startsAt: value.startsAt, endsAt: value.endsAt, allDay: value.allDay,
    busy: value.busy, locationClass: value.locationClass, participantAliasIds: value.participantAliasIds,
    observedAt: value.observedAt, expiresAt: value.expiresAt, sourceDigest: value.sourceDigest }
}
function contactMaterial(value: Omit<LifeContactAlias, 'id'> | LifeContactAlias): Record<string, unknown> {
  return { accountId: value.accountId, providerContactId: value.providerContactId, alias: value.alias,
    relationshipTags: value.relationshipTags, availabilityTags: value.availabilityTags,
    observedAt: value.observedAt, sourceDigest: value.sourceDigest }
}
function optionMaterial(value: Omit<LifeOption, 'id'> | LifeOption): Record<string, unknown> {
  return { accountId: value.accountId, kind: value.kind, source: value.source,
    providerItemId: value.providerItemId, title: value.title, categoryTags: value.categoryTags,
    durationMinutes: value.durationMinutes, exertion: value.exertion, screenBased: value.screenBased,
    locationClass: value.locationClass, cost: value.cost, available: value.available,
    observedAt: value.observedAt, expiresAt: value.expiresAt, sourceDigest: value.sourceDigest }
}
function subscriptionMaterial(value: RecordLifeSubscriptionInput | LifeSubscription): Record<string, unknown> {
  return { accountId: value.accountId, providerSubscriptionId: value.providerSubscriptionId,
    serviceLabel: value.serviceLabel, planLabel: value.planLabel, recurringCost: value.recurringCost,
    renewalAt: value.renewalAt, cancellationDeadline: value.cancellationDeadline, state: value.state,
    observedAt: value.observedAt, sourceDigest: value.sourceDigest }
}
function constraintMaterial(value: CreateLifeConstraintSnapshotInput): Record<string, unknown> {
  return { subjectId: value.subjectId, horizon: value.horizon, timezone: value.timezone,
    freeWindows: value.freeWindows, commitmentIds: value.commitmentIds, readiness: value.readiness,
    recovery: value.recovery, sleepDebt: value.sleepDebt, screenTimeUsedMinutes: value.screenTimeUsedMinutes,
    screenTimeLimitMinutes: value.screenTimeLimitMinutes, leisureTimeLimitMinutes: value.leisureTimeLimitMinutes,
    budget: value.budget, quietStartMinute: value.quietStartMinute, quietEndMinute: value.quietEndMinute,
    maxTravelRadiusKm: value.maxTravelRadiusKm, excludedCategories: value.excludedCategories,
    preferredCategories: value.preferredCategories, factRefs: value.factRefs,
    createdAt: value.createdAt, expiresAt: value.expiresAt }
}

function validateId(value: string, code: string): void { if (!isLifeSemanticId(value)) throw new LifeContractError(code) }
function validateWorkflow(workflowId: string, intentId: string): void {
  if (!WORKFLOW_ID.test(workflowId) || !INTENT_ID.test(intentId)) throw new LifeContractError('LIFE_WORKFLOW_ID_INVALID')
}
function validateMoney(value: LifeMoney): void {
  if (!value || !isLifeCurrency(value.currency) || !Number.isSafeInteger(value.amountMinor)
    || value.amountMinor < 0 || value.amountMinor > MAX_SAFE_MONEY) throw new LifeContractError('LIFE_MONEY_INVALID')
}
function validateOptionalId(value: string | null | undefined, code: string): void {
  if (value !== undefined && value !== null) validateId(value, code)
}
function validateOptionalDigest(value: string | null | undefined): void {
  if (value !== undefined && value !== null && !isLifeDigest(value)) throw new LifeContractError('LIFE_DIGEST_INVALID')
}
function timestamp(value: string, code: string): string {
  const parsed = Date.parse(value)
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) throw new LifeContractError(code)
  return value
}
function cleanText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function sortedUnique(values: string[], code: string): string[] {
  if (!Array.isArray(values) || values.length > 64) throw new LifeContractError(code)
  const result = [...values]; result.forEach(value => validateId(value, code)); result.sort(compare)
  if (result.some((value, index) => index > 0 && value === result[index - 1])) throw new LifeContractError(code)
  return result
}
function sortedTags(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 64 || values.some(value => typeof value !== 'string' || !TAG.test(value))) {
    throw new LifeContractError('LIFE_TAGS_INVALID')
  }
  const result = [...values].sort(compare)
  if (result.some((value, index) => index > 0 && value === result[index - 1])) throw new LifeContractError('LIFE_TAGS_INVALID')
  return result
}
function sortedReasonCodes(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 64 || values.some(value => !isLifeErrorCode(value))) {
    throw new LifeContractError('LIFE_REASON_CODES_INVALID')
  }
  const result = [...values].sort(compare)
  if (result.some((value, index) => index > 0 && value === result[index - 1])) {
    throw new LifeContractError('LIFE_REASON_CODES_INVALID')
  }
  return result
}
function validVersion(value: number): boolean { return Number.isSafeInteger(value) && value >= 1 }
function listLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST) throw new LifeContractError('LIFE_LIMIT_INVALID')
  return value
}
function stableId(value: unknown): string { return lifeCanonicalDigest(value).slice(0, 32) }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compare).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function required<T>(value: T | null | undefined, code: string): T {
  if (value === null || value === undefined) throw new LifeContractError(code)
  return value
}
