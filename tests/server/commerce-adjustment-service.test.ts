import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareObservedCommerceOffers,
  createCommerceAccount,
  executeShadowCommerceCancellation,
  executeShadowCommerceOrder,
  executeShadowCommercePayment,
  executeShadowCommerceRefund,
  getCommerceCancellationRequest,
  getCommerceRefundRequest,
  getCommerceTransaction,
  getLatestCommerceDeliveryObservation,
  observeCommerceOffers,
  prepareCommerceCartFromComparison,
  refreshShadowCommerceQuote,
  trackShadowCommerceDelivery,
  VirtualCommerceProvider,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('commerce delivery, cancellation, and refund service', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-commerce-adjustment-'))
    process.env.HERMES_HOME = home
    createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'shadow',
      currency: 'CNY', displayName: 'Food shadow' })
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('records monotonic delivery events and advances the transaction to delivered', async () => {
    const seeded = await seedPaid('delivery')
    const preparing = await trackShadowCommerceDelivery({ transactionId: seeded.transactionId,
      provider: seeded.provider, now: NOW })
    expect(preparing).toMatchObject({ transaction: { state: 'fulfilling' }, observation: { state: 'preparing',
      providerEventId: 'event-0', evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect((await trackShadowCommerceDelivery({ transactionId: seeded.transactionId,
      provider: seeded.provider, now: NOW })).observation.id).toBe(preparing.observation.id)
    seeded.provider.advanceDelivery(preparing.transaction.providerOrderId!, 'ready')
    expect((await trackShadowCommerceDelivery({ transactionId: seeded.transactionId,
      provider: seeded.provider, now: NOW })).observation.state).toBe('ready')
    seeded.provider.advanceDelivery(preparing.transaction.providerOrderId!, 'in_transit')
    await trackShadowCommerceDelivery({ transactionId: seeded.transactionId, provider: seeded.provider, now: NOW })
    seeded.provider.advanceDelivery(preparing.transaction.providerOrderId!, 'delivered')
    const delivered = await trackShadowCommerceDelivery({ transactionId: seeded.transactionId,
      provider: seeded.provider, now: NOW })
    expect(delivered.transaction.state).toBe('delivered')
    expect(getLatestCommerceDeliveryObservation(seeded.transactionId)?.state).toBe('delivered')
  })

  it('cancels an eligible order once and replays the verified provider receipt', async () => {
    const seeded = await seedOrder('cancel')
    const cancel = vi.spyOn(seeded.provider, 'cancelOrder')
    const input = { transactionId: seeded.transactionId, providerRequestId: 'cancel-request-1',
      reasonCode: 'CUSTOMER_REQUEST', provider: seeded.provider, now: NOW }
    const result = await executeShadowCommerceCancellation(input)
    expect(result).toMatchObject({ status: 'cancelled', transaction: { state: 'cancelled' }, request: {
      state: 'cancelled', providerReceiptId: expect.stringMatching(/^vc-/),
      eligibilityDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect((await executeShadowCommerceCancellation(input)).request.id).toBe(result.request.id)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('looks up cancellation before retry after both provider timeout shapes', async () => {
    const effect = await seedOrder('cancel-effect')
    effect.provider.injectFault('cancel_order', 'effect_before_timeout')
    const recovered = await executeShadowCommerceCancellation({ transactionId: effect.transactionId,
      providerRequestId: 'cancel-request-effect', reasonCode: 'CUSTOMER_REQUEST', provider: effect.provider, now: NOW })
    expect(recovered.status).toBe('cancelled')

    const noEffect = await seedOrder('cancel-retry')
    noEffect.provider.injectFault('cancel_order', 'timeout_before_effect')
    const input = { transactionId: noEffect.transactionId, providerRequestId: 'cancel-request-retry',
      reasonCode: 'CUSTOMER_REQUEST', provider: noEffect.provider, now: NOW }
    await expect(executeShadowCommerceCancellation(input)).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_TIMEOUT', retryable: true, uncertain: true,
    })
    expect(getCommerceTransaction(noEffect.transactionId)?.state).toBe('lookup_required')
    expect(getCommerceCancellationRequest(noEffect.transactionId, input.providerRequestId)?.state).toBe('lookup_required')
    expect((await executeShadowCommerceCancellation(input)).status).toBe('cancelled')
  })

  it('refunds the exact verified charge once and rejects amount or request substitution', async () => {
    const seeded = await seedPaid('refund')
    const refund = vi.spyOn(seeded.provider, 'requestRefund')
    const input = { transactionId: seeded.transactionId, providerRequestId: 'refund-request-1',
      reasonCode: 'CUSTOMER_REQUEST', currency: 'CNY', amountMinor: 1_600,
      provider: seeded.provider, now: NOW }
    const result = await executeShadowCommerceRefund(input)
    expect(result).toMatchObject({ status: 'refunded', transaction: { state: 'refunded' }, request: {
      state: 'refunded', actualAmountMinor: 1_600, providerReceiptId: expect.stringMatching(/^vr-/) } })
    expect((await executeShadowCommerceRefund(input)).request.id).toBe(result.request.id)
    expect(refund).toHaveBeenCalledTimes(1)
    await expect(executeShadowCommerceRefund({ ...input, amountMinor: 1_500 })).rejects.toMatchObject({
      code: 'COMMERCE_REFUND_REPLAY_MISMATCH',
    })
  })

  it('recovers an uncertain refund and never issues a second provider refund', async () => {
    const seeded = await seedPaid('refund-effect')
    seeded.provider.injectFault('request_refund', 'effect_before_timeout')
    const refund = vi.spyOn(seeded.provider, 'requestRefund')
    const input = { transactionId: seeded.transactionId, providerRequestId: 'refund-request-effect',
      reasonCode: 'CUSTOMER_REQUEST', currency: 'CNY', amountMinor: 1_600,
      provider: seeded.provider, now: NOW }
    const result = await executeShadowCommerceRefund(input)
    expect(result.status).toBe('refunded')
    expect(refund).toHaveBeenCalledTimes(1)
    expect((await executeShadowCommerceRefund(input)).request.providerReceiptId).toBe(result.request.providerReceiptId)
    expect(refund).toHaveBeenCalledTimes(1)
    expect(getCommerceRefundRequest(seeded.transactionId, input.providerRequestId)?.state).toBe('refunded')
  })
})

const NOW = '2026-07-15T10:00:00.000Z'

async function seedOrder(suffix: string) {
  const provider = new VirtualCommerceProvider({ provider: 'food_delivery', clock: () => new Date(NOW), catalog: [{
    providerOfferId: `offer-${suffix}`, productId: `product-${suffix}`, skuId: `sku-${suffix}`,
    merchantId: 'merchant-1', merchantName: 'Protein Lab', title: 'Protein meal', unitLabel: 'serving',
    currency: 'CNY', unitPriceMinor: 1_000, available: true, maxQuantity: 10,
    fulfillment: 'delivery', fulfillmentMinutes: 20,
  }] })
  await observeCommerceOffers({ accountId: 'food-account', query: 'protein', limit: 10, adapter: provider })
  const comparison = compareObservedCommerceOffers({ accountId: 'food-account', activeAt: NOW,
    requirement: { query: 'protein', quantity: 1, maxTotalMinor: 2_000,
      deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: [] } }).comparison
  const cart = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
    destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' }).cart
  const quote = (await refreshShadowCommerceQuote({ cartRevisionId: cart.id,
    providerRequestId: `quote-request-${suffix}`, adapter: provider })).quote
  const order = await executeShadowCommerceOrder({ workflowId: `workflow-${suffix}`, intentId: `intent-${suffix}`,
    accountId: 'food-account', quoteId: quote.id, quoteDigest: quote.quoteDigest,
    providerRequestId: `order-request-${suffix}`, amountMinor: quote.breakdown.totalMinor, provider, now: NOW })
  return { provider, quote, transactionId: order.transaction.id }
}

async function seedPaid(suffix: string) {
  const seeded = await seedOrder(suffix)
  await executeShadowCommercePayment({ transactionId: seeded.transactionId, quoteDigest: seeded.quote.quoteDigest,
    providerRequestId: `payment-request-${suffix}`, approvalId: `approval-${suffix}`,
    amountMinor: seeded.quote.breakdown.totalMinor, provider: seeded.provider, now: NOW })
  return seeded
}
