import { createHash } from 'crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  FabricCompensateResult,
  FabricExecutionContext,
  FabricExecuteResult,
  FabricExecutorAdapter,
  FabricInterruptResult,
  FabricPrepareResult,
  FabricVerifyResult,
} from '../action-fabric/executors'
import type { FabricEvidence, FabricJsonObject } from '../action-fabric/types'
import {
  executeShadowCommerceCancellation,
  executeShadowCommerceRefund,
  trackShadowCommerceDelivery,
} from './adjustment-service'
import { CommerceContractError } from './contracts'
import {
  commerceTargetAtoms,
  COMMERCE_CANCEL_CAPABILITY,
  COMMERCE_CART_CAPABILITY,
  COMMERCE_COMPARE_CAPABILITY,
  COMMERCE_DELIVERY_CAPABILITY,
  COMMERCE_ORDER_CAPABILITY,
  COMMERCE_PAYMENT_CAPABILITY,
  COMMERCE_QUOTE_CAPABILITY,
  COMMERCE_REFUND_CAPABILITY,
  COMMERCE_SEARCH_CAPABILITY,
  isCommerceFabricCapability,
  validateCommerceFabricSemantics,
} from './fabric-contracts'
import { observeCommerceOffers } from './observation-service'
import { CommerceProviderError, type CommerceProviderAdapter } from './provider'
import {
  getCommerceAccount,
  getCommerceCartRevision,
  getCommerceCancellationRequest,
  getCommerceComparison,
  getCommerceOfferSnapshot,
  getCommercePaymentAttemptByTransaction,
  getCommerceQuote,
  getCommerceRefundRequest,
  getCommerceTransaction,
  getCommerceTransactionByWorkflow,
  getLatestCommerceDeliveryObservation,
} from './store'
import {
  CommerceExecutionError,
  executeShadowCommerceOrder,
  executeShadowCommercePayment,
} from './transaction-service'
import type { CommerceProviderAccount, CommerceTransaction } from './types'

const EXECUTOR_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/
const OBSERVE_CAPABILITIES = new Set([
  COMMERCE_SEARCH_CAPABILITY, COMMERCE_COMPARE_CAPABILITY, COMMERCE_CART_CAPABILITY,
])

export interface CommerceExecutorOptions {
  id: string
  providerForAccount: (accountId: string) => CommerceProviderAdapter | null
}

export function createCommerceExecutorAdapter(options: CommerceExecutorOptions): FabricExecutorAdapter {
  if (!EXECUTOR_ID.test(options.id) || typeof options.providerForAccount !== 'function') {
    throw new Error('COMMERCE_EXECUTOR_CONFIGURATION_INVALID')
  }
  return {
    id: options.id,
    type: 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        const account = assertContext(options, context)
        assertBoundMaterial(context, account)
        return success('prepared', context, {
          schemaVersion: 1,
          accountId: account.id,
          capabilityId: context.capabilityId,
          materialDigest: materialDigest(context),
          mode: account.mode,
        })
      } catch (error) {
        return prepareFailure(error)
      }
    },
    async execute(context): Promise<FabricExecuteResult> {
      try {
        const account = assertContext(options, context)
        if (!matchesPrepared(context, account)) {
          return failure('permanent_failure', 'COMMERCE_PREPARATION_INVALID')
        }
        assertBoundMaterial(context, account)
        return success('succeeded', context, await executeCapability(options, context, account))
      } catch (error) {
        return executeFailure(error)
      }
    },
    async verify(context): Promise<FabricVerifyResult> {
      try {
        const account = assertContext(options, context)
        if (!matchesPrepared(context, account) || !context.executionOutput) {
          return failure('failed', 'COMMERCE_VERIFICATION_PREPARATION_INVALID')
        }
        assertBoundMaterial(context, account, true)
        const current = currentOutput(context, account)
        if (!current || !isDeepStrictEqual(current, context.executionOutput)) {
          return failure('mismatch', 'COMMERCE_VERIFICATION_MISMATCH')
        }
        return success('verified', context, current)
      } catch (error) {
        const code = errorCode(error, 'COMMERCE_VERIFICATION_FAILED')
        if (error instanceof CommerceExecutionError && error.uncertain) return failure('unknown', code)
        return failure('failed', code)
      }
    },
    async interrupt(context): Promise<FabricInterruptResult> {
      try {
        const account = assertContext(options, context)
        if (!matchesPrepared(context, account)) return failure('failed', 'COMMERCE_PREPARATION_INVALID')
        if (OBSERVE_CAPABILITIES.has(context.capabilityId) || context.capabilityId === COMMERCE_QUOTE_CAPABILITY
          || context.capabilityId === COMMERCE_DELIVERY_CAPABILITY) {
          return success('interrupted', context, { schemaVersion: 1, sideEffect: false })
        }
        return failure('unsupported', 'COMMERCE_INTERRUPT_REQUIRES_SEMANTIC_ADJUSTMENT')
      } catch (error) {
        return failure('failed', errorCode(error, 'COMMERCE_INTERRUPT_FAILED'))
      }
    },
    async compensate(context): Promise<FabricCompensateResult> {
      if (context.capabilityId === COMMERCE_CART_CAPABILITY) {
        return success('compensated', context, { schemaVersion: 1, sideEffectsReversed: 0 })
      }
      return failure('unsupported', 'COMMERCE_COMPENSATION_REQUIRES_SEMANTIC_CAPABILITY')
    },
  }
}

