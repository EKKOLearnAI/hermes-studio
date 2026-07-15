import {
  ensurePrimarySubject,
  recordTwinFactBatchWithDisposition,
  type TwinEvent,
} from '../personal-twin'
import { CommerceContractError } from './contracts'
import {
  assertCommerceProviderResult,
  CommerceProviderError,
  type CommerceProviderAdapter,
  type CommerceProviderAdjustmentResult,
} from './provider'
import {
  appendCommerceCheckpoint,
  createCommerceCancellationRequest,
  createCommerceRefundRequest,
  getCommerceAccount,
  getCommerceCancellationRequest,
  getCommerceRefundRequest,
  getCommerceTransaction,
  recordCommerceDeliveryObservation,
  transitionCommerceCancellationRequest,
  transitionCommerceRefundRequest,
  transitionCommerceTransaction,
} from './store'
import { CommerceExecutionError } from './transaction-service'
import type {
  CommerceCancellationRequest,
  CommerceDeliveryObservation,
  CommerceRefundRequest,
  CommerceTransaction,
} from './types'

const ACTOR = 'commerce-assistant'

export interface CommerceDeliveryExecutionResult {
  transaction: CommerceTransaction
  observation: CommerceDeliveryObservation
}

export interface CommerceCancellationExecutionResult {
  transaction: CommerceTransaction
  request: CommerceCancellationRequest
  status: 'cancelled' | 'rejected'
}

export interface CommerceRefundExecutionResult {
  transaction: CommerceTransaction
  request: CommerceRefundRequest
  status: 'processing' | 'refunded' | 'rejected'
}

export async function trackShadowCommerceDelivery(input: {
  transactionId: string
  provider: CommerceProviderAdapter
  now: string
}): Promise<CommerceDeliveryExecutionResult> {
  let transaction = requiredShadowTransaction(input.transactionId, input.provider)
  if (!transaction.providerOrderId || !['paid', 'fulfilling', 'delivered', 'cancelled'].includes(transaction.state)) {
    throw executionError('COMMERCE_DELIVERY_NOT_ELIGIBLE', transaction.id)
  }
  const result = await input.provider.trackDelivery({ providerOrderId: transaction.providerOrderId })
  assertCommerceProviderResult('track_delivery', result)
  if (result.providerOrderId !== transaction.providerOrderId) {
    throw executionError('COMMERCE_PROVIDER_DELIVERY_RESULT_INVALID', transaction.id, true)
  }
  const observation = recordCommerceDeliveryObservation({ transactionId: transaction.id,
    providerEventId: result.providerEventId, state: result.state, etaAt: result.etaAt,
    evidenceDigest: result.evidenceDigest, observedAt: result.observedAt })
  if (['preparing', 'ready', 'in_transit'].includes(observation.state) && transaction.state === 'paid') {
    transaction = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: transaction.version,
      state: 'fulfilling', updatedAt: input.now })
  } else if (observation.state === 'delivered' && transaction.state !== 'delivered') {
    if (transaction.state === 'paid') transaction = transitionCommerceTransaction({ transactionId: transaction.id,
      expectedVersion: transaction.version, state: 'fulfilling', updatedAt: input.now })
    if (transaction.state === 'fulfilling') transaction = transitionCommerceTransaction({ transactionId: transaction.id,
      expectedVersion: transaction.version, state: 'delivered', completedAt: input.now, updatedAt: input.now })
  }
  appendCommerceCheckpoint({ transactionId: transaction.id, stage: 'delivery_observed',
    evidenceDigest: observation.evidenceDigest, details: { providerEventId: observation.providerEventId,
      state: observation.state, etaAt: observation.etaAt }, observedAt: observation.observedAt })
  projectOutcome(transaction, 'commerce.delivery.updated', `delivery:${observation.id}`, {
    providerEventId: observation.providerEventId, state: observation.state, etaAt: observation.etaAt,
    evidenceDigest: observation.evidenceDigest,
  }, observation.observedAt)
  return { transaction, observation }
}

export async function executeShadowCommerceCancellation(input: {
  transactionId: string
  providerRequestId: string
  reasonCode: string
  provider: CommerceProviderAdapter
  now: string
}): Promise<CommerceCancellationExecutionResult> {
  let transaction = requiredShadowTransaction(input.transactionId, input.provider)
  let request = createCommerceCancellationRequest({ transactionId: transaction.id,
    providerRequestId: input.providerRequestId, reasonCode: input.reasonCode, createdAt: input.now })
  if (request.state === 'cancelled' || request.state === 'rejected') {
    return cancellationFromRecords(transaction, request)
  }
  if (request.state === 'unknown') request = transitionCommerceCancellationRequest({ requestId: request.id,
    expectedVersion: request.version, state: 'lookup_required', updatedAt: input.now })
  if (['order_pending', 'waiting_payment', 'paid', 'fulfilling'].includes(transaction.state)) {
    transaction = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: transaction.version,
      state: 'cancelling', updatedAt: input.now })
  }
  if (!transaction.providerOrderId || !['cancelling', 'lookup_required', 'cancelled'].includes(transaction.state)) {
    throw executionError('COMMERCE_CANCELLATION_STATE_INVALID', transaction.id)
  }
  return executeCancellationWithLookup(transaction, request, input)
}

