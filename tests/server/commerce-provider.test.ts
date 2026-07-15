import { describe, expect, it } from 'vitest'
import {
  assertCommerceProviderResult,
  CommerceProviderError,
  VirtualCommerceProvider,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('virtual commerce provider', () => {
  it('normalizes bounded food-delivery and Taobao-shaped offer observations', async () => {
    const food = provider('food_delivery')
    const offers = await food.searchOffers({ query: 'protein', limit: 10 })
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({ providerOfferId: 'offer-1', currency: 'CNY',
      fulfillment: 'delivery', observedAt: NOW })
    expect(offers[0]?.sourceDigest).toMatch(/^[a-f0-9]{64}$/)

    const taobao = provider('taobao')
    expect(await taobao.searchOffers({ query: 'protein', limit: 1 })).toMatchObject([
      { providerOfferId: 'offer-1', fulfillment: 'shipping' },
    ])
    await expect(food.searchOffers({ query: '', limit: 10 })).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_INPUT_INVALID', uncertain: false,
    })
  })

  it('returns one quote for one request identity and rejects changed replay material', async () => {
    const adapter = provider('food_delivery')
    const input = quoteRequest()
    const quote = await adapter.refreshQuote(input)
    expect(quote.breakdown).toEqual({ itemsMinor: 1_000, deliveryMinor: 500, serviceMinor: 100,
      taxMinor: 0, discountMinor: 0, totalMinor: 1_600 })
    expect((await adapter.refreshQuote(input)).providerQuoteId).toBe(quote.providerQuoteId)
    await expect(adapter.refreshQuote({ ...input, items: [{ providerOfferId: 'offer-1', quantity: 2 }] }))
      .rejects.toMatchObject({ code: 'COMMERCE_PROVIDER_REQUEST_REPLAY_MISMATCH' })
  })

  it('persists effect-before-timeout and requires lookup before an order retry', async () => {
    const adapter = provider('food_delivery')
    const quote = await adapter.refreshQuote(quoteRequest())
    const request = orderRequest(quote)
    adapter.injectFault('place_order', 'effect_before_timeout')
    await expect(adapter.placeOrder(request)).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_RESULT_UNKNOWN', retryable: true, uncertain: true, waitingUser: false,
    })

    const found = await adapter.lookupOrder({ providerRequestId: request.providerRequestId })
    expect(found).toMatchObject({ status: 'pending_payment', amountMinor: 1_600 })
    expect((await adapter.placeOrder(request)).providerOrderId).toBe(found.providerOrderId)
    await expect(adapter.placeOrder({ ...request, amountMinor: 1_599 })).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_QUOTE_INVALID',
    })
  })

  it('distinguishes timeout-before-effect so lookup proves no order before safe retry', async () => {
    const adapter = provider('taobao')
    const quote = await adapter.refreshQuote(quoteRequest())
    const request = orderRequest(quote)
    adapter.injectFault('place_order', 'timeout_before_effect')
    await expect(adapter.placeOrder(request)).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_TIMEOUT', retryable: true, uncertain: false,
    })
    expect(await adapter.lookupOrder({ providerRequestId: request.providerRequestId }))
      .toMatchObject({ status: 'not_found', providerOrderId: null })
    expect(await adapter.placeOrder(request)).toMatchObject({ status: 'pending_payment' })
  })

  it('finds a paid receipt after an uncertain payment without charging twice', async () => {
    const adapter = provider('food_delivery')
    const quote = await adapter.refreshQuote(quoteRequest())
    const order = await adapter.placeOrder(orderRequest(quote))
    const payment = { providerRequestId: 'payment-request-1', providerOrderId: order.providerOrderId!,
      approvalId: 'approval-exact-1', currency: 'CNY', amountMinor: 1_600 }
    adapter.injectFault('confirm_payment', 'effect_before_timeout')
    await expect(adapter.confirmPayment(payment)).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_RESULT_UNKNOWN', uncertain: true,
    })
    const lookup = await adapter.lookupPayment({ providerRequestId: payment.providerRequestId,
      providerOrderId: payment.providerOrderId })
    expect(lookup).toMatchObject({ status: 'paid', amountMinor: 1_600 })
    expect((await adapter.confirmPayment(payment)).providerReceiptId).toBe(lookup.providerReceiptId)

    expect(await adapter.trackDelivery({ providerOrderId: payment.providerOrderId }))
      .toMatchObject({ state: 'preparing', providerEventId: 'event-0' })
    adapter.advanceDelivery(payment.providerOrderId, 'in_transit')
    expect(await adapter.trackDelivery({ providerOrderId: payment.providerOrderId }))
      .toMatchObject({ state: 'in_transit', providerEventId: 'event-1' })
    adapter.advanceDelivery(payment.providerOrderId, 'delivered')
    expect(await adapter.trackDelivery({ providerOrderId: payment.providerOrderId }))
      .toMatchObject({ state: 'delivered', providerEventId: 'event-2' })
  })

  it('binds cancellation and refund receipts to the original order and request', async () => {
    const cancelAdapter = provider('food_delivery')
    const cancelQuote = await cancelAdapter.refreshQuote(quoteRequest())
    const cancellable = await cancelAdapter.placeOrder(orderRequest(cancelQuote))
    const cancellation = { providerRequestId: 'cancel-request-1', providerOrderId: cancellable.providerOrderId!,
      reasonCode: 'USER_CHANGED_MIND' }
    cancelAdapter.injectFault('cancel_order', 'effect_before_timeout')
    await expect(cancelAdapter.cancelOrder(cancellation)).rejects.toBeInstanceOf(CommerceProviderError)
    expect(await cancelAdapter.lookupCancellation(cancellation)).toMatchObject({ status: 'cancelled' })
    expect((await cancelAdapter.cancelOrder(cancellation)).status).toBe('cancelled')

    const refundAdapter = provider('taobao')
    const refundQuote = await refundAdapter.refreshQuote(quoteRequest())
    const order = await refundAdapter.placeOrder(orderRequest(refundQuote))
    await refundAdapter.confirmPayment({ providerRequestId: 'payment-request-1', providerOrderId: order.providerOrderId!,
      approvalId: 'approval-exact-1', currency: 'CNY', amountMinor: 1_000 })
    const refund = { providerRequestId: 'refund-request-1', providerOrderId: order.providerOrderId!,
      reasonCode: 'ITEM_NOT_NEEDED', currency: 'CNY', amountMinor: 500 }
    expect(await refundAdapter.requestRefund(refund)).toMatchObject({ status: 'refunded', amountMinor: 500 })
    expect(await refundAdapter.lookupRefund(refund)).toMatchObject({ status: 'refunded', amountMinor: 500 })
    await expect(refundAdapter.requestRefund({ ...refund, amountMinor: 600 })).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_REQUEST_REPLAY_MISMATCH',
    })
  })

  it('maps challenges and malformed or credential-shaped provider results to stable errors', async () => {
    const adapter = provider('food_delivery')
    adapter.injectFault('refresh_quote', 'challenge')
    await expect(adapter.refreshQuote(quoteRequest())).rejects.toMatchObject({
      code: 'COMMERCE_PROVIDER_CHALLENGE', retryable: false, uncertain: false, waitingUser: true,
      message: 'COMMERCE_PROVIDER_CHALLENGE',
    })

    expect(() => assertCommerceProviderResult('place_order', {
      schemaVersion: 1, operation: 'place_order', paymentToken: 'secret',
    })).toThrow('COMMERCE_SECRET_FIELD_FORBIDDEN')
    expect(() => assertCommerceProviderResult('place_order', {
      schemaVersion: 1, operation: 'lookup_order',
    })).toThrow('COMMERCE_PROVIDER_RESPONSE_INVALID')
    expect(() => assertCommerceProviderResult('place_order', {
      schemaVersion: 1, operation: 'place_order', text: 'x'.repeat(2_001),
    })).toThrow('COMMERCE_DATA_BOUNDS_EXCEEDED')
  })
})