async function executeCapability(
  options: CommerceExecutorOptions,
  context: FabricExecutionContext,
  account: CommerceProviderAccount,
): Promise<FabricJsonObject> {
  const provider = options.providerForAccount(account.id)
  switch (context.capabilityId) {
    case COMMERCE_SEARCH_CAPABILITY: {
      const adapter = requiredProvider(provider, account)
      const observed = await observeCommerceOffers({ accountId: account.id, query: String(context.input.query),
        limit: Number(context.input.limit), adapter })
      return baseOutput(account, 'search', {
        offerSnapshotIds: observed.map(item => item.offer.id), totalCount: observed.length,
      })
    }
    case COMMERCE_COMPARE_CAPABILITY:
    case COMMERCE_CART_CAPABILITY:
    case COMMERCE_QUOTE_CAPABILITY:
      return requiredCurrentOutput(context, account)
    case COMMERCE_ORDER_CAPABILITY: {
      const adapter = requiredProvider(provider, account)
      const result = await executeShadowCommerceOrder({
        workflowId: context.workflowId,
        intentId: context.intentId,
        accountId: account.id,
        quoteId: String(context.input.quoteId),
        quoteDigest: String(context.input.quoteDigest),
        providerRequestId: String(context.input.providerRequestId),
        amountMinor: Number(context.input.amountMinor),
        provider: adapter,
        now: executionTime(context),
      })
      return transactionOutput(account, context, 'order_place', {
        transactionId: result.transaction.id,
        providerOrderId: result.providerOrderId,
        amountMinor: result.amountMinor,
        status: account.mode === 'shadow' ? 'shadowed' : orderStatus(result.transaction),
      })
    }
    case COMMERCE_PAYMENT_CAPABILITY: {
      const adapter = requiredProvider(provider, account)
      const result = await executeShadowCommercePayment({
        transactionId: String(context.input.transactionId),
        quoteDigest: String(context.input.quoteDigest),
        providerRequestId: paymentRequestId(context),
        approvalId: String(context.input.approvalId),
        amountMinor: Number(context.input.amountMinor),
        provider: adapter,
        now: executionTime(context),
      })
      return transactionOutput(account, context, 'payment_confirm', {
        transactionId: result.transaction.id,
        providerReceiptId: result.providerReceiptId,
        receiptDigest: result.receiptDigest,
        amountMinor: result.amountMinor,
        status: account.mode === 'shadow' ? 'shadowed' : 'paid',
      })
    }
    case COMMERCE_DELIVERY_CAPABILITY: {
      const adapter = requiredProvider(provider, account)
      const result = await trackShadowCommerceDelivery({ transactionId: String(context.input.transactionId),
        provider: adapter, now: executionTime(context) })
      return baseOutput(account, 'delivery_track', { transactionId: result.transaction.id,
        providerEventId: result.observation.providerEventId, state: result.observation.state,
        observedAt: result.observation.observedAt })
    }
    case COMMERCE_CANCEL_CAPABILITY: {
      const adapter = requiredProvider(provider, account)
      const result = await executeShadowCommerceCancellation({ transactionId: String(context.input.transactionId),
        providerRequestId: String(context.input.providerRequestId), reasonCode: String(context.input.reasonCode),
        provider: adapter, now: executionTime(context) })
      return transactionOutput(account, context, 'order_cancel', { transactionId: result.transaction.id,
        providerReceiptId: result.request.providerReceiptId,
        status: account.mode === 'shadow' ? 'shadowed' : result.status })
    }
    case COMMERCE_REFUND_CAPABILITY: {
      const adapter = requiredProvider(provider, account)
      const result = await executeShadowCommerceRefund({ transactionId: String(context.input.transactionId),
        providerRequestId: String(context.input.providerRequestId), reasonCode: String(context.input.reasonCode),
        currency: account.currency, amountMinor: Number(context.input.amountMinor),
        provider: adapter, now: executionTime(context) })
      return transactionOutput(account, context, 'refund_request', { transactionId: result.transaction.id,
        providerReceiptId: result.request.providerReceiptId,
        amountMinor: result.request.actualAmountMinor ?? result.request.expectedAmountMinor,
        status: account.mode === 'shadow' ? 'shadowed' : result.status })
    }
    default:
      throw new CommerceContractError('COMMERCE_CAPABILITY_UNSUPPORTED')
  }
}