export async function executeShadowCommerceRefund(input: {
  transactionId: string
  providerRequestId: string
  reasonCode: string
  currency: string
  amountMinor: number
  provider: CommerceProviderAdapter
  now: string
}): Promise<CommerceRefundExecutionResult> {
  let transaction = requiredShadowTransaction(input.transactionId, input.provider)
  let request = createCommerceRefundRequest({ transactionId: transaction.id,
    providerRequestId: input.providerRequestId, reasonCode: input.reasonCode,
    currency: input.currency, amountMinor: input.amountMinor, createdAt: input.now })
  if (['processing', 'refunded', 'rejected'].includes(request.state)) {
    if (request.state === 'refunded' || request.state === 'rejected') return refundFromRecords(transaction, request)
  }
  if (request.state === 'unknown') request = transitionCommerceRefundRequest({ requestId: request.id,
    expectedVersion: request.version, state: 'lookup_required', updatedAt: input.now })
  if (['paid', 'fulfilling', 'delivered', 'cancelled'].includes(transaction.state)) {
    transaction = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: transaction.version,
      state: 'refunding', updatedAt: input.now })
  }
  if (!transaction.providerOrderId || !['refunding', 'lookup_required'].includes(transaction.state)) {
    throw executionError('COMMERCE_REFUND_STATE_INVALID', transaction.id)
  }
  return executeRefundWithLookup(transaction, request, input)
}

async function executeCancellationWithLookup(
  transaction: CommerceTransaction,
  request: CommerceCancellationRequest,
  input: Parameters<typeof executeShadowCommerceCancellation>[0],
): Promise<CommerceCancellationExecutionResult> {
  let lookup: CommerceProviderAdjustmentResult
  try {
    lookup = await input.provider.lookupCancellation({ providerRequestId: request.providerRequestId,
      providerOrderId: transaction.providerOrderId! })
    assertCommerceProviderResult('lookup_cancellation', lookup)
  } catch (error) {
    throw persistCancellationUncertainty(transaction, request, error, input.now)
  }
  if (lookup.status !== 'not_found') return finalizeCancellation(transaction, request, lookup, input.now)
  try {
    const result = await input.provider.cancelOrder({ providerRequestId: request.providerRequestId,
      providerOrderId: transaction.providerOrderId!, reasonCode: request.reasonCode })
    assertCommerceProviderResult('cancel_order', result)
    return finalizeCancellation(transaction, request, result, input.now)
  } catch (error) {
    try {
      const recovered = await input.provider.lookupCancellation({ providerRequestId: request.providerRequestId,
        providerOrderId: transaction.providerOrderId! })
      assertCommerceProviderResult('lookup_cancellation', recovered)
      if (recovered.status !== 'not_found') return finalizeCancellation(transaction, request, recovered, input.now)
    } catch (lookupError) {
      throw persistCancellationUncertainty(transaction, request, lookupError, input.now)
    }
    throw persistCancellationUncertainty(transaction, request, error, input.now)
  }
}

function finalizeCancellation(
  transaction: CommerceTransaction,
  request: CommerceCancellationRequest,
  result: CommerceProviderAdjustmentResult,
  now: string,
): CommerceCancellationExecutionResult {
  if (result.providerRequestId !== request.providerRequestId || result.providerOrderId !== transaction.providerOrderId
    || !['cancelled', 'rejected'].includes(result.status)
    || result.status === 'cancelled' && (!result.providerReceiptId || !result.receiptDigest)) {
    throw executionError('COMMERCE_PROVIDER_CANCELLATION_RESULT_INVALID', transaction.id, true)
  }
  const state = result.status as 'cancelled' | 'rejected'
  const updatedRequest = transitionCommerceCancellationRequest({ requestId: request.id,
    expectedVersion: request.version, state, providerReceiptId: result.providerReceiptId,
    completedAt: now, updatedAt: now })
  const nextState = state === 'cancelled' ? 'cancelled' : 'waiting_user'
  const updated = transaction.state === nextState ? transaction : transitionCommerceTransaction({
    transactionId: transaction.id, expectedVersion: transaction.version, state: nextState,
    completedAt: state === 'cancelled' ? now : undefined, updatedAt: now,
  })
  appendCommerceCheckpoint({ transactionId: updated.id, stage: `cancellation_${state}`,
    evidenceDigest: result.receiptDigest, details: { providerRequestId: request.providerRequestId,
      providerReceiptId: result.providerReceiptId, status: state }, observedAt: now })
  projectOutcome(updated, 'commerce.cancellation.updated', `cancellation:${updatedRequest.id}`, {
    cancellationRequestId: updatedRequest.id, providerReceiptId: updatedRequest.providerReceiptId,
    status: state, eligibilityDigest: updatedRequest.eligibilityDigest,
  }, now)
  return { transaction: updated, request: updatedRequest, status: state }
}

