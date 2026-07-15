import { CommerceContractError } from './contracts'
import {
  assertCommerceProviderResult,
  CommerceProviderError,
  type CommerceProviderAdapter,
  type CommerceProviderOrderResult,
  type CommerceProviderPaymentResult,
} from './provider'
import {
  appendCommerceCheckpoint,
  createCommercePaymentAttempt,
  createCommerceTransaction,
  getCommerceAccount,
  getCommercePaymentAttemptByTransaction,
  getCommerceQuote,
  getCommerceTransaction,
  transitionCommercePaymentAttempt,
  transitionCommerceTransaction,
} from './store'
import type { CommercePaymentAttempt, CommerceTransaction } from './types'

export class CommerceExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain: boolean,
    readonly transactionId: string | null,
  ) {
    super(code)
    this.name = 'CommerceExecutionError'
  }
}

export interface CommerceOrderExecutionResult {
  transaction: CommerceTransaction
  providerOrderId: string
  amountMinor: number
  receiptDigest: string
}

export interface CommercePaymentExecutionResult {
  transaction: CommerceTransaction
  payment: CommercePaymentAttempt
  providerReceiptId: string
  receiptDigest: string
  amountMinor: number
}

export async function executeShadowCommerceOrder(input: {
  workflowId: string
  intentId: string
  accountId: string
  quoteId: string
  quoteDigest: string
  providerRequestId: string
  amountMinor: number
  provider: CommerceProviderAdapter
  now: string
}): Promise<CommerceOrderExecutionResult> {
  const account = getCommerceAccount(input.accountId)
  const quote = getCommerceQuote(input.quoteId)
  if (!account || !quote || account.mode === 'observe'
    || account.mode === 'shadow' && input.provider.transport !== 'virtual'
    || account.mode === 'live' && input.provider.transport !== 'external'
    || account.provider !== input.provider.provider || quote.accountId !== account.id
    || quote.quoteDigest !== input.quoteDigest || quote.currency !== account.currency
    || quote.breakdown.totalMinor !== input.amountMinor) {
    throw new CommerceExecutionError('COMMERCE_ORDER_MATERIAL_MISMATCH', false, false, null)
  }
  let transaction = createCommerceTransaction({ workflowId: input.workflowId, intentId: input.intentId,
    accountId: input.accountId, quoteId: input.quoteId, providerRequestId: input.providerRequestId,
    createdAt: input.now })
  if (transaction.mode !== account.mode || transaction.policyEpoch !== account.policyEpoch) {
    throw new CommerceExecutionError('COMMERCE_TRANSACTION_POLICY_STALE', false, false, transaction.id)
  }
  if (hasOrderEffect(transaction)) return orderExecutionFromTransaction(transaction)
  if (transaction.state === 'proposed') transaction = transitionCommerceTransaction({ transactionId: transaction.id,
    expectedVersion: transaction.version, state: 'quoted', updatedAt: input.now })
  if (transaction.state === 'quoted') transaction = transitionCommerceTransaction({ transactionId: transaction.id,
    expectedVersion: transaction.version, state: 'submitting_order', updatedAt: input.now })
  if (!['submitting_order', 'lookup_required'].includes(transaction.state)) {
    throw new CommerceExecutionError('COMMERCE_ORDER_STATE_INVALID', false, false, transaction.id)
  }
  return executeOrderWithLookup(transaction, quote.providerQuoteId, input, input.provider)
}

