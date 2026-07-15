import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareObservedCommerceOffers,
  createCommerceAccount,
  observeCommerceOffers,
  prepareCommerceCartFromComparison,
  refreshShadowCommerceQuote,
  VirtualCommerceProvider,
  type CommerceProviderAdapter,
} from '../../packages/server/src/services/hermes/commerce-autonomy'
import { listTwinEvents } from '../../packages/server/src/services/hermes/personal-twin'

describe('commerce cart and shadow quote engine', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-commerce-cart-'))
    process.env.HERMES_HOME = hermesHome
    createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'shadow',
      currency: 'CNY', displayName: 'Food shadow' })
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('builds one immutable cart from the selected comparison and minimizes its Twin event', async () => {
    const { comparison } = await selectedComparison('food-account', provider())
    const projection = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' })
    expect(projection.cart).toMatchObject({ accountId: 'food-account', revision: 1,
      items: [{ offerSnapshotId: comparison.selectedOfferSnapshotId, quantity: 1 }] })
    expect(projection.event.payload).toMatchObject({ destinationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      recipientDigest: expect.stringMatching(/^[a-f0-9]{64}$/), contentDigest: projection.cart.contentDigest })
    expect(JSON.stringify(projection.event)).not.toContain('destination-home')
    expect(JSON.stringify(projection.event)).not.toContain('recipient-self')

    const replay = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' })
    expect(replay.cart.id).toBe(projection.cart.id)
    expect(replay.disposition).toBe('replayed')
  })

  it('refreshes an exact shadow quote without invoking an external-write transport', async () => {
    const adapter = provider()
    const { comparison } = await selectedComparison('food-account', adapter)
    const cart = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' }).cart
    const quote = await refreshShadowCommerceQuote({ cartRevisionId: cart.id,
      providerRequestId: 'quote-request-1', adapter })
    expect(quote).toMatchObject({ mode: 'shadow', externalWriteInvoked: false,
      quote: { cartDigest: cart.contentDigest, currency: 'CNY', breakdown: { totalMinor: 1_600 } } })
    expect(quote.disposition).toBe('new')
    const replay = await refreshShadowCommerceQuote({ cartRevisionId: cart.id,
      providerRequestId: 'quote-request-1', adapter })
    expect(replay.quote.id).toBe(quote.quote.id)
    expect(replay.disposition).toBe('replayed')
    expect(listTwinEvents({ eventType: 'commerce.quote.refreshed' })).toHaveLength(1)
  })

  it('treats destination changes as new material and a new cart/quote identity', async () => {
    const adapter = provider()
    const { comparison } = await selectedComparison('food-account', adapter)
    const first = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' }).cart
    const second = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: 'destination-work', recipientToken: 'recipient-self', substitution: 'deny' }).cart
    expect(second.contentDigest).not.toBe(first.contentDigest)
    expect(second.revision).toBe(2)
    const firstQuote = await refreshShadowCommerceQuote({ cartRevisionId: first.id,
      providerRequestId: 'quote-request-1', adapter })
    const secondQuote = await refreshShadowCommerceQuote({ cartRevisionId: second.id,
      providerRequestId: 'quote-request-2', adapter })
    expect(secondQuote.quote.quoteDigest).not.toBe(firstQuote.quote.quoteDigest)
  })

  it('prevents quote execution in observe mode and blocks external transports in shadow mode', async () => {
    createCommerceAccount({ id: 'observe-account', provider: 'food_delivery', mode: 'observe',
      currency: 'CNY', displayName: 'Observe only' })
    const observeAdapter = provider()
    const { comparison: observed } = await selectedComparison('observe-account', observeAdapter)
    const observeCart = prepareCommerceCartFromComparison({ comparisonId: observed.id,
      destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' }).cart
    await expect(refreshShadowCommerceQuote({ cartRevisionId: observeCart.id,
      providerRequestId: 'quote-request-1', adapter: observeAdapter }))
      .rejects.toThrow('COMMERCE_QUOTE_MODE_FORBIDDEN')

    const shadowAdapter = provider()
    const { comparison } = await selectedComparison('food-account', shadowAdapter)
    const cart = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' }).cart
    const refreshQuote = vi.fn()
    const external = { provider: 'food_delivery', transport: 'external', refreshQuote } as unknown as CommerceProviderAdapter
    await expect(refreshShadowCommerceQuote({ cartRevisionId: cart.id,
      providerRequestId: 'quote-request-external', adapter: external }))
      .rejects.toThrow('COMMERCE_SHADOW_EXTERNAL_TRANSPORT_FORBIDDEN')
    expect(refreshQuote).not.toHaveBeenCalled()
  })

  it('rejects a provider quote whose cart or quote digest was substituted', async () => {
    const adapter = provider()
    const { comparison } = await selectedComparison('food-account', adapter)
    const cart = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' }).cart
    const original = adapter.refreshQuote.bind(adapter)
    adapter.refreshQuote = async input => ({ ...await original(input), cartDigest: 'f'.repeat(64) })
    await expect(refreshShadowCommerceQuote({ cartRevisionId: cart.id,
      providerRequestId: 'quote-request-bad', adapter })).rejects.toThrow('COMMERCE_PROVIDER_QUOTE_MISMATCH')
  })
})

const NOW = '2026-07-15T10:00:00.000Z'

function provider() {
  return new VirtualCommerceProvider({ provider: 'food_delivery', clock: () => new Date(NOW), catalog: [{
    providerOfferId: 'offer-1', productId: 'product-1', skuId: 'sku-1', merchantId: 'merchant-1',
    merchantName: 'Protein Lab', title: 'Protein meal', unitLabel: 'serving', currency: 'CNY',
    unitPriceMinor: 1_000, available: true, maxQuantity: 10, fulfillment: 'delivery', fulfillmentMinutes: 20,
  }] })
}

async function selectedComparison(accountId: string, adapter: VirtualCommerceProvider) {
  await observeCommerceOffers({ accountId, query: 'protein', limit: 10, adapter })
  return compareObservedCommerceOffers({ accountId, activeAt: NOW,
    requirement: { query: 'protein', quantity: 1, maxTotalMinor: 2_000,
      deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: [] } })
}