const NOW = '2026-07-15T10:00:00.000Z'

function provider(kind: 'food_delivery' | 'taobao') {
  return new VirtualCommerceProvider({ provider: kind, clock: () => new Date(NOW), catalog: [{
    providerOfferId: 'offer-1', productId: 'product-1', skuId: 'sku-1', merchantId: 'merchant-1',
    merchantName: 'Protein Lab', title: 'Protein meal', unitLabel: 'serving', currency: 'CNY',
    unitPriceMinor: 1_000, available: true, maxQuantity: 10,
    fulfillment: kind === 'food_delivery' ? 'delivery' : 'shipping', fulfillmentMinutes: 30,
  }] })
}

function quoteRequest() {
  return { providerRequestId: 'quote-request-1', cartDigest: 'a'.repeat(64), currency: 'CNY',
    items: [{ providerOfferId: 'offer-1', quantity: 1 }], destinationToken: 'destination-home',
    substitution: 'deny' as const }
}

function orderRequest(quote: Awaited<ReturnType<VirtualCommerceProvider['refreshQuote']>>) {
  return { providerRequestId: 'order-request-1', providerQuoteId: quote.providerQuoteId,
    quoteDigest: quote.quoteDigest, currency: quote.currency, amountMinor: quote.breakdown.totalMinor }
}