export async function executeShadowCommercePayment(input: {
  transactionId: string
  quoteDigest: string
  providerRequestId: string
  approvalId: string
  amountMinor: number
  provider: CommerceProviderAdapter
  now: string
}): Promise<CommercePaymentExecutionResult> {
  let transaction = getCommerceTransaction(input.transactionId)
  const account = transaction ? getCommerceAccount(transaction.accountId) : null
  if (!transaction || !account || !transaction.providerOrderId || transaction.quoteDigest !== input.quoteDigest
    || transaction.expectedAmountMinor !== input.amountMinor || transaction.mode !== 'shadow'
      && transaction.mode !== 'live' || account.mode !== transaction.mode || account.policyEpoch !== transaction.policyEpoch
    || transaction.mode === 'shadow' && input.provider.transport !== 'virtual'
    || transaction.mode === 'live' && input.provider.transport !== 'external'
    || input.provider.provider !== transaction.provider) {
    throw new CommerceExecutionError('COMMERCE_PAYMENT_MATERIAL_MISMATCH', false, false, input.transactionId)
  }
  const existingPayment = getCommercePaymentAttemptByTransaction(transaction.id)
  if (existingPayment && (existingPayment.providerRequestId !== input.providerRequestId
    || existingPayment.approvalId !== input.approvalId || existingPayment.currency !== transaction.currency
    || existingPayment.amountMinor !== input.amountMinor)) {
    throw new CommerceExecutionError('COMMERCE_PAYMENT_REPLAY_MISMATCH', false, false, transaction.id)
  }
  if (transaction.state === 'paid' && existingPayment?.state === 'paid') {
    return paymentExecutionFromRecords(transaction, existingPayment)
  }
  if (transaction.state === 'order_pending') transaction = transitionCommerceTransaction({
    transactionId: transaction.id, expectedVersion: transaction.version, state: 'waiting_payment', updatedAt: input.now,
  })
  let payment = createCommercePaymentAttempt({ transactionId: transaction.id,
    providerRequestId: input.providerRequestId, approvalId: input.approvalId,
    currency: transaction.currency, amountMinor: input.amountMinor, createdAt: input.now })
  if (transaction.state === 'waiting_payment') transaction = transitionCommerceTransaction({
    transactionId: transaction.id, expectedVersion: transaction.version, state: 'submitting_payment', updatedAt: input.now,
  })
  if (payment.state === 'approval_required') payment = transitionCommercePaymentAttempt({
    paymentId: payment.id, expectedVersion: payment.version, state: 'submitting', updatedAt: input.now,
  })
  if (!['submitting_payment', 'lookup_required'].includes(transaction.state)
    || !['submitting', 'lookup_required'].includes(payment.state)) {
    throw new CommerceExecutionError('COMMERCE_PAYMENT_STATE_INVALID', false, false, transaction.id)
  }
  return executePaymentWithLookup(transaction, payment, input, input.provider)
}

export const executeCommerceOrder = executeShadowCommerceOrder
export const executeCommercePayment = executeShadowCommercePayment

async function executeOrderWithLookup(
  transaction: CommerceTransaction,
  providerQuoteId: string,
  input: Parameters<typeof executeShadowCommerceOrder>[0],
  provider: CommerceProviderAdapter,
): Promise<CommerceOrderExecutionResult> {
  let lookup: CommerceProviderOrderResult
  try {
    lookup = await provider.lookupOrder({ providerRequestId: transaction.providerRequestId })
    assertCommerceProviderResult('lookup_order', lookup)
  } catch (error) {
    throw await persistOrderUncertainty(transaction, error, input.now)
  }
  if (lookup.status !== 'not_found') return finalizeOrder(transaction, lookup, input.now)
  try {
    const result = await provider.placeOrder({ providerRequestId: transaction.providerRequestId,
      providerQuoteId, quoteDigest: transaction.quoteDigest, currency: transaction.currency,
      amountMinor: transaction.expectedAmountMinor })
    assertCommerceProviderResult('place_order', result)
    return finalizeOrder(transaction, result, input.now)
  } catch (error) {
    try {
      const recovered = await provider.lookupOrder({ providerRequestId: transaction.providerRequestId })
      assertCommerceProviderResult('lookup_order', recovered)
      if (recovered.status !== 'not_found') return finalizeOrder(transaction, recovered, input.now)
    } catch (lookupError) {
      throw await persistOrderUncertainty(transaction, lookupError, input.now)
    }
    throw await persistOrderUncertainty(transaction, error, input.now)
  }
}

