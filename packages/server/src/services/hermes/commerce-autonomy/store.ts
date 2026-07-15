import { createHash } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  assertCommerceSafeData,
  CommerceContractError,
  isCommerceAccountHealth,
  isCommerceCurrency,
  isCommerceCancellationState,
  isCommerceDeliveryState,
  isCommerceDigest,
  isCommerceErrorCode,
  isCommerceExecutionMode,
  isCommerceFulfillmentKind,
  isCommerceProviderKind,
  isCommerceRefundState,
  isCommerceSemanticId,
  isLegalCommerceTransactionTransition,
} from './contracts'
import { withCommerceAutonomyDb } from './database'
import type {
  CommerceCartItem,
  CommerceActivationReview,
  CommerceCartRevision,
  CommerceCancellationRequest,
  CommerceCheckpoint,
  CommerceComparison,
  CommerceComparisonCandidate,
  CommerceComparisonRequirement,
  CommerceDeliveryObservation,
  CommerceOfferSnapshot,
  CommercePaymentAttempt,
  CommerceProviderAccount,
  CommerceQuote,
  CommerceQuoteBreakdown,
  CommerceRefundRequest,
  CommerceTransaction,
  CommerceTransactionState,
} from './types'

const MAX_SAFE_MONEY = Number.MAX_SAFE_INTEGER
const MAX_LIST = 200
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/
const WORKFLOW_ID = /^workflow-[a-zA-Z0-9][a-zA-Z0-9._:-]{0,190}$/
const INTENT_ID = /^intent-[a-zA-Z0-9][a-zA-Z0-9._:-]{0,192}$/

type AccountRow = {
  id: string; provider: CommerceProviderAccount['provider']; mode: CommerceProviderAccount['mode']; currency: string
  executor_id: string | null; display_name: string; health: CommerceProviderAccount['health']; enabled: number
  policy_epoch: number; version: number; created_at: string; updated_at: string; revoked_at: string | null
}
type OfferRow = {
  id: string; account_id: string; provider: CommerceOfferSnapshot['provider']; provider_offer_id: string
  product_id: string; sku_id: string; merchant_id: string; merchant_name: string; title: string; unit_label: string
  currency: string; unit_price_minor: number; available: number; max_quantity: number
  fulfillment: CommerceOfferSnapshot['fulfillment']; fulfillment_minutes: number | null
  observed_at: string; expires_at: string; source_digest: string; created_at: string
}
type ComparisonRow = {
  id: string; account_id: string; requirement_json: string; candidates_json: string
  selected_offer_snapshot_id: string | null; input_digest: string; created_at: string
}
type CartRow = {
  id: string; account_id: string; revision: number; items_json: string; destination_token: string
  recipient_token: string; substitution: CommerceCartRevision['substitution']; content_digest: string; created_at: string
}
type QuoteRow = {
  id: string; account_id: string; cart_revision_id: string; cart_digest: string; provider_quote_id: string
  currency: string; items_minor: number; delivery_minor: number; service_minor: number; tax_minor: number
  discount_minor: number; total_minor: number; quote_digest: string; status: CommerceQuote['status']; version: number
  observed_at: string; expires_at: string; created_at: string; updated_at: string
}
type TransactionRow = {
  id: string; workflow_id: string; intent_id: string; account_id: string; provider: CommerceTransaction['provider']
  mode: CommerceTransaction['mode']; policy_epoch: number; quote_id: string; quote_digest: string
  provider_request_id: string; provider_order_id: string | null; currency: string; expected_amount_minor: number
  actual_amount_minor: number | null; state: CommerceTransaction['state']; version: number
  created_at: string; updated_at: string; completed_at: string | null
}
type CheckpointRow = {
  transaction_id: string; ordinal: number; stage: string; evidence_digest: string | null; error_code: string | null
  details_json: string; observed_at: string; created_at: string
}
type PaymentRow = {
  id: string; transaction_id: string; provider_request_id: string; approval_id: string | null
  method_label: string | null; method_fingerprint: string | null; currency: string; amount_minor: number
  state: CommercePaymentAttempt['state']; provider_receipt_id: string | null; evidence_digest: string | null
  version: number; created_at: string; updated_at: string; completed_at: string | null
}
type DeliveryRow = {
  id: string; transaction_id: string; provider_event_id: string; state: CommerceDeliveryObservation['state']
  eta_at: string | null; evidence_digest: string; observed_at: string; created_at: string
}
type CancellationRow = {
  id: string; transaction_id: string; provider_request_id: string; reason_code: string; eligibility_digest: string
  state: CommerceCancellationRequest['state']; provider_receipt_id: string | null; version: number
  created_at: string; updated_at: string; completed_at: string | null
}
type RefundRow = {
  id: string; transaction_id: string; provider_request_id: string; reason_code: string; currency: string
  expected_amount_minor: number; actual_amount_minor: number | null; eligibility_digest: string
  state: CommerceRefundRequest['state']; provider_receipt_id: string | null; version: number
  created_at: string; updated_at: string; completed_at: string | null
}
type ActivationRow = {
  id: string; account_id: string; from_mode: CommerceActivationReview['fromMode']
  to_mode: CommerceActivationReview['toMode']; actor_user_id: string; shadow_evidence_digest: string | null
  limits_digest: string; approved: number; created_at: string
}

export interface CreateCommerceAccountInput {
  id: string
  provider: CommerceProviderAccount['provider']
  mode: CommerceProviderAccount['mode']
  currency: string
  executorId?: string | null
  displayName: string
  enabled?: boolean
}

export interface RecordCommerceOfferInput {
  accountId: string
  provider: CommerceOfferSnapshot['provider']
  providerOfferId: string
  productId: string
  skuId: string
  merchantId: string
  merchantName: string
  title: string
  unitLabel: string
  currency: string
  unitPriceMinor: number
  available: boolean
  maxQuantity: number
  fulfillment: CommerceOfferSnapshot['fulfillment']
  fulfillmentMinutes: number | null
  observedAt: string
  expiresAt: string
  sourceDigest: string
}

export interface CreateCommerceComparisonInput {
  accountId: string
  requirement: CommerceComparisonRequirement
  candidates: CommerceComparisonCandidate[]
  selectedOfferSnapshotId: string | null
  createdAt?: string
}

export interface CreateCommerceCartInput {
  accountId: string
  items: CommerceCartItem[]
  destinationToken: string
  recipientToken: string
  substitution: CommerceCartRevision['substitution']
  createdAt?: string
}

export interface CreateCommerceQuoteInput {
  accountId: string
  cartRevisionId: string
  providerQuoteId: string
  currency: string
  breakdown: CommerceQuoteBreakdown
  observedAt: string
  expiresAt: string
}

export interface CreateCommerceTransactionInput {
  workflowId: string
  intentId: string
  accountId: string
  quoteId: string
  providerRequestId: string
  createdAt?: string
}

export interface TransitionCommerceTransactionInput {
  transactionId: string
  expectedVersion: number
  state: CommerceTransactionState
  providerOrderId?: string | null
  actualAmountMinor?: number | null
  completedAt?: string | null
  updatedAt?: string
}

export interface CreateCommercePaymentAttemptInput {
  transactionId: string
  providerRequestId: string
  approvalId: string
  currency: string
  amountMinor: number
  createdAt?: string
}

export interface TransitionCommercePaymentAttemptInput {
  paymentId: string
  expectedVersion: number
  state: CommercePaymentAttempt['state']
  providerReceiptId?: string | null
  evidenceDigest?: string | null
  completedAt?: string | null
  updatedAt?: string
}

export interface RecordCommerceDeliveryInput {
  transactionId: string
  providerEventId: string
  state: CommerceDeliveryObservation['state']
  etaAt: string | null
  evidenceDigest: string
  observedAt: string
}

export interface CreateCommerceCancellationInput {
  transactionId: string
  providerRequestId: string
  reasonCode: string
  createdAt?: string
}

export interface TransitionCommerceCancellationInput {
  requestId: string
  expectedVersion: number
  state: CommerceCancellationRequest['state']
  providerReceiptId?: string | null
  completedAt?: string | null
  updatedAt?: string
}

export interface CreateCommerceRefundInput {
  transactionId: string
  providerRequestId: string
  reasonCode: string
  currency: string
  amountMinor: number
  createdAt?: string
}

export interface TransitionCommerceRefundInput {
  requestId: string
  expectedVersion: number
  state: CommerceRefundRequest['state']
  providerReceiptId?: string | null
  actualAmountMinor?: number | null
  completedAt?: string | null
  updatedAt?: string
}

export interface UpdateCommerceAccountInput {
  accountId: string
  expectedVersion: number
  mode?: CommerceProviderAccount['mode']
  health?: CommerceProviderAccount['health']
  enabled?: boolean
  executorId?: string | null
  revoke?: boolean
  activationReviewId?: string
  updatedAt?: string
}

export interface RecordCommerceActivationReviewInput {
  accountId: string
  fromMode: CommerceActivationReview['fromMode']
  toMode: CommerceActivationReview['toMode']
  actorUserId: string
  shadowEvidenceDigest: string | null
  limitsDigest: string
  approved: boolean
  createdAt?: string
}