function currentOutput(
  context: FabricExecutionContext,
  account: CommerceProviderAccount,
): FabricJsonObject | null {
  switch (context.capabilityId) {
    case COMMERCE_SEARCH_CAPABILITY: {
      const ids = context.executionOutput?.offerSnapshotIds
      if (!Array.isArray(ids) || ids.length > Number(context.input.limit)
        || ids.some(id => typeof id !== 'string' || getCommerceOfferSnapshot(id)?.accountId !== account.id)) return null
      return baseOutput(account, 'search', { offerSnapshotIds: ids, totalCount: ids.length })
    }
    case COMMERCE_COMPARE_CAPABILITY: {
      const comparison = getCommerceComparison(String(context.input.comparisonId))
      if (!comparison || comparison.accountId !== account.id || comparison.inputDigest !== context.input.inputDigest) return null
      return baseOutput(account, 'compare', { comparisonId: comparison.id, inputDigest: comparison.inputDigest,
        selectedOfferSnapshotId: comparison.selectedOfferSnapshotId, candidateCount: comparison.candidates.length })
    }
    case COMMERCE_CART_CAPABILITY: {
      const cart = getCommerceCartRevision(String(context.input.cartRevisionId))
      if (!cart || cart.accountId !== account.id || cart.contentDigest !== context.input.cartDigest) return null
      return baseOutput(account, 'cart_prepare', { cartRevisionId: cart.id, cartDigest: cart.contentDigest,
        itemCount: cart.items.length })
    }
    case COMMERCE_QUOTE_CAPABILITY: {
      const quote = getCommerceQuote(String(context.input.quoteId))
      if (!quote || quote.accountId !== account.id || quote.quoteDigest !== context.input.quoteDigest
        || quote.breakdown.totalMinor !== context.input.amountMinor) return null
      return baseOutput(account, 'quote_refresh', { quoteId: quote.id, quoteDigest: quote.quoteDigest,
        amountMinor: quote.breakdown.totalMinor, expiresAt: quote.expiresAt })
    }
    case COMMERCE_ORDER_CAPABILITY: {
      const transaction = getCommerceTransactionByWorkflow(context.workflowId)
      if (!transaction || transaction.accountId !== account.id || !transaction.providerOrderId
        || transaction.quoteDigest !== context.input.quoteDigest) return null
      return transactionOutput(account, context, 'order_place', { transactionId: transaction.id,
        providerOrderId: transaction.providerOrderId,
        amountMinor: transaction.actualAmountMinor ?? transaction.expectedAmountMinor,
        status: account.mode === 'shadow' ? 'shadowed' : orderStatus(transaction) })
    }
    case COMMERCE_PAYMENT_CAPABILITY: {
      const transaction = getCommerceTransaction(String(context.input.transactionId))
      const payment = transaction ? getCommercePaymentAttemptByTransaction(transaction.id) : null
      if (!transaction || transaction.accountId !== account.id || transaction.state !== 'paid'
        || !payment?.providerReceiptId || !payment.evidenceDigest || payment.approvalId !== context.input.approvalId) return null
      return transactionOutput(account, context, 'payment_confirm', { transactionId: transaction.id,
        providerReceiptId: payment.providerReceiptId, receiptDigest: payment.evidenceDigest,
        amountMinor: transaction.actualAmountMinor ?? payment.amountMinor,
        status: account.mode === 'shadow' ? 'shadowed' : 'paid' })
    }
    case COMMERCE_DELIVERY_CAPABILITY: {
      const transaction = getCommerceTransaction(String(context.input.transactionId))
      const observation = transaction ? getLatestCommerceDeliveryObservation(transaction.id) : null
      if (!transaction || transaction.accountId !== account.id || !observation) return null
      return baseOutput(account, 'delivery_track', { transactionId: transaction.id,
        providerEventId: observation.providerEventId, state: observation.state, observedAt: observation.observedAt })
    }
    case COMMERCE_CANCEL_CAPABILITY: {
      const transaction = getCommerceTransaction(String(context.input.transactionId))
      const request = transaction ? getCommerceCancellationRequest(transaction.id,
        String(context.input.providerRequestId)) : null
      if (!transaction || transaction.accountId !== account.id || !request
        || !['cancelled', 'rejected'].includes(request.state)) return null
      return transactionOutput(account, context, 'order_cancel', { transactionId: transaction.id,
        providerReceiptId: request.providerReceiptId,
        status: account.mode === 'shadow' ? 'shadowed' : request.state })
    }
    case COMMERCE_REFUND_CAPABILITY: {
      const transaction = getCommerceTransaction(String(context.input.transactionId))
      const request = transaction ? getCommerceRefundRequest(transaction.id,
        String(context.input.providerRequestId)) : null
      if (!transaction || transaction.accountId !== account.id || !request
        || !['processing', 'refunded', 'rejected'].includes(request.state)) return null
      return transactionOutput(account, context, 'refund_request', { transactionId: transaction.id,
        providerReceiptId: request.providerReceiptId,
        amountMinor: request.actualAmountMinor ?? request.expectedAmountMinor,
        status: account.mode === 'shadow' ? 'shadowed' : request.state })
    }
    default: return null
  }
}

