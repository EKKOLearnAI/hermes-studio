import { createHash } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  assertCommerceSafeData,
  CommerceContractError,
  isCommerceCurrency,
  isCommerceDigest,
  isCommerceErrorCode,
  isCommerceExecutionMode,
  isCommerceFulfillmentKind,
  isCommerceProviderKind,
  isCommerceSemanticId,
  isLegalCommerceTransactionTransition,
} from './contracts'
import { withCommerceAutonomyDb } from './database'
import type {
  CommerceCartItem,
  CommerceCartRevision,
  CommerceCheckpoint,
  CommerceComparison,
  CommerceComparisonCandidate,
  CommerceComparisonRequirement,
  CommerceOfferSnapshot,
  CommerceProviderAccount,
  CommerceQuote,
  CommerceQuoteBreakdown,
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

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function required<T>(value: T | null | undefined, code: string): T {
  if (value === null || value === undefined) throw new CommerceContractError(code)
  return value
}