function finalizeOrder(
  transaction: CommerceTransaction,
  result: CommerceProviderOrderResult,
  now: string,
): CommerceOrderExecutionResult {
  if (!result.providerOrderId || result.currency !== transaction.currency
    || result.amountMinor === null || result.amountMinor > transaction.expectedAmountMinor || !result.receiptDigest) {
    throw new CommerceExecutionError('COMMERCE_PROVIDER_ORDER_RESULT_INVALID', false, true, transaction.id)
  }
  const updated = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: transaction.version,
    state: result.status === 'paid' ? 'paid' : 'order_pending', providerOrderId: result.providerOrderId,
    actualAmountMinor: result.amountMinor, updatedAt: now })
  appendCommerceCheckpoint({ transactionId: updated.id, stage: 'order_verified', evidenceDigest: result.receiptDigest,
    details: { amountMinor: result.amountMinor, providerOrderId: result.providerOrderId,
      providerRequestId: result.providerRequestId, status: result.status }, observedAt: now })
  return { transaction: updated, providerOrderId: result.providerOrderId,
    amountMinor: result.amountMinor, receiptDigest: result.receiptDigest }
}

async function persistOrderUncertainty(
  transaction: CommerceTransaction,
  error: unknown,
  now: string,
): Promise<CommerceExecutionError> {
  const providerError = normalizedProviderError(error)
  let updated = transaction
  if (transaction.state === 'submitting_order') updated = transitionCommerceTransaction({
    transactionId: transaction.id, expectedVersion: transaction.version, state: 'lookup_required', updatedAt: now,
  })
  appendCommerceCheckpoint({ transactionId: updated.id, stage: 'order_lookup_required',
    errorCode: providerError.code, details: { retryable: providerError.retryable, uncertain: providerError.uncertain },
    observedAt: now })
  return new CommerceExecutionError(providerError.code, providerError.retryable, true, updated.id)
}

async function executePaymentWithLookup(
  transaction: CommerceTransaction,
  payment: CommercePaymentAttempt,
  input: Parameters<typeof executeShadowCommercePayment>[0],
  provider: CommerceProviderAdapter,
): Promise<CommercePaymentExecutionResult> {
  let lookup: CommerceProviderPaymentResult
  try {
    lookup = await provider.lookupPayment({ providerRequestId: payment.providerRequestId,
      providerOrderId: transaction.providerOrderId! })
    assertCommerceProviderResult('lookup_payment', lookup)
  } catch (error) {
    throw await persistPaymentUncertainty(transaction, payment, error, input.now)
  }
  if (lookup.status === 'paid') return finalizePayment(transaction, payment, lookup, input.now)
  if (lookup.status !== 'not_found') {
    throw new CommerceExecutionError('COMMERCE_PAYMENT_DECLINED', false, false, transaction.id)
  }
  try {
    const result = await provider.confirmPayment({ providerRequestId: payment.providerRequestId,
      providerOrderId: transaction.providerOrderId!, approvalId: input.approvalId,
      currency: transaction.currency, amountMinor: input.amountMinor })
    assertCommerceProviderResult('confirm_payment', result)
    if (result.status !== 'paid') throw new CommerceProviderError('COMMERCE_PAYMENT_DECLINED', false, false, false)
    return finalizePayment(transaction, payment, result, input.now)
  } catch (error) {
    try {
      const recovered = await provider.lookupPayment({ providerRequestId: payment.providerRequestId,
        providerOrderId: transaction.providerOrderId! })
      assertCommerceProviderResult('lookup_payment', recovered)
      if (recovered.status === 'paid') return finalizePayment(transaction, payment, recovered, input.now)
    } catch (lookupError) {
      throw await persistPaymentUncertainty(transaction, payment, lookupError, input.now)
    }
    throw await persistPaymentUncertainty(transaction, payment, error, input.now)
  }
}