function requiredCurrentOutput(context: FabricExecutionContext, account: CommerceProviderAccount): FabricJsonObject {
  const output = currentOutput(context, account)
  if (!output) throw new CommerceContractError('COMMERCE_MATERIAL_MISMATCH')
  return output
}

function assertContext(options: CommerceExecutorOptions, context: FabricExecutionContext): CommerceProviderAccount {
  if (context.executorId !== options.id || context.executorType !== 'connector'
    || !isCommerceFabricCapability(context.capabilityId)
    || !validateCommerceFabricSemantics(context.capabilityId, context.input)
    || commerceTargetAtoms(context.capabilityId, context.target, context.input) === null) {
    throw new CommerceContractError('COMMERCE_EXECUTOR_CONTEXT_INVALID')
  }
  const account = getCommerceAccount(String(context.input.accountId))
  if (!account || !account.enabled || account.health === 'revoked'
    || account.provider !== context.input.provider || account.currency !== context.input.currency
    || account.executorId !== null && account.executorId !== options.id) {
    throw new CommerceContractError('COMMERCE_ACCOUNT_UNAVAILABLE')
  }
  if (account.mode === 'observe' && !OBSERVE_CAPABILITIES.has(context.capabilityId)) {
    throw new CommerceContractError('COMMERCE_OBSERVE_MODE_FORBIDDEN')
  }
  return account
}

