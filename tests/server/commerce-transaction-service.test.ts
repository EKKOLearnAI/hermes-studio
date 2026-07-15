import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareObservedCommerceOffers,
  createCommerceAccount,
  executeShadowCommerceOrder,
  executeShadowCommercePayment,
  getCommercePaymentAttemptByTransaction,
  getCommerceTransaction,
  getCommerceTransactionByWorkflow,
  listCommerceCheckpoints,
  observeCommerceOffers,
  prepareCommerceCartFromComparison,
  refreshShadowCommerceQuote,
  VirtualCommerceProvider,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('commerce order and payment transaction service', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-commerce-transaction-'))
    process.env.HERMES_HOME = home
    createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'shadow',
      currency: 'CNY', displayName: 'Food shadow' })
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('places one shadow order and replays the durable transaction without another write', async () => {
    const seeded = await seed()
    const place = vi.spyOn(seeded.provider, 'placeOrder')
    const first = await executeShadowCommerceOrder(orderInput(seeded))
    expect(first.transaction).toMatchObject({ state: 'order_pending', providerOrderId: first.providerOrderId,
      actualAmountMinor: 1_600 })
    expect(place).toHaveBeenCalledTimes(1)
    const replay = await executeShadowCommerceOrder(orderInput(seeded))
    expect(replay.transaction.id).toBe(first.transaction.id)
    expect(replay.providerOrderId).toBe(first.providerOrderId)
    expect(place).toHaveBeenCalledTimes(1)
  })

  it('recovers an order effect-before-timeout through lookup in the same invocation', async () => {
    const seeded = await seed()
    seeded.provider.injectFault('place_order', 'effect_before_timeout')
    const result = await executeShadowCommerceOrder(orderInput(seeded))
    expect(result.transaction.state).toBe('order_pending')
    expect(listCommerceCheckpoints(result.transaction.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'order_verified', evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]))
  })

  it('persists lookup-required after timeout-before-effect and safely resumes with the same request id', async () => {
    const seeded = await seed()
    seeded.provider.injectFault('place_order', 'timeout_before_effect')
    await expect(executeShadowCommerceOrder(orderInput(seeded))).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_TIMEOUT', retryable: true, uncertain: true,
    })
    const transaction = getCommerceTransactionBySeed()
    expect(transaction.state).toBe('lookup_required')
    expect(transaction.providerOrderId).toBeNull()
    const resumed = await executeShadowCommerceOrder(orderInput(seeded))
    expect(resumed.transaction).toMatchObject({ id: transaction.id, state: 'order_pending' })
  })

  it('requires a separate durable payment attempt and verifies the exact receipt', async () => {
    const seeded = await seed()
    const order = await executeShadowCommerceOrder(orderInput(seeded))
    const confirm = vi.spyOn(seeded.provider, 'confirmPayment')
    const payment = await executeShadowCommercePayment(paymentInput(seeded, order.transaction.id))
    expect(payment.transaction).toMatchObject({ state: 'paid', actualAmountMinor: 1_600 })
    expect(payment.payment).toMatchObject({ state: 'paid', approvalId: 'approval-exact-1',
      providerReceiptId: payment.providerReceiptId, evidenceDigest: payment.receiptDigest })
    expect(confirm).toHaveBeenCalledTimes(1)
    const replay = await executeShadowCommercePayment(paymentInput(seeded, order.transaction.id))
    expect(replay.providerReceiptId).toBe(payment.providerReceiptId)
    expect(confirm).toHaveBeenCalledTimes(1)
    await expect(executeShadowCommercePayment({ ...paymentInput(seeded, order.transaction.id),
      approvalId: 'approval-substituted' })).rejects.toMatchObject({
      code: 'COMMERCE_PAYMENT_REPLAY_MISMATCH', retryable: false, uncertain: false,
    })
  })

  it('recovers a payment effect-before-timeout by lookup without a second charge', async () => {
    const seeded = await seed()
    const order = await executeShadowCommerceOrder(orderInput(seeded))
    seeded.provider.injectFault('confirm_payment', 'effect_before_timeout')
    const confirm = vi.spyOn(seeded.provider, 'confirmPayment')
    const payment = await executeShadowCommercePayment(paymentInput(seeded, order.transaction.id))
    expect(payment.transaction.state).toBe('paid')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect((await executeShadowCommercePayment(paymentInput(seeded, order.transaction.id))).providerReceiptId)
      .toBe(payment.providerReceiptId)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('persists payment lookup-required after no-effect timeout and resumes the same attempt', async () => {
    const seeded = await seed()
    const order = await executeShadowCommerceOrder(orderInput(seeded))
    seeded.provider.injectFault('confirm_payment', 'timeout_before_effect')
    await expect(executeShadowCommercePayment(paymentInput(seeded, order.transaction.id))).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_TIMEOUT', retryable: true, uncertain: true,
    })
    expect(getCommerceTransaction(order.transaction.id)?.state).toBe('lookup_required')
    expect(getCommercePaymentAttemptByTransaction(order.transaction.id)?.state).toBe('lookup_required')
    const resumed = await executeShadowCommercePayment(paymentInput(seeded, order.transaction.id))
    expect(resumed.transaction.state).toBe('paid')
    expect(resumed.payment.state).toBe('paid')
  })
})

const NOW = '2026-07-15T10:00:00.000Z'

async function seed() {
  const provider = new VirtualCommerceProvider({ provider: 'food_delivery', clock: () => new Date(NOW), catalog: [{
    providerOfferId: 'offer-1', productId: 'product-1', skuId: 'sku-1', merchantId: 'merchant-1',
    merchantName: 'Protein Lab', title: 'Protein meal', unitLabel: 'serving', currency: 'CNY',
    unitPriceMinor: 1_000, available: true, maxQuantity: 10, fulfillment: 'delivery', fulfillmentMinutes: 20,
  }] })
  await observeCommerceOffers({ accountId: 'food-account', query: 'protein', limit: 10, adapter: provider })
  const comparison = compareObservedCommerceOffers({ accountId: 'food-account', activeAt: NOW,
    requirement: { query: 'protein', quantity: 1, maxTotalMinor: 2_000,
      deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: [] } }).comparison
  const cart = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
    destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' }).cart
  const quote = (await refreshShadowCommerceQuote({ cartRevisionId: cart.id,
    providerRequestId: 'quote-request-1', adapter: provider })).quote
  return { provider, quote }
}

function orderInput(seeded: Awaited<ReturnType<typeof seed>>) {
  return { workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1', accountId: 'food-account',
    quoteId: seeded.quote.id, quoteDigest: seeded.quote.quoteDigest, providerRequestId: 'order-request-1',
    amountMinor: seeded.quote.breakdown.totalMinor, provider: seeded.provider, now: NOW }
}

function paymentInput(seeded: Awaited<ReturnType<typeof seed>>, transactionId: string) {
  return { transactionId, quoteDigest: seeded.quote.quoteDigest, providerRequestId: 'payment-request-1',
    approvalId: 'approval-exact-1', amountMinor: seeded.quote.breakdown.totalMinor,
    provider: seeded.provider, now: NOW }
}

function getCommerceTransactionBySeed() {
  const transaction = getCommerceTransactionByWorkflow('workflow-commerce-1')
  if (!transaction) throw new Error('seed transaction missing')
  return transaction
}