function finalizePayment(
  transaction: CommerceTransaction,
  payment: CommercePaymentAttempt,
  result: CommerceProviderPaymentResult,
  now: string,
): CommercePaymentExecutionResult {
  if (!result.providerReceiptId || !result.receiptDigest || result.currency !== transaction.currency
    || result.amountMinor > transaction.expectedAmountMinor || result.providerOrderId !== transaction.providerOrderId) {
    throw new CommerceExecutionError('COMMERCE_PROVIDER_PAYMENT_RESULT_INVALID', false, true, transaction.id)
  }
  const paid = transitionCommercePaymentAttempt({ paymentId: payment.id, expectedVersion: payment.version,
    state: 'paid', providerReceiptId: result.providerReceiptId, evidenceDigest: result.receiptDigest,
    completedAt: now, updatedAt: now })
  const updated = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: transaction.version,
    state: 'paid', actualAmountMinor: result.amountMinor, updatedAt: now })
  appendCommerceCheckpoint({ transactionId: updated.id, stage: 'payment_verified', evidenceDigest: result.receiptDigest,
    details: { amountMinor: result.amountMinor, providerReceiptId: result.providerReceiptId,
      providerRequestId: result.providerRequestId, status: result.status }, observedAt: now })
  return { transaction: updated, payment: paid, providerReceiptId: result.providerReceiptId,
    receiptDigest: result.receiptDigest, amountMinor: result.amountMinor }
}

async function persistPaymentUncertainty(
  transaction: CommerceTransaction,
  payment: CommercePaymentAttempt,
  error: unknown,
  now: string,
): Promise<CommerceExecutionError> {
  const providerError = normalizedProviderError(error)
  let updatedTransaction = transaction
  let updatedPayment = payment
  if (transaction.state === 'submitting_payment') updatedTransaction = transitionCommerceTransaction({
    transactionId: transaction.id, expectedVersion: transaction.version, state: 'lookup_required', updatedAt: now,
  })
  if (payment.state === 'submitting') updatedPayment = transitionCommercePaymentAttempt({
    paymentId: payment.id, expectedVersion: payment.version, state: 'lookup_required', updatedAt: now,
  })
  appendCommerceCheckpoint({ transactionId: updatedTransaction.id, stage: 'payment_lookup_required',
    errorCode: providerError.code, details: { paymentId: updatedPayment.id,
      retryable: providerError.retryable, uncertain: providerError.uncertain }, observedAt: now })
  return new CommerceExecutionError(providerError.code, providerError.retryable, true, updatedTransaction.id)
}

function hasOrderEffect(transaction: CommerceTransaction): boolean {
  return !!transaction.providerOrderId && ['order_pending', 'waiting_payment', 'submitting_payment', 'paid',
    'fulfilling', 'delivered', 'cancelling', 'cancelled', 'refunding', 'refunded'].includes(transaction.state)
}

function orderExecutionFromTransaction(transaction: CommerceTransaction): CommerceOrderExecutionResult {
  const checkpoint = appendCommerceCheckpoint({ transactionId: transaction.id, stage: 'order_replayed',
    details: { providerOrderId: transaction.providerOrderId, state: transaction.state }, observedAt: transaction.updatedAt })
  return { transaction, providerOrderId: transaction.providerOrderId!,
    amountMinor: transaction.actualAmountMinor ?? transaction.expectedAmountMinor,
    receiptDigest: checkpoint.evidenceDigest ?? transaction.quoteDigest }
}

function paymentExecutionFromRecords(
  transaction: CommerceTransaction,
  payment: CommercePaymentAttempt,
): CommercePaymentExecutionResult {
  if (!payment.providerReceiptId || !payment.evidenceDigest) {
    throw new CommerceExecutionError('COMMERCE_PAYMENT_RECEIPT_MISSING', false, true, transaction.id)
  }
  return { transaction, payment, providerReceiptId: payment.providerReceiptId,
    receiptDigest: payment.evidenceDigest, amountMinor: transaction.actualAmountMinor ?? payment.amountMinor }
}

function normalizedProviderError(error: unknown): CommerceProviderError {
  if (error instanceof CommerceProviderError) return error
  if (error instanceof CommerceContractError) {
    return new CommerceProviderError(error.code, false, false, false)
  }
  return new CommerceProviderError('COMMERCE_PROVIDER_RESULT_UNKNOWN', false, true, false)
}