function assertBoundMaterial(
  context: FabricExecutionContext,
  account: CommerceProviderAccount,
  verifying = false,
): void {
  if (context.capabilityId === COMMERCE_SEARCH_CAPABILITY) return
  if (context.capabilityId === COMMERCE_COMPARE_CAPABILITY) {
    if (!currentOutput(context, account)) throw new CommerceContractError('COMMERCE_COMPARISON_MISMATCH')
    return
  }
  if (context.capabilityId === COMMERCE_CART_CAPABILITY) {
    const comparison = getCommerceComparison(String(context.input.comparisonId))
    const cart = getCommerceCartRevision(String(context.input.cartRevisionId))
    if (!comparison || !cart || comparison.accountId !== account.id || cart.accountId !== account.id
      || cart.contentDigest !== context.input.cartDigest
      || digest(cart.destinationToken) !== context.input.destinationDigest
      || comparison.selectedOfferSnapshotId === null
      || !cart.items.every(item => item.offerSnapshotId === comparison.selectedOfferSnapshotId
        && comparison.candidates.some(candidate => candidate.eligible
          && candidate.offerSnapshotId === item.offerSnapshotId))) {
      throw new CommerceContractError('COMMERCE_CART_MISMATCH')
    }
    return
  }
  if (context.capabilityId === COMMERCE_QUOTE_CAPABILITY || context.capabilityId === COMMERCE_ORDER_CAPABILITY) {
    const quote = getCommerceQuote(String(context.input.quoteId))
    const existing = context.capabilityId === COMMERCE_ORDER_CAPABILITY
      ? getCommerceTransactionByWorkflow(context.workflowId) : null
    if (!quote || quote.accountId !== account.id || (context.capabilityId === COMMERCE_QUOTE_CAPABILITY
        && quote.cartRevisionId !== context.input.cartRevisionId)
      || quote.quoteDigest !== context.input.quoteDigest || quote.breakdown.totalMinor !== context.input.amountMinor
      || (!existing && (quote.status !== 'active' || Date.parse(quote.expiresAt) <= Date.parse(executionTime(context))))) {
      throw new CommerceContractError('COMMERCE_QUOTE_MISMATCH')
    }
    if (context.capabilityId === COMMERCE_ORDER_CAPABILITY) {
      assertTransactionTarget(context, quote.cartRevisionId)
      if (existing && (existing.accountId !== account.id || existing.quoteId !== quote.id
        || existing.providerRequestId !== context.input.providerRequestId || existing.mode !== account.mode
        || existing.policyEpoch !== account.policyEpoch)) {
        throw new CommerceContractError('COMMERCE_TRANSACTION_REPLAY_MISMATCH')
      }
    }
    return
  }
  const transaction = getCommerceTransaction(String(context.input.transactionId))
  if (!transaction || transaction.accountId !== account.id) throw new CommerceContractError('COMMERCE_TRANSACTION_MISMATCH')
  const quote = getCommerceQuote(transaction.quoteId)
  if (!quote || transaction.quoteDigest !== context.input.quoteDigest && context.input.quoteDigest !== undefined) {
    throw new CommerceContractError('COMMERCE_TRANSACTION_MISMATCH')
  }
  if (context.capabilityId !== COMMERCE_DELIVERY_CAPABILITY) assertTransactionTarget(context, quote.cartRevisionId)
  if (context.capabilityId === COMMERCE_PAYMENT_CAPABILITY && transaction.expectedAmountMinor !== context.input.amountMinor) {
    throw new CommerceContractError('COMMERCE_PAYMENT_MATERIAL_MISMATCH')
  }
  if (context.capabilityId === COMMERCE_REFUND_CAPABILITY
    && Number(context.input.amountMinor) > (transaction.actualAmountMinor ?? transaction.expectedAmountMinor)) {
    throw new CommerceContractError('COMMERCE_REFUND_AMOUNT_INVALID')
  }
  if (verifying && context.capabilityId === COMMERCE_PAYMENT_CAPABILITY) {
    const payment = getCommercePaymentAttemptByTransaction(transaction.id)
    if (!payment || payment.approvalId !== context.input.approvalId) {
      throw new CommerceContractError('COMMERCE_PAYMENT_APPROVAL_MISMATCH')
    }
  }
}