export function commerceCanonicalDigest(value: unknown): string {
  assertCommerceSafeData(value)
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function createCommerceAccount(input: CreateCommerceAccountInput): CommerceProviderAccount {
  validateAccountInput(input)
  const now = new Date().toISOString()
  return withCommerceAutonomyDb(db => {
    const existing = accountById(db, input.id)
    if (existing) {
      if (existing.provider !== input.provider || existing.mode !== input.mode || existing.currency !== input.currency
        || existing.executorId !== (input.executorId ?? null) || existing.displayName !== input.displayName
        || existing.enabled !== (input.enabled ?? true)) throw new CommerceContractError('COMMERCE_ACCOUNT_REPLAY_MISMATCH')
      return existing
    }
    if (input.mode === 'live') throw new CommerceContractError('COMMERCE_LIVE_ACTIVATION_REQUIRED')
    db.prepare(`INSERT INTO commerce_accounts(id,provider,mode,currency,executor_id,display_name,health,enabled,
      policy_epoch,version,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      input.id, input.provider, input.mode, input.currency, input.executorId ?? null, input.displayName,
      'unknown', (input.enabled ?? true) ? 1 : 0, 1, 1, now, now,
    )
    return required(accountById(db, input.id), 'COMMERCE_ACCOUNT_CREATE_FAILED')
  })
}

export function getCommerceAccount(accountId: string): CommerceProviderAccount | null {
  validateId(accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  return withCommerceAutonomyDb(db => accountById(db, accountId))
}

export function listCommerceAccounts(limit = 100): CommerceProviderAccount[] {
  const bounded = listLimit(limit)
  return withCommerceAutonomyDb(db => (db.prepare(
    'SELECT * FROM commerce_accounts ORDER BY id LIMIT ?',
  ).all(bounded) as unknown as AccountRow[]).map(accountFromRow))
}

export function updateCommerceAccount(input: UpdateCommerceAccountInput): CommerceProviderAccount {
  validateId(input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || input.mode !== undefined && !isCommerceExecutionMode(input.mode)
    || input.health !== undefined && !isCommerceAccountHealth(input.health)
    || input.enabled !== undefined && typeof input.enabled !== 'boolean'
    || input.activationReviewId !== undefined && !isCommerceSemanticId(input.activationReviewId)
    || input.executorId !== undefined && input.executorId !== null && !isCommerceSemanticId(input.executorId)) {
    throw new CommerceContractError('COMMERCE_ACCOUNT_UPDATE_INVALID')
  }
  const updatedAt = normalizedTimestamp(input.updatedAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const current = required(accountById(db, input.accountId), 'COMMERCE_ACCOUNT_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new CommerceContractError('COMMERCE_ACCOUNT_VERSION_CONFLICT')
    if (current.health === 'revoked') throw new CommerceContractError('COMMERCE_ACCOUNT_REVOKED')
    const mode = input.mode ?? current.mode
    const health = input.revoke ? 'revoked' : input.health ?? current.health
    const enabled = input.revoke ? false : input.enabled ?? current.enabled
    const executorId = input.executorId === undefined ? current.executorId : input.executorId
    if (mode === 'live' && current.mode !== 'live') {
      if (!input.activationReviewId) throw new CommerceContractError('COMMERCE_LIVE_ACTIVATION_REQUIRED')
      const review = activationById(db, input.activationReviewId)
      if (!review || !review.approved || review.accountId !== current.id || review.fromMode !== current.mode
        || review.toMode !== 'live') throw new CommerceContractError('COMMERCE_LIVE_ACTIVATION_REQUIRED')
    }
    const authorityChanged = mode !== current.mode || enabled !== current.enabled || executorId !== current.executorId
      || health === 'revoked'
    const result = db.prepare(`UPDATE commerce_accounts SET mode=?,health=?,enabled=?,executor_id=?,
      policy_epoch=?,version=version+1,updated_at=?,revoked_at=? WHERE id=? AND version=?`).run(
      mode, health, enabled ? 1 : 0, executorId, current.policyEpoch + (authorityChanged ? 1 : 0), updatedAt,
      health === 'revoked' ? updatedAt : current.revokedAt, current.id, current.version,
    )
    if (result.changes !== 1) throw new CommerceContractError('COMMERCE_ACCOUNT_VERSION_CONFLICT')
    return required(accountById(db, current.id), 'COMMERCE_ACCOUNT_UPDATE_FAILED')
  })
}

export function recordCommerceActivationReview(
  input: RecordCommerceActivationReviewInput,
): CommerceActivationReview {
  validateId(input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  if (!isCommerceExecutionMode(input.fromMode) || !isCommerceExecutionMode(input.toMode)
    || input.fromMode === input.toMode || !cleanText(input.actorUserId, 160)
    || input.shadowEvidenceDigest !== null && !isCommerceDigest(input.shadowEvidenceDigest)
    || !isCommerceDigest(input.limitsDigest) || typeof input.approved !== 'boolean') {
    throw new CommerceContractError('COMMERCE_ACTIVATION_REVIEW_INVALID')
  }
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    required(accountById(db, input.accountId), 'COMMERCE_ACCOUNT_NOT_FOUND')
    const id = `activation-${stableId({ accountId: input.accountId, actorUserId: input.actorUserId,
      createdAt, fromMode: input.fromMode, toMode: input.toMode })}`
    db.prepare(`INSERT INTO commerce_activation_reviews(id,account_id,from_mode,to_mode,actor_user_id,
      shadow_evidence_digest,limits_digest,approved,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, input.accountId, input.fromMode, input.toMode, input.actorUserId, input.shadowEvidenceDigest,
      input.limitsDigest, input.approved ? 1 : 0, createdAt,
    )
    return required(activationById(db, id), 'COMMERCE_ACTIVATION_REVIEW_CREATE_FAILED')
  })
}

export function listCommerceActivationReviews(accountId: string, limit = 100): CommerceActivationReview[] {
  validateId(accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  const bounded = listLimit(limit)
  return withCommerceAutonomyDb(db => (db.prepare(`SELECT * FROM commerce_activation_reviews
    WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(accountId, bounded) as ActivationRow[])
    .map(activationFromRow))
}

export function getRecentCommerceShadowEvidence(input: {
  accountId: string
  since: string
}): { transaction: CommerceTransaction; evidenceDigest: string } | null {
  validateId(input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  validateTimestamp(input.since, 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const row = db.prepare(`SELECT * FROM commerce_transactions WHERE account_id=? AND mode='shadow'
      AND state IN ('paid','fulfilling','delivered','cancelled','refunded') AND updated_at>=?
      ORDER BY updated_at DESC,id DESC LIMIT 1`).get(input.accountId, input.since) as TransactionRow | undefined
    if (!row) return null
    const transaction = transactionFromRow(row)
    const checkpoints = (db.prepare(`SELECT evidence_digest,stage,observed_at FROM commerce_checkpoints
      WHERE transaction_id=? ORDER BY ordinal`).all(transaction.id) as Array<{
        evidence_digest: string | null; stage: string; observed_at: string
      }>).map(item => ({ evidenceDigest: item.evidence_digest, stage: item.stage, observedAt: item.observed_at }))
    return { transaction, evidenceDigest: commerceCanonicalDigest({ transactionId: transaction.id,
      quoteDigest: transaction.quoteDigest, providerOrderId: transaction.providerOrderId,
      state: transaction.state, amountMinor: transaction.actualAmountMinor ?? transaction.expectedAmountMinor,
      checkpoints }) }
  })
}

export function recordCommerceOfferSnapshot(input: RecordCommerceOfferInput): CommerceOfferSnapshot {
  validateOfferInput(input)
  const id = `offer-${stableId({ accountId: input.accountId, providerOfferId: input.providerOfferId,
    sourceDigest: input.sourceDigest })}`
  return withCommerceAutonomyDb(db => {
    const account = required(accountById(db, input.accountId), 'COMMERCE_ACCOUNT_NOT_FOUND')
    if (account.provider !== input.provider || account.currency !== input.currency || account.health === 'revoked') {
      throw new CommerceContractError('COMMERCE_OFFER_ACCOUNT_MISMATCH')
    }
    const existing = offerById(db, id)
    const material = offerMaterial(input)
    if (existing) {
      if (commerceCanonicalDigest(offerMaterialFromRecord(existing)) !== commerceCanonicalDigest(material)) {
        throw new CommerceContractError('COMMERCE_OFFER_REPLAY_MISMATCH')
      }
      return existing
    }
    db.prepare(`INSERT INTO commerce_offer_snapshots(id,account_id,provider,provider_offer_id,product_id,sku_id,
      merchant_id,merchant_name,title,unit_label,currency,unit_price_minor,available,max_quantity,fulfillment,
      fulfillment_minutes,observed_at,expires_at,source_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.accountId, input.provider, input.providerOfferId, input.productId, input.skuId, input.merchantId,
      input.merchantName, input.title, input.unitLabel, input.currency, input.unitPriceMinor, input.available ? 1 : 0,
      input.maxQuantity, input.fulfillment, input.fulfillmentMinutes, input.observedAt, input.expiresAt,
      input.sourceDigest, input.observedAt,
    )
    const created = required(offerById(db, id), 'COMMERCE_OFFER_CREATE_FAILED')
    if (commerceCanonicalDigest(offerMaterialFromRecord(created)) !== commerceCanonicalDigest(material)) {
      throw new CommerceContractError('COMMERCE_OFFER_REPLAY_MISMATCH')
    }
    return created
  })
}

export function getCommerceOfferSnapshot(offerId: string): CommerceOfferSnapshot | null {
  validateId(offerId, 'COMMERCE_OFFER_ID_INVALID')
  return withCommerceAutonomyDb(db => offerById(db, offerId))
}

export function listCommerceOfferSnapshots(options: {
  accountId: string; activeAt?: string; limit?: number
}): CommerceOfferSnapshot[] {
  validateId(options.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  const limit = listLimit(options.limit ?? 100)
  if (options.activeAt !== undefined) validateTimestamp(options.activeAt, 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const rows = options.activeAt
      ? db.prepare(`SELECT * FROM commerce_offer_snapshots WHERE account_id=? AND available=1 AND expires_at>?
          ORDER BY observed_at DESC,id LIMIT ?`).all(options.accountId, options.activeAt, limit)
      : db.prepare(`SELECT * FROM commerce_offer_snapshots WHERE account_id=?
          ORDER BY observed_at DESC,id LIMIT ?`).all(options.accountId, limit)
    return (rows as unknown as OfferRow[]).map(offerFromRow)
  })
}

export function createCommerceComparison(input: CreateCommerceComparisonInput): CommerceComparison {
  validateComparisonInput(input)
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  const requirement = normalizedRequirement(input.requirement)
  const candidates = normalizedCandidates(input.candidates)
  const inputDigest = commerceCanonicalDigest({ accountId: input.accountId, candidates, requirement,
    selectedOfferSnapshotId: input.selectedOfferSnapshotId })
  const id = `comparison-${stableId({ accountId: input.accountId, inputDigest })}`
  return withCommerceAutonomyDb(db => {
    required(accountById(db, input.accountId), 'COMMERCE_ACCOUNT_NOT_FOUND')
    validateComparisonOffers(db, input.accountId, candidates, input.selectedOfferSnapshotId)
    const existing = comparisonByDigest(db, input.accountId, inputDigest)
    if (existing) return existing
    db.prepare(`INSERT INTO commerce_comparisons(id,account_id,requirement_json,candidates_json,
      selected_offer_snapshot_id,input_digest,created_at) VALUES(?,?,?,?,?,?,?)`).run(
      id, input.accountId, canonicalJson(requirement), canonicalJson(candidates), input.selectedOfferSnapshotId,
      inputDigest, createdAt,
    )
    return required(comparisonByDigest(db, input.accountId, inputDigest), 'COMMERCE_COMPARISON_CREATE_FAILED')
  })
}

export function getCommerceComparison(comparisonId: string): CommerceComparison | null {
  validateId(comparisonId, 'COMMERCE_COMPARISON_ID_INVALID')
  return withCommerceAutonomyDb(db => {
    const row = db.prepare('SELECT * FROM commerce_comparisons WHERE id=?').get(comparisonId) as ComparisonRow | undefined
    return row ? comparisonFromRow(row) : null
  })
}

export function createCommerceCartRevision(input: CreateCommerceCartInput): CommerceCartRevision {
  validateId(input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  if (!TOKEN.test(input.destinationToken) || !TOKEN.test(input.recipientToken)
    || !['deny', 'same_sku_only'].includes(input.substitution)) {
    throw new CommerceContractError('COMMERCE_CART_INPUT_INVALID')
  }
  const items = normalizedCartItems(input.items)
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  const contentDigest = commerceCanonicalDigest({ accountId: input.accountId,
    destinationDigest: createHash('sha256').update(input.destinationToken).digest('hex'), items,
    recipientDigest: createHash('sha256').update(input.recipientToken).digest('hex'), substitution: input.substitution })
  const id = `cart-${stableId({ accountId: input.accountId, contentDigest })}`
  return withCommerceAutonomyDb(db => {
    required(accountById(db, input.accountId), 'COMMERCE_ACCOUNT_NOT_FOUND')
    for (const item of items) {
      const offer = required(offerById(db, item.offerSnapshotId), 'COMMERCE_OFFER_NOT_FOUND')
      if (offer.accountId !== input.accountId || item.quantity > offer.maxQuantity || !offer.available) {
        throw new CommerceContractError('COMMERCE_CART_OFFER_INVALID')
      }
    }
    const existing = cartByDigest(db, input.accountId, contentDigest)
    if (existing) return existing
    const revision = Number((db.prepare(
      'SELECT COALESCE(MAX(revision),0)+1 AS revision FROM commerce_cart_revisions WHERE account_id=?',
    ).get(input.accountId) as { revision: number }).revision)
    db.prepare(`INSERT INTO commerce_cart_revisions(id,account_id,revision,items_json,destination_token,
      recipient_token,substitution,content_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, input.accountId, revision, canonicalJson(items), input.destinationToken, input.recipientToken,
      input.substitution, contentDigest, createdAt,
    )
    return required(cartByDigest(db, input.accountId, contentDigest), 'COMMERCE_CART_CREATE_FAILED')
  })
}

export function getCommerceCartRevision(cartId: string): CommerceCartRevision | null {
  validateId(cartId, 'COMMERCE_CART_ID_INVALID')
  return withCommerceAutonomyDb(db => cartById(db, cartId))
}

export function createCommerceQuote(input: CreateCommerceQuoteInput): CommerceQuote {
  validateQuoteInput(input)
  return withCommerceAutonomyDb(db => {
    const account = required(accountById(db, input.accountId), 'COMMERCE_ACCOUNT_NOT_FOUND')
    const cart = required(cartById(db, input.cartRevisionId), 'COMMERCE_CART_NOT_FOUND')
    if (cart.accountId !== account.id || account.currency !== input.currency) {
      throw new CommerceContractError('COMMERCE_QUOTE_ACCOUNT_MISMATCH')
    }
    const material = { breakdown: input.breakdown, cartDigest: cart.contentDigest,
      currency: input.currency, expiresAt: input.expiresAt, observedAt: input.observedAt,
      providerQuoteId: input.providerQuoteId }
    const quoteDigest = commerceCanonicalDigest(material)
    const existing = quoteByDigest(db, input.accountId, quoteDigest)
    if (existing) return existing
    const id = `quote-${stableId({ accountId: input.accountId, quoteDigest })}`
    const now = input.observedAt
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`UPDATE commerce_quotes SET status='superseded',version=version+1,updated_at=?
        WHERE account_id=? AND cart_revision_id=? AND status='active'`).run(now, input.accountId, cart.id)
      db.prepare(`INSERT INTO commerce_quotes(id,account_id,cart_revision_id,cart_digest,provider_quote_id,currency,
        items_minor,delivery_minor,service_minor,tax_minor,discount_minor,total_minor,quote_digest,status,version,
        observed_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?,?,?)`).run(
        id, input.accountId, cart.id, cart.contentDigest, input.providerQuoteId, input.currency,
        input.breakdown.itemsMinor, input.breakdown.deliveryMinor, input.breakdown.serviceMinor,
        input.breakdown.taxMinor, input.breakdown.discountMinor, input.breakdown.totalMinor, quoteDigest,
        input.observedAt, input.expiresAt, now, now,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return required(quoteByDigest(db, input.accountId, quoteDigest), 'COMMERCE_QUOTE_CREATE_FAILED')
  })
}

export function getCommerceQuote(quoteId: string): CommerceQuote | null {
  validateId(quoteId, 'COMMERCE_QUOTE_ID_INVALID')
  return withCommerceAutonomyDb(db => quoteById(db, quoteId))
}

export function expireCommerceQuotes(at = new Date().toISOString()): number {
  validateTimestamp(at, 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => Number(db.prepare(`UPDATE commerce_quotes
    SET status='expired',version=version+1,updated_at=? WHERE status='active' AND expires_at<=?`).run(at, at).changes))
}

export function createCommerceTransaction(input: CreateCommerceTransactionInput): CommerceTransaction {
  validateTransactionInput(input)
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const account = required(accountById(db, input.accountId), 'COMMERCE_ACCOUNT_NOT_FOUND')
    const quote = required(quoteById(db, input.quoteId), 'COMMERCE_QUOTE_NOT_FOUND')
    const existing = transactionByWorkflow(db, input.workflowId)
    const expected = { accountId: account.id, intentId: input.intentId, providerRequestId: input.providerRequestId,
      quoteDigest: quote.quoteDigest, quoteId: quote.id, workflowId: input.workflowId }
    if (existing) {
      const actual = { accountId: existing.accountId, intentId: existing.intentId,
        providerRequestId: existing.providerRequestId, quoteDigest: existing.quoteDigest,
        quoteId: existing.quoteId, workflowId: existing.workflowId }
      if (commerceCanonicalDigest(actual) !== commerceCanonicalDigest(expected)) {
        throw new CommerceContractError('COMMERCE_TRANSACTION_REPLAY_MISMATCH')
      }
      return existing
    }
    if (account.health === 'revoked' || quote.accountId !== account.id || quote.status !== 'active'
      || Date.parse(quote.expiresAt) <= Date.parse(createdAt)) throw new CommerceContractError('COMMERCE_QUOTE_NOT_ACTIVE')
    const id = `transaction-${stableId({ workflowId: input.workflowId })}`
    db.prepare(`INSERT INTO commerce_transactions(id,workflow_id,intent_id,account_id,provider,mode,policy_epoch,
      quote_id,quote_digest,provider_request_id,provider_order_id,currency,expected_amount_minor,actual_amount_minor,
      state,version,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,'proposed',1,?,?,NULL)`).run(
      id, input.workflowId, input.intentId, account.id, account.provider, account.mode, account.policyEpoch,
      quote.id, quote.quoteDigest, input.providerRequestId, quote.currency, quote.breakdown.totalMinor, createdAt, createdAt,
    )
    return required(transactionByWorkflow(db, input.workflowId), 'COMMERCE_TRANSACTION_CREATE_FAILED')
  })
}

export function getCommerceTransaction(transactionId: string): CommerceTransaction | null {
  validateId(transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  return withCommerceAutonomyDb(db => transactionById(db, transactionId))
}

export function getCommerceTransactionByWorkflow(workflowId: string): CommerceTransaction | null {
  if (!WORKFLOW_ID.test(workflowId)) throw new CommerceContractError('COMMERCE_WORKFLOW_ID_INVALID')
  return withCommerceAutonomyDb(db => transactionByWorkflow(db, workflowId))
}

export function createCommercePaymentAttempt(input: CreateCommercePaymentAttemptInput): CommercePaymentAttempt {
  validateId(input.transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  if (!TOKEN.test(input.providerRequestId) || !TOKEN.test(input.approvalId) || !isCommerceCurrency(input.currency)) {
    throw new CommerceContractError('COMMERCE_PAYMENT_INPUT_INVALID')
  }
  validateMoneyInteger(input.amountMinor)
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const transaction = required(transactionById(db, input.transactionId), 'COMMERCE_TRANSACTION_NOT_FOUND')
    if (transaction.currency !== input.currency || transaction.expectedAmountMinor !== input.amountMinor) {
      throw new CommerceContractError('COMMERCE_PAYMENT_TRANSACTION_MISMATCH')
    }
    const existing = paymentByTransaction(db, input.transactionId)
    if (existing) {
      if (existing.providerRequestId !== input.providerRequestId || existing.approvalId !== input.approvalId
        || existing.currency !== input.currency || existing.amountMinor !== input.amountMinor) {
        throw new CommerceContractError('COMMERCE_PAYMENT_REPLAY_MISMATCH')
      }
      return existing
    }
    const id = `payment-${stableId({ providerRequestId: input.providerRequestId, transactionId: input.transactionId })}`
    db.prepare(`INSERT INTO commerce_payment_attempts(id,transaction_id,provider_request_id,approval_id,
      method_label,method_fingerprint,currency,amount_minor,state,provider_receipt_id,evidence_digest,
      version,created_at,updated_at,completed_at) VALUES(?,?,?,?,NULL,NULL,?,?,'approval_required',NULL,NULL,1,?,?,NULL)`).run(
      id, input.transactionId, input.providerRequestId, input.approvalId, input.currency, input.amountMinor,
      createdAt, createdAt,
    )
    return required(paymentByTransaction(db, input.transactionId), 'COMMERCE_PAYMENT_CREATE_FAILED')
  })
}

export function getCommercePaymentAttempt(paymentId: string): CommercePaymentAttempt | null {
  validateId(paymentId, 'COMMERCE_PAYMENT_ID_INVALID')
  return withCommerceAutonomyDb(db => paymentById(db, paymentId))
}

export function getCommercePaymentAttemptByTransaction(transactionId: string): CommercePaymentAttempt | null {
  validateId(transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  return withCommerceAutonomyDb(db => paymentByTransaction(db, transactionId))
}

export function transitionCommercePaymentAttempt(input: TransitionCommercePaymentAttemptInput): CommercePaymentAttempt {
  validateId(input.paymentId, 'COMMERCE_PAYMENT_ID_INVALID')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new CommerceContractError('COMMERCE_PAYMENT_VERSION_INVALID')
  }
  if (input.providerReceiptId !== undefined && input.providerReceiptId !== null) {
    validateId(input.providerReceiptId, 'COMMERCE_PAYMENT_RECEIPT_ID_INVALID')
  }
  if (input.evidenceDigest !== undefined && input.evidenceDigest !== null && !isCommerceDigest(input.evidenceDigest)) {
    throw new CommerceContractError('COMMERCE_DIGEST_INVALID')
  }
  const updatedAt = normalizedTimestamp(input.updatedAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const current = required(paymentById(db, input.paymentId), 'COMMERCE_PAYMENT_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new CommerceContractError('COMMERCE_PAYMENT_VERSION_CONFLICT')
    if (current.providerReceiptId && input.providerReceiptId !== undefined
      && input.providerReceiptId !== current.providerReceiptId) {
      throw new CommerceContractError('COMMERCE_PAYMENT_RECEIPT_SUBSTITUTION')
    }
    const result = db.prepare(`UPDATE commerce_payment_attempts SET state=?,provider_receipt_id=?,evidence_digest=?,
      version=version+1,updated_at=?,completed_at=? WHERE id=? AND version=?`).run(
      input.state,
      input.providerReceiptId === undefined ? current.providerReceiptId : input.providerReceiptId,
      input.evidenceDigest === undefined ? current.evidenceDigest : input.evidenceDigest,
      updatedAt, input.completedAt === undefined ? current.completedAt : input.completedAt,
      current.id, current.version,
    )
    if (result.changes !== 1) throw new CommerceContractError('COMMERCE_PAYMENT_VERSION_CONFLICT')
    return required(paymentById(db, current.id), 'COMMERCE_PAYMENT_UPDATE_FAILED')
  })
}

export function recordCommerceDeliveryObservation(
  input: RecordCommerceDeliveryInput,
): CommerceDeliveryObservation {
  validateId(input.transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  validateId(input.providerEventId, 'COMMERCE_PROVIDER_EVENT_ID_INVALID')
  if (!isCommerceDeliveryState(input.state)) throw new CommerceContractError('COMMERCE_DELIVERY_STATE_INVALID')
  if (!isCommerceDigest(input.evidenceDigest)) throw new CommerceContractError('COMMERCE_DIGEST_INVALID')
  validateTimestamp(input.observedAt, 'COMMERCE_TIME_INVALID')
  if (input.etaAt !== null) validateTimestamp(input.etaAt, 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const transaction = required(transactionById(db, input.transactionId), 'COMMERCE_TRANSACTION_NOT_FOUND')
    if (!transaction.providerOrderId) throw new CommerceContractError('COMMERCE_ORDER_ID_MISSING')
    const existing = deliveryByEvent(db, transaction.id, input.providerEventId)
    const expected = { evidenceDigest: input.evidenceDigest, etaAt: input.etaAt, observedAt: input.observedAt,
      providerEventId: input.providerEventId, state: input.state, transactionId: transaction.id }
    if (existing) {
      if (commerceCanonicalDigest(existing) !== commerceCanonicalDigest({ ...expected, id: existing.id,
        createdAt: existing.createdAt })) throw new CommerceContractError('COMMERCE_DELIVERY_EVENT_REPLAY_MISMATCH')
      return existing
    }
    const latest = latestDelivery(db, transaction.id)
    if (latest && (Date.parse(input.observedAt) < Date.parse(latest.observedAt)
      || !legalDeliveryProgress(latest.state, input.state))) {
      throw new CommerceContractError('COMMERCE_DELIVERY_STATE_STALE')
    }
    const id = `delivery-${stableId({ providerEventId: input.providerEventId, transactionId: transaction.id })}`
    db.prepare(`INSERT INTO commerce_delivery_observations(id,transaction_id,provider_event_id,state,eta_at,
      evidence_digest,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      id, transaction.id, input.providerEventId, input.state, input.etaAt,
      input.evidenceDigest, input.observedAt, input.observedAt,
    )
    return required(deliveryByEvent(db, transaction.id, input.providerEventId), 'COMMERCE_DELIVERY_CREATE_FAILED')
  })
}

export function getLatestCommerceDeliveryObservation(transactionId: string): CommerceDeliveryObservation | null {
  validateId(transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  return withCommerceAutonomyDb(db => latestDelivery(db, transactionId))
}

export function createCommerceCancellationRequest(
  input: CreateCommerceCancellationInput,
): CommerceCancellationRequest {
  validateId(input.transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  if (!TOKEN.test(input.providerRequestId) || !isCommerceErrorCode(input.reasonCode)) {
    throw new CommerceContractError('COMMERCE_CANCELLATION_INPUT_INVALID')
  }
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const transaction = required(transactionById(db, input.transactionId), 'COMMERCE_TRANSACTION_NOT_FOUND')
    const existing = cancellationByRequest(db, transaction.id, input.providerRequestId)
    if (existing) {
      if (existing.reasonCode !== input.reasonCode) {
        throw new CommerceContractError('COMMERCE_CANCELLATION_REPLAY_MISMATCH')
      }
      return existing
    }
    if (!transaction.providerOrderId || !['order_pending', 'waiting_payment', 'paid', 'fulfilling'].includes(transaction.state)) {
      throw new CommerceContractError('COMMERCE_CANCELLATION_NOT_ELIGIBLE')
    }
    const eligibilityDigest = transactionEligibilityDigest(transaction, 'cancel')
    const id = `cancellation-${stableId({ providerRequestId: input.providerRequestId,
      transactionId: transaction.id })}`
    db.prepare(`INSERT INTO commerce_cancellation_requests(id,transaction_id,provider_request_id,reason_code,
      eligibility_digest,state,provider_receipt_id,version,created_at,updated_at,completed_at)
      VALUES(?,?,?,?,?,'requested',NULL,1,?,?,NULL)`).run(
      id, transaction.id, input.providerRequestId, input.reasonCode, eligibilityDigest, createdAt, createdAt,
    )
    return required(cancellationByRequest(db, transaction.id, input.providerRequestId),
      'COMMERCE_CANCELLATION_CREATE_FAILED')
  })
}

export function getCommerceCancellationRequest(
  transactionId: string,
  providerRequestId: string,
): CommerceCancellationRequest | null {
  validateId(transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  if (!TOKEN.test(providerRequestId)) throw new CommerceContractError('COMMERCE_PROVIDER_REQUEST_ID_INVALID')
  return withCommerceAutonomyDb(db => cancellationByRequest(db, transactionId, providerRequestId))
}

export function transitionCommerceCancellationRequest(
  input: TransitionCommerceCancellationInput,
): CommerceCancellationRequest {
  validateId(input.requestId, 'COMMERCE_CANCELLATION_ID_INVALID')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || !isCommerceCancellationState(input.state)) {
    throw new CommerceContractError('COMMERCE_CANCELLATION_TRANSITION_INVALID')
  }
  if (input.providerReceiptId !== undefined && input.providerReceiptId !== null) {
    validateId(input.providerReceiptId, 'COMMERCE_RECEIPT_ID_INVALID')
  }
  if (input.completedAt !== undefined && input.completedAt !== null) validateTimestamp(input.completedAt, 'COMMERCE_TIME_INVALID')
  const updatedAt = normalizedTimestamp(input.updatedAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const current = required(cancellationById(db, input.requestId), 'COMMERCE_CANCELLATION_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new CommerceContractError('COMMERCE_CANCELLATION_VERSION_CONFLICT')
    if (current.providerReceiptId && input.providerReceiptId !== undefined
      && current.providerReceiptId !== input.providerReceiptId) {
      throw new CommerceContractError('COMMERCE_CANCELLATION_RECEIPT_SUBSTITUTION')
    }
    const result = db.prepare(`UPDATE commerce_cancellation_requests SET state=?,provider_receipt_id=?,
      version=version+1,updated_at=?,completed_at=? WHERE id=? AND version=?`).run(
      input.state, input.providerReceiptId === undefined ? current.providerReceiptId : input.providerReceiptId,
      updatedAt, input.completedAt === undefined ? current.completedAt : input.completedAt,
      current.id, current.version,
    )
    if (result.changes !== 1) throw new CommerceContractError('COMMERCE_CANCELLATION_VERSION_CONFLICT')
    return required(cancellationById(db, current.id), 'COMMERCE_CANCELLATION_UPDATE_FAILED')
  })
}

export function createCommerceRefundRequest(input: CreateCommerceRefundInput): CommerceRefundRequest {
  validateId(input.transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  if (!TOKEN.test(input.providerRequestId) || !isCommerceErrorCode(input.reasonCode)
    || !isCommerceCurrency(input.currency)) throw new CommerceContractError('COMMERCE_REFUND_INPUT_INVALID')
  validateMoneyInteger(input.amountMinor)
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const transaction = required(transactionById(db, input.transactionId), 'COMMERCE_TRANSACTION_NOT_FOUND')
    const existing = refundByRequest(db, transaction.id, input.providerRequestId)
    if (existing) {
      if (existing.reasonCode !== input.reasonCode || existing.currency !== input.currency
        || existing.expectedAmountMinor !== input.amountMinor) {
        throw new CommerceContractError('COMMERCE_REFUND_REPLAY_MISMATCH')
      }
      return existing
    }
    const charged = transaction.actualAmountMinor ?? transaction.expectedAmountMinor
    if (!transaction.providerOrderId || !['paid', 'fulfilling', 'delivered', 'cancelled'].includes(transaction.state)
      || transaction.currency !== input.currency || input.amountMinor > charged) {
      throw new CommerceContractError('COMMERCE_REFUND_NOT_ELIGIBLE')
    }
    const eligibilityDigest = transactionEligibilityDigest(transaction, 'refund')
    const id = `refund-${stableId({ providerRequestId: input.providerRequestId, transactionId: transaction.id })}`
    db.prepare(`INSERT INTO commerce_refund_requests(id,transaction_id,provider_request_id,reason_code,currency,
      expected_amount_minor,actual_amount_minor,eligibility_digest,state,provider_receipt_id,version,
      created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,NULL,?,'requested',NULL,1,?,?,NULL)`).run(
      id, transaction.id, input.providerRequestId, input.reasonCode, input.currency, input.amountMinor,
      eligibilityDigest, createdAt, createdAt,
    )
    return required(refundByRequest(db, transaction.id, input.providerRequestId), 'COMMERCE_REFUND_CREATE_FAILED')
  })
}

export function getCommerceRefundRequest(
  transactionId: string,
  providerRequestId: string,
): CommerceRefundRequest | null {
  validateId(transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  if (!TOKEN.test(providerRequestId)) throw new CommerceContractError('COMMERCE_PROVIDER_REQUEST_ID_INVALID')
  return withCommerceAutonomyDb(db => refundByRequest(db, transactionId, providerRequestId))
}

export function transitionCommerceRefundRequest(input: TransitionCommerceRefundInput): CommerceRefundRequest {
  validateId(input.requestId, 'COMMERCE_REFUND_ID_INVALID')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !isCommerceRefundState(input.state)) {
    throw new CommerceContractError('COMMERCE_REFUND_TRANSITION_INVALID')
  }
  if (input.providerReceiptId !== undefined && input.providerReceiptId !== null) {
    validateId(input.providerReceiptId, 'COMMERCE_RECEIPT_ID_INVALID')
  }
  if (input.actualAmountMinor !== undefined && input.actualAmountMinor !== null) validateMoneyInteger(input.actualAmountMinor)
  if (input.completedAt !== undefined && input.completedAt !== null) validateTimestamp(input.completedAt, 'COMMERCE_TIME_INVALID')
  const updatedAt = normalizedTimestamp(input.updatedAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const current = required(refundById(db, input.requestId), 'COMMERCE_REFUND_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new CommerceContractError('COMMERCE_REFUND_VERSION_CONFLICT')
    const actual = input.actualAmountMinor === undefined ? current.actualAmountMinor : input.actualAmountMinor
    if (actual !== null && actual > current.expectedAmountMinor) throw new CommerceContractError('COMMERCE_REFUND_AMOUNT_INCREASED')
    if (current.providerReceiptId && input.providerReceiptId !== undefined
      && current.providerReceiptId !== input.providerReceiptId) throw new CommerceContractError('COMMERCE_REFUND_RECEIPT_SUBSTITUTION')
    const result = db.prepare(`UPDATE commerce_refund_requests SET state=?,provider_receipt_id=?,actual_amount_minor=?,
      version=version+1,updated_at=?,completed_at=? WHERE id=? AND version=?`).run(
      input.state, input.providerReceiptId === undefined ? current.providerReceiptId : input.providerReceiptId,
      actual, updatedAt, input.completedAt === undefined ? current.completedAt : input.completedAt,
      current.id, current.version,
    )
    if (result.changes !== 1) throw new CommerceContractError('COMMERCE_REFUND_VERSION_CONFLICT')
    return required(refundById(db, current.id), 'COMMERCE_REFUND_UPDATE_FAILED')
  })
}

export function transitionCommerceTransaction(input: TransitionCommerceTransactionInput): CommerceTransaction {
  validateId(input.transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new CommerceContractError('COMMERCE_TRANSACTION_VERSION_INVALID')
  }
  const updatedAt = normalizedTimestamp(input.updatedAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  if (input.providerOrderId !== undefined && input.providerOrderId !== null) validateId(input.providerOrderId, 'COMMERCE_ORDER_ID_INVALID')
  if (input.actualAmountMinor !== undefined && input.actualAmountMinor !== null) validateMoneyInteger(input.actualAmountMinor)
  if (input.completedAt !== undefined && input.completedAt !== null) validateTimestamp(input.completedAt, 'COMMERCE_TIME_INVALID')
  return withCommerceAutonomyDb(db => {
    const current = required(transactionById(db, input.transactionId), 'COMMERCE_TRANSACTION_NOT_FOUND')
    if (current.version !== input.expectedVersion) throw new CommerceContractError('COMMERCE_TRANSACTION_VERSION_CONFLICT')
    if (!isLegalCommerceTransactionTransition(current.state, input.state)) {
      throw new CommerceContractError('COMMERCE_TRANSACTION_TRANSITION_INVALID')
    }
    if (input.actualAmountMinor !== undefined && input.actualAmountMinor !== null
      && input.actualAmountMinor > current.expectedAmountMinor) {
      throw new CommerceContractError('COMMERCE_TRANSACTION_AMOUNT_INCREASED')
    }
    const providerOrderId = input.providerOrderId === undefined ? current.providerOrderId : input.providerOrderId
    if (current.providerOrderId && providerOrderId !== current.providerOrderId) {
      throw new CommerceContractError('COMMERCE_ORDER_ID_SUBSTITUTION')
    }
    const actualAmount = input.actualAmountMinor === undefined ? current.actualAmountMinor : input.actualAmountMinor
    const completedAt = input.completedAt === undefined ? current.completedAt : input.completedAt
    const result = db.prepare(`UPDATE commerce_transactions SET state=?,provider_order_id=?,actual_amount_minor=?,
      version=version+1,updated_at=?,completed_at=? WHERE id=? AND version=?`).run(
      input.state, providerOrderId, actualAmount, updatedAt, completedAt, current.id, current.version,
    )
    if (result.changes !== 1) throw new CommerceContractError('COMMERCE_TRANSACTION_VERSION_CONFLICT')
    return required(transactionById(db, current.id), 'COMMERCE_TRANSACTION_UPDATE_FAILED')
  })
}

export function appendCommerceCheckpoint(input: {
  transactionId: string
  stage: string
  evidenceDigest?: string | null
  errorCode?: string | null
  details?: Record<string, unknown>
  observedAt?: string
}): CommerceCheckpoint {
  validateId(input.transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(input.stage)) throw new CommerceContractError('COMMERCE_CHECKPOINT_STAGE_INVALID')
  if (input.evidenceDigest !== undefined && input.evidenceDigest !== null && !isCommerceDigest(input.evidenceDigest)) {
    throw new CommerceContractError('COMMERCE_DIGEST_INVALID')
  }
  if (input.errorCode !== undefined && input.errorCode !== null && !isCommerceErrorCode(input.errorCode)) {
    throw new CommerceContractError('COMMERCE_ERROR_CODE_INVALID')
  }
  const details = input.details ?? {}
  assertCommerceSafeData(details)
  const observedAt = normalizedTimestamp(input.observedAt ?? new Date().toISOString(), 'COMMERCE_TIME_INVALID')
  const detailsJson = canonicalJson(details)
  return withCommerceAutonomyDb(db => {
    required(transactionById(db, input.transactionId), 'COMMERCE_TRANSACTION_NOT_FOUND')
    const duplicate = db.prepare(`SELECT * FROM commerce_checkpoints WHERE transaction_id=? AND stage=?
      AND evidence_digest IS ? AND error_code IS ? AND details_json=? ORDER BY ordinal DESC LIMIT 1`).get(
      input.transactionId, input.stage, input.evidenceDigest ?? null, input.errorCode ?? null, detailsJson,
    ) as CheckpointRow | undefined
    if (duplicate) return checkpointFromRow(duplicate)
    const ordinal = Number((db.prepare(
      'SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM commerce_checkpoints WHERE transaction_id=?',
    ).get(input.transactionId) as { ordinal: number }).ordinal)
    db.prepare(`INSERT INTO commerce_checkpoints(transaction_id,ordinal,stage,evidence_digest,error_code,
      details_json,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      input.transactionId, ordinal, input.stage, input.evidenceDigest ?? null, input.errorCode ?? null,
      detailsJson, observedAt, observedAt,
    )
    return checkpointFromRow(required(db.prepare(
      'SELECT * FROM commerce_checkpoints WHERE transaction_id=? AND ordinal=?',
    ).get(input.transactionId, ordinal) as CheckpointRow | undefined, 'COMMERCE_CHECKPOINT_CREATE_FAILED'))
  })
}

export function listCommerceCheckpoints(transactionId: string, limit = 100): CommerceCheckpoint[] {
  validateId(transactionId, 'COMMERCE_TRANSACTION_ID_INVALID')
  const bounded = listLimit(limit)
  return withCommerceAutonomyDb(db => (db.prepare(`SELECT * FROM commerce_checkpoints WHERE transaction_id=?
    ORDER BY ordinal LIMIT ?`).all(transactionId, bounded) as unknown as CheckpointRow[]).map(checkpointFromRow))
}

function validateAccountInput(input: CreateCommerceAccountInput): void {
  validateId(input.id, 'COMMERCE_ACCOUNT_ID_INVALID')
  if (!isCommerceProviderKind(input.provider) || !isCommerceExecutionMode(input.mode) || input.mode === 'live'
    || !isCommerceCurrency(input.currency) || (input.executorId !== undefined && input.executorId !== null
      && !isCommerceSemanticId(input.executorId)) || !cleanText(input.displayName, 160)) {
    throw new CommerceContractError('COMMERCE_ACCOUNT_INPUT_INVALID')
  }
}

function validateOfferInput(input: RecordCommerceOfferInput): void {
  for (const [value, code] of [[input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID'],
    [input.providerOfferId, 'COMMERCE_OFFER_ID_INVALID'], [input.productId, 'COMMERCE_PRODUCT_ID_INVALID'],
    [input.skuId, 'COMMERCE_SKU_ID_INVALID'], [input.merchantId, 'COMMERCE_MERCHANT_ID_INVALID']] as const) validateId(value, code)
  if (!isCommerceProviderKind(input.provider) || !isCommerceCurrency(input.currency)
    || !cleanText(input.merchantName, 200) || !cleanText(input.title, 500) || !cleanText(input.unitLabel, 80)
    || typeof input.available !== 'boolean' || !Number.isSafeInteger(input.maxQuantity)
    || input.maxQuantity < 0 || input.maxQuantity > 9_999 || !isCommerceFulfillmentKind(input.fulfillment)
    || (input.fulfillmentMinutes !== null && (!Number.isSafeInteger(input.fulfillmentMinutes)
      || input.fulfillmentMinutes < 0 || input.fulfillmentMinutes > 525_600)) || !isCommerceDigest(input.sourceDigest)) {
    throw new CommerceContractError('COMMERCE_OFFER_INPUT_INVALID')
  }
  validateMoneyInteger(input.unitPriceMinor)
  const observed = normalizedTimestamp(input.observedAt, 'COMMERCE_OFFER_TIME_INVALID')
  const expires = normalizedTimestamp(input.expiresAt, 'COMMERCE_OFFER_TIME_INVALID')
  if (Date.parse(expires) <= Date.parse(observed)) throw new CommerceContractError('COMMERCE_OFFER_TIME_INVALID')
}

function validateComparisonInput(input: CreateCommerceComparisonInput): void {
  validateId(input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  if (input.selectedOfferSnapshotId !== null) validateId(input.selectedOfferSnapshotId, 'COMMERCE_OFFER_ID_INVALID')
}

function normalizedRequirement(value: CommerceComparisonRequirement): CommerceComparisonRequirement {
  if (!cleanText(value.query, 200) || !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 9_999
    || (value.maxTotalMinor !== null && (!Number.isSafeInteger(value.maxTotalMinor) || value.maxTotalMinor < 0))
    || (value.deliveryBefore !== null && !validTimestamp(value.deliveryBefore))) {
    throw new CommerceContractError('COMMERCE_COMPARISON_REQUIREMENT_INVALID')
  }
  const excludedMerchantIds = sortedUniqueIds(value.excludedMerchantIds, 'COMMERCE_MERCHANT_ID_INVALID')
  const preferenceCodes = sortedUniqueIds(value.preferenceCodes, 'COMMERCE_PREFERENCE_CODE_INVALID')
  const normalized = { query: value.query, quantity: value.quantity, maxTotalMinor: value.maxTotalMinor,
    deliveryBefore: value.deliveryBefore, excludedMerchantIds, preferenceCodes }
  assertCommerceSafeData(normalized)
  return normalized
}

function normalizedCandidates(value: CommerceComparisonCandidate[]): CommerceComparisonCandidate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new CommerceContractError('COMMERCE_COMPARISON_CANDIDATES_INVALID')
  }
  const ids = new Set<string>()
  const normalized = value.map(candidate => {
    validateId(candidate.offerSnapshotId, 'COMMERCE_OFFER_ID_INVALID')
    if (ids.has(candidate.offerSnapshotId) || typeof candidate.eligible !== 'boolean'
      || (candidate.score !== null && (!Number.isSafeInteger(candidate.score) || candidate.score < 0 || candidate.score > 1_000_000))
      || !Number.isSafeInteger(candidate.priceMinor) || candidate.priceMinor < 0
      || (candidate.fulfillmentMinutes !== null && (!Number.isSafeInteger(candidate.fulfillmentMinutes)
        || candidate.fulfillmentMinutes < 0 || candidate.fulfillmentMinutes > 525_600))) {
      throw new CommerceContractError('COMMERCE_COMPARISON_CANDIDATES_INVALID')
    }
    ids.add(candidate.offerSnapshotId)
    return { ...candidate, exclusionCodes: sortedUniqueIds(candidate.exclusionCodes, 'COMMERCE_REASON_CODE_INVALID'),
      rationaleCodes: sortedUniqueIds(candidate.rationaleCodes, 'COMMERCE_REASON_CODE_INVALID') }
  }).sort((left, right) => compareCodeUnits(left.offerSnapshotId, right.offerSnapshotId))
  assertCommerceSafeData(normalized)
  return normalized
}

function validateComparisonOffers(
  db: DatabaseSync,
  accountId: string,
  candidates: CommerceComparisonCandidate[],
  selected: string | null,
): void {
  for (const candidate of candidates) {
    const offer = required(offerById(db, candidate.offerSnapshotId), 'COMMERCE_OFFER_NOT_FOUND')
    if (offer.accountId !== accountId || offer.money.amountMinor !== candidate.priceMinor) {
      throw new CommerceContractError('COMMERCE_COMPARISON_OFFER_MISMATCH')
    }
  }
  if (selected !== null) {
    const chosen = candidates.find(candidate => candidate.offerSnapshotId === selected)
    if (!chosen?.eligible) throw new CommerceContractError('COMMERCE_COMPARISON_SELECTION_INVALID')
  }
}

function normalizedCartItems(value: CommerceCartItem[]): CommerceCartItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new CommerceContractError('COMMERCE_CART_INPUT_INVALID')
  const ids = new Set<string>()
  return value.map(item => {
    validateId(item.offerSnapshotId, 'COMMERCE_OFFER_ID_INVALID')
    if (ids.has(item.offerSnapshotId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 9_999) {
      throw new CommerceContractError('COMMERCE_CART_INPUT_INVALID')
    }
    ids.add(item.offerSnapshotId)
    return { offerSnapshotId: item.offerSnapshotId, quantity: item.quantity }
  }).sort((left, right) => compareCodeUnits(left.offerSnapshotId, right.offerSnapshotId))
}

function validateQuoteInput(input: CreateCommerceQuoteInput): void {
  validateId(input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  validateId(input.cartRevisionId, 'COMMERCE_CART_ID_INVALID')
  validateId(input.providerQuoteId, 'COMMERCE_PROVIDER_QUOTE_ID_INVALID')
  if (!isCommerceCurrency(input.currency)) throw new CommerceContractError('COMMERCE_CURRENCY_INVALID')
  const parts = [input.breakdown.itemsMinor, input.breakdown.deliveryMinor, input.breakdown.serviceMinor,
    input.breakdown.taxMinor, input.breakdown.discountMinor, input.breakdown.totalMinor]
  parts.forEach(validateMoneyInteger)
  const expected = input.breakdown.itemsMinor + input.breakdown.deliveryMinor + input.breakdown.serviceMinor
    + input.breakdown.taxMinor - input.breakdown.discountMinor
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== input.breakdown.totalMinor) {
    throw new CommerceContractError('COMMERCE_QUOTE_TOTAL_INVALID')
  }
  const observed = normalizedTimestamp(input.observedAt, 'COMMERCE_QUOTE_TIME_INVALID')
  const expires = normalizedTimestamp(input.expiresAt, 'COMMERCE_QUOTE_TIME_INVALID')
  if (Date.parse(expires) <= Date.parse(observed)) throw new CommerceContractError('COMMERCE_QUOTE_TIME_INVALID')
}

function validateTransactionInput(input: CreateCommerceTransactionInput): void {
  if (!WORKFLOW_ID.test(input.workflowId) || !INTENT_ID.test(input.intentId)) {
    throw new CommerceContractError('COMMERCE_WORKFLOW_ID_INVALID')
  }
  validateId(input.accountId, 'COMMERCE_ACCOUNT_ID_INVALID')
  validateId(input.quoteId, 'COMMERCE_QUOTE_ID_INVALID')
  if (!TOKEN.test(input.providerRequestId)) throw new CommerceContractError('COMMERCE_PROVIDER_REQUEST_ID_INVALID')
}

function offerMaterial(input: RecordCommerceOfferInput): Record<string, unknown> {
  return { accountId: input.accountId, available: input.available, currency: input.currency,
    expiresAt: input.expiresAt, fulfillment: input.fulfillment, fulfillmentMinutes: input.fulfillmentMinutes,
    maxQuantity: input.maxQuantity, merchantId: input.merchantId, merchantName: input.merchantName,
    observedAt: input.observedAt, productId: input.productId, provider: input.provider,
    providerOfferId: input.providerOfferId, skuId: input.skuId, sourceDigest: input.sourceDigest,
    title: input.title, unitLabel: input.unitLabel, unitPriceMinor: input.unitPriceMinor }
}

function offerMaterialFromRecord(input: CommerceOfferSnapshot): Record<string, unknown> {
  return { ...offerMaterial({ ...input, accountId: input.accountId, currency: input.money.currency,
    unitPriceMinor: input.money.amountMinor }) }
}

function accountById(db: DatabaseSync, id: string): CommerceProviderAccount | null {
  const row = db.prepare('SELECT * FROM commerce_accounts WHERE id=?').get(id) as AccountRow | undefined
  return row ? accountFromRow(row) : null
}

function offerById(db: DatabaseSync, id: string): CommerceOfferSnapshot | null {
  const row = db.prepare('SELECT * FROM commerce_offer_snapshots WHERE id=?').get(id) as OfferRow | undefined
  return row ? offerFromRow(row) : null
}

function comparisonByDigest(db: DatabaseSync, accountId: string, digest: string): CommerceComparison | null {
  const row = db.prepare('SELECT * FROM commerce_comparisons WHERE account_id=? AND input_digest=?')
    .get(accountId, digest) as ComparisonRow | undefined
  return row ? comparisonFromRow(row) : null
}

function cartById(db: DatabaseSync, id: string): CommerceCartRevision | null {
  const row = db.prepare('SELECT * FROM commerce_cart_revisions WHERE id=?').get(id) as CartRow | undefined
  return row ? cartFromRow(row) : null
}

function cartByDigest(db: DatabaseSync, accountId: string, digest: string): CommerceCartRevision | null {
  const row = db.prepare('SELECT * FROM commerce_cart_revisions WHERE account_id=? AND content_digest=?')
    .get(accountId, digest) as CartRow | undefined
  return row ? cartFromRow(row) : null
}

function quoteById(db: DatabaseSync, id: string): CommerceQuote | null {
  const row = db.prepare('SELECT * FROM commerce_quotes WHERE id=?').get(id) as QuoteRow | undefined
  return row ? quoteFromRow(row) : null
}

function quoteByDigest(db: DatabaseSync, accountId: string, digest: string): CommerceQuote | null {
  const row = db.prepare('SELECT * FROM commerce_quotes WHERE account_id=? AND quote_digest=?')
    .get(accountId, digest) as QuoteRow | undefined
  return row ? quoteFromRow(row) : null
}

function transactionById(db: DatabaseSync, id: string): CommerceTransaction | null {
  const row = db.prepare('SELECT * FROM commerce_transactions WHERE id=?').get(id) as TransactionRow | undefined
  return row ? transactionFromRow(row) : null
}

function transactionByWorkflow(db: DatabaseSync, workflowId: string): CommerceTransaction | null {
  const row = db.prepare('SELECT * FROM commerce_transactions WHERE workflow_id=?').get(workflowId) as TransactionRow | undefined
  return row ? transactionFromRow(row) : null
}

function paymentById(db: DatabaseSync, id: string): CommercePaymentAttempt | null {
  const row = db.prepare('SELECT * FROM commerce_payment_attempts WHERE id=?').get(id) as PaymentRow | undefined
  return row ? paymentFromRow(row) : null
}

function paymentByTransaction(db: DatabaseSync, transactionId: string): CommercePaymentAttempt | null {
  const row = db.prepare('SELECT * FROM commerce_payment_attempts WHERE transaction_id=? ORDER BY created_at,id LIMIT 1')
    .get(transactionId) as PaymentRow | undefined
  return row ? paymentFromRow(row) : null
}

function deliveryByEvent(
  db: DatabaseSync,
  transactionId: string,
  providerEventId: string,
): CommerceDeliveryObservation | null {
  const row = db.prepare(`SELECT * FROM commerce_delivery_observations
    WHERE transaction_id=? AND provider_event_id=?`).get(transactionId, providerEventId) as DeliveryRow | undefined
  return row ? deliveryFromRow(row) : null
}

function latestDelivery(db: DatabaseSync, transactionId: string): CommerceDeliveryObservation | null {
  const row = db.prepare(`SELECT * FROM commerce_delivery_observations WHERE transaction_id=?
    ORDER BY observed_at DESC,id DESC LIMIT 1`).get(transactionId) as DeliveryRow | undefined
  return row ? deliveryFromRow(row) : null
}

function cancellationById(db: DatabaseSync, id: string): CommerceCancellationRequest | null {
  const row = db.prepare('SELECT * FROM commerce_cancellation_requests WHERE id=?').get(id) as CancellationRow | undefined
  return row ? cancellationFromRow(row) : null
}

function cancellationByRequest(
  db: DatabaseSync,
  transactionId: string,
  providerRequestId: string,
): CommerceCancellationRequest | null {
  const row = db.prepare(`SELECT * FROM commerce_cancellation_requests
    WHERE transaction_id=? AND provider_request_id=?`).get(transactionId, providerRequestId) as CancellationRow | undefined
  return row ? cancellationFromRow(row) : null
}

function refundById(db: DatabaseSync, id: string): CommerceRefundRequest | null {
  const row = db.prepare('SELECT * FROM commerce_refund_requests WHERE id=?').get(id) as RefundRow | undefined
  return row ? refundFromRow(row) : null
}

function refundByRequest(
  db: DatabaseSync,
  transactionId: string,
  providerRequestId: string,
): CommerceRefundRequest | null {
  const row = db.prepare(`SELECT * FROM commerce_refund_requests
    WHERE transaction_id=? AND provider_request_id=?`).get(transactionId, providerRequestId) as RefundRow | undefined
  return row ? refundFromRow(row) : null
}

function activationById(db: DatabaseSync, id: string): CommerceActivationReview | null {
  const row = db.prepare('SELECT * FROM commerce_activation_reviews WHERE id=?').get(id) as ActivationRow | undefined
  return row ? activationFromRow(row) : null
}

function accountFromRow(row: AccountRow): CommerceProviderAccount {
  return { id: row.id, provider: row.provider, mode: row.mode, currency: row.currency, executorId: row.executor_id,
    displayName: row.display_name, health: row.health, enabled: row.enabled === 1, policyEpoch: row.policy_epoch,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at }
}

function offerFromRow(row: OfferRow): CommerceOfferSnapshot {
  return { id: row.id, accountId: row.account_id, provider: row.provider, providerOfferId: row.provider_offer_id,
    productId: row.product_id, skuId: row.sku_id, merchantId: row.merchant_id, merchantName: row.merchant_name,
    title: row.title, unitLabel: row.unit_label, money: { currency: row.currency, amountMinor: row.unit_price_minor },
    available: row.available === 1, maxQuantity: row.max_quantity, fulfillment: row.fulfillment,
    fulfillmentMinutes: row.fulfillment_minutes, observedAt: row.observed_at, expiresAt: row.expires_at,
    sourceDigest: row.source_digest }
}

function comparisonFromRow(row: ComparisonRow): CommerceComparison {
  return { id: row.id, accountId: row.account_id,
    requirement: JSON.parse(row.requirement_json) as CommerceComparisonRequirement,
    candidates: JSON.parse(row.candidates_json) as CommerceComparisonCandidate[],
    selectedOfferSnapshotId: row.selected_offer_snapshot_id, inputDigest: row.input_digest, createdAt: row.created_at }
}

function cartFromRow(row: CartRow): CommerceCartRevision {
  return { id: row.id, accountId: row.account_id, revision: row.revision,
    items: JSON.parse(row.items_json) as CommerceCartItem[], destinationToken: row.destination_token,
    recipientToken: row.recipient_token, substitution: row.substitution, contentDigest: row.content_digest,
    createdAt: row.created_at }
}

function quoteFromRow(row: QuoteRow): CommerceQuote {
  return { id: row.id, accountId: row.account_id, cartRevisionId: row.cart_revision_id, cartDigest: row.cart_digest,
    providerQuoteId: row.provider_quote_id, currency: row.currency,
    breakdown: { itemsMinor: row.items_minor, deliveryMinor: row.delivery_minor, serviceMinor: row.service_minor,
      taxMinor: row.tax_minor, discountMinor: row.discount_minor, totalMinor: row.total_minor },
    quoteDigest: row.quote_digest, status: row.status, observedAt: row.observed_at, expiresAt: row.expires_at }
}

function transactionFromRow(row: TransactionRow): CommerceTransaction {
  return { id: row.id, workflowId: row.workflow_id, intentId: row.intent_id, accountId: row.account_id,
    provider: row.provider, mode: row.mode, policyEpoch: row.policy_epoch, quoteId: row.quote_id,
    quoteDigest: row.quote_digest, providerRequestId: row.provider_request_id, providerOrderId: row.provider_order_id,
    currency: row.currency, expectedAmountMinor: row.expected_amount_minor, actualAmountMinor: row.actual_amount_minor,
    state: row.state, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at }
}

function paymentFromRow(row: PaymentRow): CommercePaymentAttempt {
  return { id: row.id, transactionId: row.transaction_id, providerRequestId: row.provider_request_id,
    approvalId: row.approval_id, methodLabel: row.method_label, methodFingerprint: row.method_fingerprint,
    currency: row.currency, amountMinor: row.amount_minor, state: row.state,
    providerReceiptId: row.provider_receipt_id, evidenceDigest: row.evidence_digest, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at }
}

function deliveryFromRow(row: DeliveryRow): CommerceDeliveryObservation {
  return { id: row.id, transactionId: row.transaction_id, providerEventId: row.provider_event_id,
    state: row.state, etaAt: row.eta_at, evidenceDigest: row.evidence_digest,
    observedAt: row.observed_at, createdAt: row.created_at }
}

function cancellationFromRow(row: CancellationRow): CommerceCancellationRequest {
  return { id: row.id, transactionId: row.transaction_id, providerRequestId: row.provider_request_id,
    reasonCode: row.reason_code, eligibilityDigest: row.eligibility_digest, state: row.state,
    providerReceiptId: row.provider_receipt_id, version: row.version, createdAt: row.created_at,
    updatedAt: row.updated_at, completedAt: row.completed_at }
}

function refundFromRow(row: RefundRow): CommerceRefundRequest {
  return { id: row.id, transactionId: row.transaction_id, providerRequestId: row.provider_request_id,
    reasonCode: row.reason_code, currency: row.currency, expectedAmountMinor: row.expected_amount_minor,
    actualAmountMinor: row.actual_amount_minor, eligibilityDigest: row.eligibility_digest, state: row.state,
    providerReceiptId: row.provider_receipt_id, version: row.version, createdAt: row.created_at,
    updatedAt: row.updated_at, completedAt: row.completed_at }
}

function activationFromRow(row: ActivationRow): CommerceActivationReview {
  return { id: row.id, accountId: row.account_id, fromMode: row.from_mode, toMode: row.to_mode,
    actorUserId: row.actor_user_id, shadowEvidenceDigest: row.shadow_evidence_digest,
    limitsDigest: row.limits_digest, approved: row.approved === 1, createdAt: row.created_at }
}

function checkpointFromRow(row: CheckpointRow): CommerceCheckpoint {
  return { transactionId: row.transaction_id, ordinal: row.ordinal, stage: row.stage,
    evidenceDigest: row.evidence_digest, errorCode: row.error_code,
    details: JSON.parse(row.details_json) as Record<string, unknown>, observedAt: row.observed_at, createdAt: row.created_at }
}

function validateId(value: string, code: string): void {
  if (!isCommerceSemanticId(value)) throw new CommerceContractError(code)
}

function validateMoneyInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_MONEY) {
    throw new CommerceContractError('COMMERCE_MONEY_INVALID')
  }
}

function cleanText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value
}

function validateTimestamp(value: unknown, code: string): asserts value is string {
  if (!validTimestamp(value)) throw new CommerceContractError(code)
}

function normalizedTimestamp(value: string, code: string): string {
  validateTimestamp(value, code)
  return value
}

function sortedUniqueIds(values: string[], code: string): string[] {
  if (!Array.isArray(values) || values.length > 64) throw new CommerceContractError(code)
  const normalized = [...values]
  normalized.forEach(value => validateId(value, code))
  normalized.sort(compareCodeUnits)
  if (normalized.some((value, index) => index > 0 && value === normalized[index - 1])) throw new CommerceContractError(code)
  return normalized
}

function listLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST) throw new CommerceContractError('COMMERCE_LIMIT_INVALID')
  return value
}

function stableId(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 32)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compareCodeUnits)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function legalDeliveryProgress(
  previous: CommerceDeliveryObservation['state'],
  next: CommerceDeliveryObservation['state'],
): boolean {
  if (previous === next) return true
  const rank: Record<string, number> = { not_started: 0, preparing: 1, ready: 2, in_transit: 3, delivered: 4 }
  if (previous in rank && next in rank) return rank[next]! > rank[previous]!
  if (['delivered', 'failed', 'cancelled'].includes(previous)) return false
  return ['failed', 'cancelled', 'unknown'].includes(next)
}

function transactionEligibilityDigest(transaction: CommerceTransaction, operation: 'cancel' | 'refund'): string {
  return commerceCanonicalDigest({ operation, transactionId: transaction.id, providerOrderId: transaction.providerOrderId,
    state: transaction.state, version: transaction.version, currency: transaction.currency,
    amountMinor: transaction.actualAmountMinor ?? transaction.expectedAmountMinor })
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function required<T>(value: T | null | undefined, code: string): T {
  if (value === null || value === undefined) throw new CommerceContractError(code)
  return value
}