function persistCancellationUncertainty(
  transaction: CommerceTransaction,
  request: CommerceCancellationRequest,
  error: unknown,
  now: string,
): CommerceExecutionError {
  const providerError = normalizedProviderError(error)
  let updatedRequest = request
  let updated = transaction
  if (request.state === 'requested') updatedRequest = transitionCommerceCancellationRequest({ requestId: request.id,
    expectedVersion: request.version, state: 'lookup_required', updatedAt: now })
  if (transaction.state === 'cancelling') updated = transitionCommerceTransaction({ transactionId: transaction.id,
    expectedVersion: transaction.version, state: 'lookup_required', updatedAt: now })
  appendCommerceCheckpoint({ transactionId: updated.id, stage: 'cancellation_lookup_required',
    errorCode: providerError.code, details: { cancellationRequestId: updatedRequest.id,
      retryable: providerError.retryable, uncertain: true }, observedAt: now })
  return new CommerceExecutionError(providerError.code, providerError.retryable, true, updated.id)
}

async function executeRefundWithLookup(
  transaction: CommerceTransaction,
  request: CommerceRefundRequest,
  input: Parameters<typeof executeShadowCommerceRefund>[0],
): Promise<CommerceRefundExecutionResult> {
  let lookup: CommerceProviderAdjustmentResult
  try {
    lookup = await input.provider.lookupRefund({ providerRequestId: request.providerRequestId,
      providerOrderId: transaction.providerOrderId! })
    assertCommerceProviderResult('lookup_refund', lookup)
  } catch (error) {
    throw persistRefundUncertainty(transaction, request, error, input.now)
  }
  if (lookup.status !== 'not_found') return finalizeRefund(transaction, request, lookup, input.now)
  try {
    const result = await input.provider.requestRefund({ providerRequestId: request.providerRequestId,
      providerOrderId: transaction.providerOrderId!, reasonCode: request.reasonCode,
      currency: request.currency, amountMinor: request.expectedAmountMinor })
    assertCommerceProviderResult('request_refund', result)
    return finalizeRefund(transaction, request, result, input.now)
  } catch (error) {
    try {
      const recovered = await input.provider.lookupRefund({ providerRequestId: request.providerRequestId,
        providerOrderId: transaction.providerOrderId! })
      assertCommerceProviderResult('lookup_refund', recovered)
      if (recovered.status !== 'not_found') return finalizeRefund(transaction, request, recovered, input.now)
    } catch (lookupError) {
      throw persistRefundUncertainty(transaction, request, lookupError, input.now)
    }
    throw persistRefundUncertainty(transaction, request, error, input.now)
  }
}

function finalizeRefund(
  transaction: CommerceTransaction,
  request: CommerceRefundRequest,
  result: CommerceProviderAdjustmentResult,
  now: string,
): CommerceRefundExecutionResult {
  if (result.providerRequestId !== request.providerRequestId || result.providerOrderId !== transaction.providerOrderId
    || !['processing', 'refunded', 'rejected'].includes(result.status)
    || result.status === 'refunded' && (result.currency !== request.currency
      || result.amountMinor !== request.expectedAmountMinor || !result.providerReceiptId || !result.receiptDigest)) {
    throw executionError('COMMERCE_PROVIDER_REFUND_RESULT_INVALID', transaction.id, true)
  }
  const state = result.status as 'processing' | 'refunded' | 'rejected'
  const updatedRequest = request.state === state ? request : transitionCommerceRefundRequest({ requestId: request.id,
    expectedVersion: request.version, state, providerReceiptId: result.providerReceiptId,
    actualAmountMinor: result.amountMinor, completedAt: state === 'processing' ? undefined : now, updatedAt: now })
  let updated = transaction
  if (transaction.state === 'lookup_required' && state === 'processing') updated = transitionCommerceTransaction({
    transactionId: transaction.id, expectedVersion: transaction.version, state: 'refunding', updatedAt: now })
  else if (state === 'refunded') updated = transitionCommerceTransaction({ transactionId: transaction.id,
    expectedVersion: transaction.version, state: 'refunded', completedAt: now, updatedAt: now })
  else if (state === 'rejected') updated = transitionCommerceTransaction({ transactionId: transaction.id,
    expectedVersion: transaction.version, state: 'waiting_user', updatedAt: now })
  appendCommerceCheckpoint({ transactionId: updated.id, stage: `refund_${state}`,
    evidenceDigest: result.receiptDigest, details: { refundRequestId: updatedRequest.id,
      providerReceiptId: result.providerReceiptId, amountMinor: result.amountMinor, status: state }, observedAt: now })
  projectOutcome(updated, 'commerce.refund.updated', `refund:${updatedRequest.id}`, {
    refundRequestId: updatedRequest.id, providerReceiptId: updatedRequest.providerReceiptId,
    amountMinor: updatedRequest.actualAmountMinor, currency: updatedRequest.currency,
    status: state, eligibilityDigest: updatedRequest.eligibilityDigest,
  }, now)
  return { transaction: updated, request: updatedRequest, status: state }
}