function assertTransactionTarget(context: FabricExecutionContext, cartId: string): void {
  const cart = getCommerceCartRevision(cartId)
  if (!cart || digest(cart.destinationToken) !== context.input.destinationDigest || cart.items.length === 0) {
    throw new CommerceContractError('COMMERCE_DESTINATION_MISMATCH')
  }
  const merchants = cart.items.map(item => getCommerceOfferSnapshot(item.offerSnapshotId)?.merchantId)
  if (merchants.some(merchant => merchant !== context.input.merchantId)) {
    throw new CommerceContractError('COMMERCE_MERCHANT_MISMATCH')
  }
}

function requiredProvider(
  provider: CommerceProviderAdapter | null,
  account: CommerceProviderAccount,
): CommerceProviderAdapter {
  if (!provider || provider.provider !== account.provider
    || account.mode === 'shadow' && provider.transport !== 'virtual'
    || account.mode === 'live' && provider.transport !== 'external') {
    throw new CommerceContractError('COMMERCE_PROVIDER_UNAVAILABLE')
  }
  return provider
}

function matchesPrepared(context: FabricExecutionContext, account: CommerceProviderAccount): boolean {
  return context.preparedOutput?.schemaVersion === 1
    && context.preparedOutput.accountId === account.id
    && context.preparedOutput.capabilityId === context.capabilityId
    && context.preparedOutput.materialDigest === materialDigest(context)
    && context.preparedOutput.mode === account.mode
}

function materialDigest(context: FabricExecutionContext): string {
  return digest(canonical({ workflowId: context.workflowId, intentId: context.intentId,
    executorId: context.executorId, capabilityId: context.capabilityId, capabilityVersion: context.capabilityVersion,
    contractDigest: context.contractDigest, policyEvaluationToken: context.policyEvaluationToken,
    input: context.input, target: context.target }))
}

function paymentRequestId(context: FabricExecutionContext): string {
  return `payment-${digest(canonical({ workflowId: context.workflowId,
    transactionId: context.input.transactionId })).slice(0, 40)}`
}

function baseOutput(
  account: CommerceProviderAccount,
  operation: string,
  output: FabricJsonObject,
): FabricJsonObject {
  return { schemaVersion: 1, operation, accountId: account.id, provider: account.provider,
    currency: account.currency, ...output }
}

function transactionOutput(
  account: CommerceProviderAccount,
  context: FabricExecutionContext,
  operation: string,
  output: FabricJsonObject,
): FabricJsonObject {
  return baseOutput(account, operation, { merchantId: context.input.merchantId,
    destinationDigest: context.input.destinationDigest, ...output })
}

function orderStatus(transaction: CommerceTransaction): string {
  if (transaction.state === 'paid') return 'paid'
  if (transaction.state === 'lookup_required') return 'unknown'
  return 'pending_payment'
}

function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: evidence(context, output), errorCode: null, safeToRetry: false }
}

function evidence(context: FabricExecutionContext, output: FabricJsonObject): FabricEvidence[] {
  return [{ kind: 'commerce_receipt', summary: `Commerce ${context.capabilityId} receipt`, data: {
    accountId: context.input.accountId,
    capabilityId: context.capabilityId,
    materialDigest: materialDigest(context),
    outputDigest: digest(canonical(output)),
    ...(typeof output.transactionId === 'string' ? { transactionId: output.transactionId } : {}),
  }, capturedAt: executionTime(context) }]
}

function prepareFailure(error: unknown): FabricPrepareResult {
  return failure('failed', errorCode(error, 'COMMERCE_PREPARATION_FAILED'))
}

function executeFailure(error: unknown): FabricExecuteResult {
  const code = errorCode(error, 'COMMERCE_EXECUTION_FAILED')
  if (error instanceof CommerceExecutionError || error instanceof CommerceProviderError) {
    if (error.retryable) return failure('temporary_failure', code, true)
    if (error.uncertain) return failure('unknown', code)
  }
  return failure('permanent_failure', code)
}

function failure<T extends string>(outcome: T, code: string, safeToRetry = false) {
  return { outcome, output: {}, evidence: [], errorCode: code, safeToRetry }
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const value = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value)) return value
  }
  return fallback
}

function executionTime(context: FabricExecutionContext): string {
  if (context.now && new Date(context.now).toISOString() === context.now) return context.now
  return new Date().toISOString()
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
