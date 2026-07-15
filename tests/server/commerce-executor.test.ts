import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bindFabricExecutorCapability,
  createFabricExecutor,
  ensureBuiltInFabricRegistry,
  getFabricCapability,
  invokeFabricExecutor,
  registerFabricExecutorAdapter,
  resolveFabricExecutor,
  unregisterFabricExecutorAdapter,
  updateFabricExecutorHealth,
  type FabricExecutionContext,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  compareObservedCommerceOffers,
  COMMERCE_CANCEL_CAPABILITY,
  COMMERCE_DELIVERY_CAPABILITY,
  COMMERCE_ORDER_CAPABILITY,
  COMMERCE_PAYMENT_CAPABILITY,
  COMMERCE_QUOTE_CAPABILITY,
  COMMERCE_REFUND_CAPABILITY,
  COMMERCE_SEARCH_CAPABILITY,
  createCommerceAccount,
  createCommerceExecutorAdapter,
  executeShadowCommerceOrder,
  executeShadowCommercePayment,
  observeCommerceOffers,
  prepareCommerceCartFromComparison,
  refreshShadowCommerceQuote,
  VirtualCommerceProvider,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('commerce Action Fabric executor', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''
  let provider: VirtualCommerceProvider

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-commerce-executor-'))
    process.env.HERMES_HOME = home
    ensureBuiltInFabricRegistry()
    createFabricExecutor({ id: 'commerce-shadow-food', type: 'connector', name: 'Commerce shadow food',
      environment: 'sandbox', configuration: { externalWrite: false, shadow: true, interruptible: true }, enabled: true })
    for (const capabilityId of [COMMERCE_SEARCH_CAPABILITY, COMMERCE_QUOTE_CAPABILITY,
      COMMERCE_ORDER_CAPABILITY, COMMERCE_PAYMENT_CAPABILITY, COMMERCE_DELIVERY_CAPABILITY,
      COMMERCE_CANCEL_CAPABILITY, COMMERCE_REFUND_CAPABILITY]) {
      const capability = getFabricCapability(capabilityId)!
      bindFabricExecutorCapability('commerce-shadow-food', capability.id, capability.version, capability.contractDigest)
    }
    updateFabricExecutorHealth('commerce-shadow-food', 'healthy', {})
    createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'shadow', currency: 'CNY',
      executorId: 'commerce-shadow-food', displayName: 'Food shadow' })
    provider = new VirtualCommerceProvider({ provider: 'food_delivery', clock: () => new Date(NOW), catalog: [{
      providerOfferId: 'offer-1', productId: 'product-1', skuId: 'sku-1', merchantId: 'merchant-1',
      merchantName: 'Protein Lab', title: 'Protein meal', unitLabel: 'serving', currency: 'CNY',
      unitPriceMinor: 1_000, available: true, maxQuantity: 10, fulfillment: 'delivery', fulfillmentMinutes: 20,
    }] })
    registerFabricExecutorAdapter(createCommerceExecutorAdapter({ id: 'commerce-shadow-food',
      providerForAccount: accountId => accountId === 'food-account' ? provider : null }))
  })

  afterEach(() => {
    unregisterFabricExecutorAdapter('commerce-shadow-food')
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('prepares, executes, verifies, and replays a bounded offer search', async () => {
    const context = executionContext(COMMERCE_SEARCH_CAPABILITY, searchInput(), baseTarget(), 'search')
    const prepared = await invokeFabricExecutor('prepare', context)
    expect(prepared).toMatchObject({ outcome: 'prepared', output: { accountId: 'food-account', mode: 'shadow',
      materialDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    const executing = { ...context, preparedOutput: prepared.output }
    const first = await invokeFabricExecutor('execute', executing)
    const replay = await invokeFabricExecutor('execute', executing)
    expect(first).toMatchObject({ outcome: 'succeeded', output: { operation: 'search', totalCount: 1,
      offerSnapshotIds: [expect.stringMatching(/^offer-/)] } })
    expect(replay.output).toEqual(first.output)
    await expect(invokeFabricExecutor('verify', { ...executing, executionOutput: first.output }))
      .resolves.toMatchObject({ outcome: 'verified', output: first.output })
  })

  it('executes an exact shadow order and separately approved payment through governed contracts', async () => {
    const seeded = await seedQuote()
    const order = executionContext(COMMERCE_ORDER_CAPABILITY, {
      ...base(), merchantId: 'merchant-1', destinationDigest: destinationDigest(), quoteId: seeded.quote.id,
      quoteDigest: seeded.quote.quoteDigest, providerRequestId: 'request-order-fabric-1',
      amountMinor: seeded.quote.breakdown.totalMinor,
    }, transactionTarget(), 'order')
    const orderPrepared = await invokeFabricExecutor('prepare', order)
    const orderExecuting = { ...order, preparedOutput: orderPrepared.output }
    const ordered = await invokeFabricExecutor('execute', orderExecuting)
    expect(ordered).toMatchObject({ outcome: 'succeeded', output: { operation: 'order_place', status: 'shadowed',
      merchantId: 'merchant-1', destinationDigest: destinationDigest(), amountMinor: 1_600,
      providerOrderId: expect.stringMatching(/^vo-/), transactionId: expect.stringMatching(/^transaction-/) } })
    await expect(invokeFabricExecutor('verify', { ...orderExecuting, executionOutput: ordered.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
    expect((await invokeFabricExecutor('execute', orderExecuting)).output).toEqual(ordered.output)

    const payment = executionContext(COMMERCE_PAYMENT_CAPABILITY, {
      ...base(), merchantId: 'merchant-1', destinationDigest: destinationDigest(),
      transactionId: ordered.output.transactionId, quoteDigest: seeded.quote.quoteDigest,
      approvalId: 'approval-fabric-exact-1', amountMinor: seeded.quote.breakdown.totalMinor,
    }, transactionTarget(), 'payment')
    const paymentPrepared = await invokeFabricExecutor('prepare', payment)
    const paymentExecuting = { ...payment, preparedOutput: paymentPrepared.output }
    const paid = await invokeFabricExecutor('execute', paymentExecuting)
    expect(paid).toMatchObject({ outcome: 'succeeded', output: { operation: 'payment_confirm', status: 'shadowed',
      transactionId: ordered.output.transactionId, amountMinor: 1_600,
      providerReceiptId: expect.stringMatching(/^vp-/),
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    await expect(invokeFabricExecutor('verify', { ...paymentExecuting, executionOutput: paid.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
  })

  it('persists uncertainty and only advertises a safe retry after provider lookup', async () => {
    const seeded = await seedQuote()
    provider.injectFault('place_order', 'timeout_before_effect')
    const context = executionContext(COMMERCE_ORDER_CAPABILITY, {
      ...base(), merchantId: 'merchant-1', destinationDigest: destinationDigest(), quoteId: seeded.quote.id,
      quoteDigest: seeded.quote.quoteDigest, providerRequestId: 'request-order-timeout', amountMinor: 1_600,
    }, transactionTarget(), 'timeout')
    const prepared = await invokeFabricExecutor('prepare', context)
    const executing = { ...context, preparedOutput: prepared.output }
    await expect(invokeFabricExecutor('execute', executing)).resolves.toMatchObject({
      outcome: 'temporary_failure', errorCode: 'COMMERCE_PROVIDER_TIMEOUT', safeToRetry: true,
    })
    await expect(invokeFabricExecutor('execute', executing)).resolves.toMatchObject({
      outcome: 'succeeded', output: { status: 'shadowed' }, safeToRetry: false,
    })
  })

  it('fails closed on target or prepared-material substitution', async () => {
    const seeded = await seedQuote()
    const input = { ...base(), cartRevisionId: seeded.quote.cartRevisionId, cartDigest: seeded.quote.cartDigest,
      quoteId: seeded.quote.id, quoteDigest: seeded.quote.quoteDigest, amountMinor: 1_600 }
    const context = executionContext(COMMERCE_QUOTE_CAPABILITY, input, baseTarget(), 'quote')
    const prepared = await invokeFabricExecutor('prepare', context)
    await expect(invokeFabricExecutor('execute', { ...context, preparedOutput: { ...prepared.output,
      materialDigest: '0'.repeat(64) } })).resolves.toMatchObject({
      outcome: 'permanent_failure', errorCode: 'COMMERCE_PREPARATION_INVALID',
    })
    const orderContext = executionContext(COMMERCE_ORDER_CAPABILITY, {
      ...base(), merchantId: 'merchant-2', destinationDigest: destinationDigest(), quoteId: seeded.quote.id,
      quoteDigest: seeded.quote.quoteDigest, providerRequestId: 'request-order-forged', amountMinor: 1_600,
    }, { ...transactionTarget(), merchantId: 'merchant-2' }, 'forged')
    await expect(invokeFabricExecutor('prepare', orderContext)).resolves.toMatchObject({
      outcome: 'failed', errorCode: 'COMMERCE_MERCHANT_MISMATCH',
    })
  })

  it('normalizes delivery, cancellation, and refund receipts through their semantic capabilities', async () => {
    const cancelSeed = await seedQuote()
    const cancelOrder = await executeShadowCommerceOrder({ workflowId: 'workflow-adjustment-cancel',
      intentId: 'intent-adjustment-cancel', accountId: 'food-account', quoteId: cancelSeed.quote.id,
      quoteDigest: cancelSeed.quote.quoteDigest, providerRequestId: 'order-adjustment-cancel',
      amountMinor: 1_600, provider, now: NOW })
    const cancel = executionContext(COMMERCE_CANCEL_CAPABILITY, { ...base(), merchantId: 'merchant-1',
      destinationDigest: destinationDigest(), transactionId: cancelOrder.transaction.id,
      providerRequestId: 'cancel-adjustment-1', reasonCode: 'CUSTOMER_REQUEST' }, transactionTarget(), 'adjustment-cancel')
    const cancelPrepared = await invokeFabricExecutor('prepare', cancel)
    const cancelled = await invokeFabricExecutor('execute', { ...cancel, preparedOutput: cancelPrepared.output })
    expect(cancelled).toMatchObject({ outcome: 'succeeded', output: { operation: 'order_cancel',
      transactionId: cancelOrder.transaction.id, providerReceiptId: expect.stringMatching(/^vc-/), status: 'shadowed' } })

    const paidSeed = await seedQuote()
    const paidOrder = await executeShadowCommerceOrder({ workflowId: 'workflow-adjustment-refund',
      intentId: 'intent-adjustment-refund', accountId: 'food-account', quoteId: paidSeed.quote.id,
      quoteDigest: paidSeed.quote.quoteDigest, providerRequestId: 'order-adjustment-refund',
      amountMinor: 1_600, provider, now: NOW })
    await executeShadowCommercePayment({ transactionId: paidOrder.transaction.id,
      quoteDigest: paidSeed.quote.quoteDigest, providerRequestId: 'payment-adjustment-refund',
      approvalId: 'approval-adjustment-refund', amountMinor: 1_600, provider, now: NOW })
    const delivery = executionContext(COMMERCE_DELIVERY_CAPABILITY,
      { ...base(), transactionId: paidOrder.transaction.id }, baseTarget(), 'adjustment-delivery')
    const deliveryPrepared = await invokeFabricExecutor('prepare', delivery)
    const tracked = await invokeFabricExecutor('execute', { ...delivery, preparedOutput: deliveryPrepared.output })
    expect(tracked).toMatchObject({ outcome: 'succeeded', output: { operation: 'delivery_track',
      transactionId: paidOrder.transaction.id, state: 'preparing', providerEventId: 'event-0' } })

    const refund = executionContext(COMMERCE_REFUND_CAPABILITY, { ...base(), merchantId: 'merchant-1',
      destinationDigest: destinationDigest(), transactionId: paidOrder.transaction.id,
      providerRequestId: 'refund-adjustment-1', reasonCode: 'CUSTOMER_REQUEST', amountMinor: 1_600 },
    transactionTarget(), 'adjustment-refund')
    const refundPrepared = await invokeFabricExecutor('prepare', refund)
    const refunded = await invokeFabricExecutor('execute', { ...refund, preparedOutput: refundPrepared.output })
    expect(refunded).toMatchObject({ outcome: 'succeeded', output: { operation: 'refund_request',
      transactionId: paidOrder.transaction.id, providerReceiptId: expect.stringMatching(/^vr-/),
      amountMinor: 1_600, status: 'shadowed' } })
  })

  async function seedQuote() {
    await observeCommerceOffers({ accountId: 'food-account', query: 'protein', limit: 10, adapter: provider })
    const comparison = compareObservedCommerceOffers({ accountId: 'food-account', activeAt: NOW,
      requirement: { query: 'protein', quantity: 1, maxTotalMinor: 2_000,
        deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: [] } }).comparison
    const cart = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: DESTINATION, recipientToken: 'recipient-self', substitution: 'deny' }).cart
    const quote = (await refreshShadowCommerceQuote({ cartRevisionId: cart.id,
      providerRequestId: `quote-${comparison.id}`, adapter: provider })).quote
    return { comparison, cart, quote }
  }
})

const NOW = '2026-07-15T10:00:00.000Z'
const DESTINATION = 'destination-home'

function base() { return { schemaVersion: 1, accountId: 'food-account', provider: 'food_delivery', currency: 'CNY' } }
function searchInput() { return { ...base(), query: 'protein', limit: 10 } }
function baseTarget() { return { kind: 'commerce_account', accountId: 'food-account', provider: 'food_delivery', currency: 'CNY' } }
function transactionTarget() { return { ...baseTarget(), merchantId: 'merchant-1', destinationDigest: destinationDigest() } }
function destinationDigest() { return createHash('sha256').update(DESTINATION).digest('hex') }

function executionContext(
  capabilityId: string,
  input: Record<string, unknown>,
  target: Record<string, unknown>,
  suffix: string,
): FabricExecutionContext {
  const resolved = resolveFabricExecutor(capabilityId, { environments: ['sandbox'], executorId: 'commerce-shadow-food' })!
  return {
    intentId: `intent-${suffix}`, workflowId: `workflow-${suffix}`, stepId: `step-${suffix}`,
    executorId: resolved.executor.id, executorType: resolved.executor.type, capabilityId,
    capabilityVersion: resolved.capability.version, contractDigest: resolved.capability.contractDigest,
    policyEvaluationToken: resolved.policyEvaluationToken, executionToken: `execution-${suffix}`,
    input, target, now: NOW,
  }
}