function persistRefundUncertainty(
  transaction: CommerceTransaction,
  request: CommerceRefundRequest,
  error: unknown,
  now: string,
): CommerceExecutionError {
  const providerError = normalizedProviderError(error)
  let updatedRequest = request
  let updated = transaction
  if (request.state === 'requested') updatedRequest = transitionCommerceRefundRequest({ requestId: request.id,
    expectedVersion: request.version, state: 'lookup_required', updatedAt: now })
  else if (request.state === 'processing') updatedRequest = transitionCommerceRefundRequest({ requestId: request.id,
    expectedVersion: request.version, state: 'unknown', updatedAt: now })
  if (transaction.state === 'refunding') updated = transitionCommerceTransaction({ transactionId: transaction.id,
    expectedVersion: transaction.version, state: 'lookup_required', updatedAt: now })
  appendCommerceCheckpoint({ transactionId: updated.id, stage: 'refund_lookup_required',
    errorCode: providerError.code, details: { refundRequestId: updatedRequest.id,
      retryable: providerError.retryable, uncertain: true }, observedAt: now })
  return new CommerceExecutionError(providerError.code, providerError.retryable, true, updated.id)
}

function cancellationFromRecords(
  transaction: CommerceTransaction,
  request: CommerceCancellationRequest,
): CommerceCancellationExecutionResult {
  return { transaction, request, status: request.state as 'cancelled' | 'rejected' }
}

function refundFromRecords(transaction: CommerceTransaction, request: CommerceRefundRequest): CommerceRefundExecutionResult {
  return { transaction, request, status: request.state as 'refunded' | 'rejected' }
}

function requiredShadowTransaction(transactionId: string, provider: CommerceProviderAdapter): CommerceTransaction {
  const transaction = getCommerceTransaction(transactionId)
  const account = transaction ? getCommerceAccount(transaction.accountId) : null
  if (!transaction || !account || transaction.mode !== 'shadow' || account.mode !== 'shadow'
    || account.health === 'revoked' || !account.enabled || provider.transport !== 'virtual'
    || provider.provider !== transaction.provider || provider.provider !== account.provider) {
    throw executionError('COMMERCE_TRANSACTION_MATERIAL_MISMATCH', transactionId)
  }
  return transaction
}

function projectOutcome(
  transaction: CommerceTransaction,
  eventType: string,
  sourceId: string,
  payload: Record<string, unknown>,
  occurredAt: string,
): TwinEvent {
  ensurePrimarySubject()
  const batch = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, events: [{
    eventType, subjectId: 'person:self', payload: { schemaVersion: 1, transactionId: transaction.id,
      accountId: transaction.accountId, provider: transaction.provider, mode: transaction.mode, ...payload },
    occurredAt, source: `commerce:${transaction.accountId}`, sourceId, actor: ACTOR,
    confidence: 1, confirmationState: 'confirmed', evidence: [{ kind: 'commerce_transaction',
      transactionId: transaction.id, state: transaction.state }],
  }] }, [{ observationIndexes: [], eventIndexes: [0] }])
  const event = batch.events[0]
  if (!event) throw new Error('COMMERCE_OUTCOME_PROJECTION_INCOMPLETE')
  return event
}

function normalizedProviderError(error: unknown): CommerceProviderError {
  if (error instanceof CommerceProviderError) return error
  if (error instanceof CommerceContractError) return new CommerceProviderError(error.code, false, false, false)
  return new CommerceProviderError('COMMERCE_PROVIDER_RESULT_UNKNOWN', false, true, false)
}

function executionError(code: string, transactionId: string, uncertain = false): CommerceExecutionError {
  return new CommerceExecutionError(code, false, uncertain, transactionId)
}
