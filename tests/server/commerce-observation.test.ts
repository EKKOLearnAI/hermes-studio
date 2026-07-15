import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareObservedCommerceOffers,
  createCommerceAccount,
  observeCommerceOffers,
  VirtualCommerceProvider,
} from '../../packages/server/src/services/hermes/commerce-autonomy'
import { getTwinEntity, listTwinEvents } from '../../packages/server/src/services/hermes/personal-twin'

describe('commerce offer observation and comparison', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-commerce-observation-'))
    process.env.HERMES_HOME = hermesHome
    createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'observe',
      currency: 'CNY', displayName: 'Food observations' })
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('ingests bounded provider offers and projects idempotent Twin entities and events', async () => {
    const adapter = provider()
    const first = await observeCommerceOffers({ accountId: 'food-account', query: 'meal', limit: 10, adapter })
    expect(first).toHaveLength(2)
    expect(first.map(item => item.disposition)).toEqual(['new', 'new'])
    expect(first[0]?.entity.type).toBe('commerce')
    expect(getTwinEntity(first[0]!.entity.id)).toMatchObject({
      attributes: { provider: 'food_delivery', currency: 'CNY', sourceOfferSnapshotId: first[0]!.offer.id },
    })

    const replay = await observeCommerceOffers({ accountId: 'food-account', query: 'meal', limit: 10, adapter })
    expect(replay.map(item => item.disposition)).toEqual(['replayed', 'replayed'])
    expect(listTwinEvents({ eventType: 'commerce.offer.observed' })).toHaveLength(2)
    expect(JSON.stringify(listTwinEvents({ eventType: 'commerce.offer.observed' }))).not.toMatch(/token|cookie|password/i)
  })

  it('selects deterministically and explains hard exclusions without model judgment', async () => {
    await observeCommerceOffers({ accountId: 'food-account', query: 'meal', limit: 10, adapter: provider() })
    const requirement = { query: 'protein meal', quantity: 1, maxTotalMinor: 1_200,
      deliveryBefore: '2026-07-15T10:45:00.000Z', excludedMerchantIds: [],
      preferenceCodes: ['lowest_price', 'fast_delivery'] }
    const result = compareObservedCommerceOffers({ accountId: 'food-account', requirement, activeAt: NOW })
    expect(result.comparison.selectedOfferSnapshotId).not.toBeNull()
    const selected = result.comparison.candidates.find(candidate =>
      candidate.offerSnapshotId === result.comparison.selectedOfferSnapshotId)
    expect(selected).toMatchObject({ eligible: true, priceMinor: 1_000 })
    expect(selected?.rationaleCodes).toEqual(expect.arrayContaining([
      'available_quantity', 'delivery_speed_preferred', 'fulfillment_known', 'price_preferred', 'within_budget',
    ]))
    expect(result.comparison.candidates.find(candidate => candidate.priceMinor === 1_500))
      .toMatchObject({ eligible: false, score: null, exclusionCodes: ['budget_exceeded', 'delivery_window_missed'] })
    expect(result.disposition).toBe('new')

    const replay = compareObservedCommerceOffers({ accountId: 'food-account', requirement, activeAt: NOW })
    expect(replay.comparison.id).toBe(result.comparison.id)
    expect(replay.disposition).toBe('replayed')
    expect(listTwinEvents({ eventType: 'commerce.comparison.completed' })).toHaveLength(1)
  })

  it('records a comparison with no selection when every offer violates a hard constraint', async () => {
    await observeCommerceOffers({ accountId: 'food-account', query: 'meal', limit: 10, adapter: provider() })
    const result = compareObservedCommerceOffers({
      accountId: 'food-account',
      activeAt: NOW,
      requirement: { query: 'meal', quantity: 1, maxTotalMinor: 100,
        deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: [] },
    })
    expect(result.comparison.selectedOfferSnapshotId).toBeNull()
    expect(result.comparison.candidates.every(candidate => !candidate.eligible
      && candidate.exclusionCodes.includes('budget_exceeded'))).toBe(true)
    expect(result.event.payload).toMatchObject({ eligibleCount: 0, selectedOfferSnapshotId: null })
  })

  it('rejects provider/account substitution before observation', async () => {
    const taobao = new VirtualCommerceProvider({ provider: 'taobao', clock: () => new Date(NOW), catalog: [catalog()[0]!] })
    await expect(observeCommerceOffers({ accountId: 'food-account', query: 'meal', limit: 10, adapter: taobao }))
      .rejects.toThrow('COMMERCE_OBSERVATION_ACCOUNT_UNAVAILABLE')
  })
})

const NOW = '2026-07-15T10:00:00.000Z'

function provider() {
  return new VirtualCommerceProvider({ provider: 'food_delivery', clock: () => new Date(NOW), catalog: catalog() })
}

function catalog() {
  return [
    { providerOfferId: 'offer-fast', productId: 'product-fast', skuId: 'sku-fast', merchantId: 'merchant-a',
      merchantName: 'Fast Kitchen', title: 'Protein meal fast', unitLabel: 'serving', currency: 'CNY',
      unitPriceMinor: 1_000, available: true, maxQuantity: 10, fulfillment: 'delivery' as const,
      fulfillmentMinutes: 20 },
    { providerOfferId: 'offer-slow', productId: 'product-slow', skuId: 'sku-slow', merchantId: 'merchant-b',
      merchantName: 'Slow Kitchen', title: 'Protein meal slow', unitLabel: 'serving', currency: 'CNY',
      unitPriceMinor: 1_500, available: true, maxQuantity: 10, fulfillment: 'delivery' as const,
      fulfillmentMinutes: 60 },
  ]
}
