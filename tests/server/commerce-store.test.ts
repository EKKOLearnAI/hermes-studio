import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendCommerceCheckpoint,
  commerceCanonicalDigest,
  createCommerceAccount,
  createCommerceCartRevision,
  createCommerceComparison,
  createCommerceQuote,
  createCommerceTransaction,
  expireCommerceQuotes,
  getCommerceCartRevision,
  getCommerceQuote,
  getCommerceTransactionByWorkflow,
  listCommerceAccounts,
  listCommerceCheckpoints,
  listCommerceOfferSnapshots,
  recordCommerceOfferSnapshot,
  transitionCommerceTransaction,
  withCommerceAutonomyDb,
  type CommerceOfferSnapshot,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('commerce autonomy store', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-commerce-store-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('creates fail-closed observe/shadow accounts and binds replay to exact material', () => {
    expect(createCommerceAccount(account())).toMatchObject({
      id: 'food-account', provider: 'food_delivery', mode: 'shadow', currency: 'CNY',
      health: 'unknown', enabled: true, policyEpoch: 1, version: 1,
    })
    expect(createCommerceAccount(account()).id).toBe('food-account')
    expect(() => createCommerceAccount(account({ displayName: 'Substituted' })))
      .toThrow('COMMERCE_ACCOUNT_REPLAY_MISMATCH')
    expect(() => createCommerceAccount(account({ mode: 'live' as never }))).toThrow('COMMERCE_ACCOUNT_INPUT_INVALID')
    expect(listCommerceAccounts()).toHaveLength(1)
  })

  it('uses locale-independent canonical digests and idempotent immutable offer snapshots', () => {
    createCommerceAccount(account())
    expect(commerceCanonicalDigest({ a: 1, b: { c: 2 } }))
      .toBe(commerceCanonicalDigest({ b: { c: 2 }, a: 1 }))

    const offer = recordCommerceOfferSnapshot(offerInput())
    expect(recordCommerceOfferSnapshot(offerInput()).id).toBe(offer.id)
    expect(() => recordCommerceOfferSnapshot(offerInput({ title: 'Changed title' })))
      .toThrow('COMMERCE_OFFER_REPLAY_MISMATCH')
    expect(listCommerceOfferSnapshots({ accountId: 'food-account', activeAt: MID })).toEqual([offer])
    expect(listCommerceOfferSnapshots({ accountId: 'food-account', activeAt: AFTER })).toEqual([])
    expect(() => recordCommerceOfferSnapshot(offerInput({ currency: 'USD', sourceDigest: 'b'.repeat(64) })))
      .toThrow('COMMERCE_OFFER_ACCOUNT_MISMATCH')
  })

  it('binds deterministic comparisons to exact same-account offer prices', () => {
    createCommerceAccount(account())
    const first = recordCommerceOfferSnapshot(offerInput())
    const second = recordCommerceOfferSnapshot(offerInput({
      providerOfferId: 'offer-provider-2', productId: 'product-2', skuId: 'sku-2',
      unitPriceMinor: 1_200, sourceDigest: 'b'.repeat(64),
    }))
    const input = {
      accountId: 'food-account',
      requirement: { query: 'high protein meal', quantity: 1, maxTotalMinor: 2_000,
        deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: ['fast_delivery'] },
      candidates: [candidate(second, 900_000), candidate(first, 950_000)],
      selectedOfferSnapshotId: first.id,
      createdAt: OBSERVED,
    }
    const comparison = createCommerceComparison(input)
    expect(comparison.candidates.map(item => item.offerSnapshotId)).toEqual([first.id, second.id].sort())
    expect(createCommerceComparison(input).id).toBe(comparison.id)
    expect(() => createCommerceComparison({ ...input,
      candidates: [{ ...candidate(first, 1), priceMinor: 9_999 }], selectedOfferSnapshotId: first.id }))
      .toThrow('COMMERCE_COMPARISON_OFFER_MISMATCH')

    createCommerceAccount(account({ id: 'other-account', provider: 'taobao' }))
    expect(() => createCommerceComparison({ ...input, accountId: 'other-account' }))
      .toThrow('COMMERCE_COMPARISON_OFFER_MISMATCH')
  })

  it('creates immutable sorted cart revisions and material quote replacements', () => {
    createCommerceAccount(account())
    const first = recordCommerceOfferSnapshot(offerInput())
    const second = recordCommerceOfferSnapshot(offerInput({
      providerOfferId: 'offer-provider-2', productId: 'product-2', skuId: 'sku-2',
      unitPriceMinor: 500, sourceDigest: 'b'.repeat(64),
    }))
    const cartInput = { accountId: 'food-account', items: [
      { offerSnapshotId: second.id, quantity: 2 }, { offerSnapshotId: first.id, quantity: 1 },
    ], destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny' as const,
    createdAt: OBSERVED }
    const cart = createCommerceCartRevision(cartInput)
    expect(cart.items.map(item => item.offerSnapshotId)).toEqual([first.id, second.id].sort())
    expect(createCommerceCartRevision({ ...cartInput, items: [...cartInput.items].reverse() }).id).toBe(cart.id)
    expect(getCommerceCartRevision(cart.id)?.contentDigest).toBe(cart.contentDigest)
    expect(createCommerceCartRevision({ ...cartInput, destinationToken: 'destination-work' }).revision).toBe(2)

    const quote = createCommerceQuote(quoteInput(cart.id))
    expect(quote.breakdown.totalMinor).toBe(2_100)
    expect(createCommerceQuote(quoteInput(cart.id)).id).toBe(quote.id)
    expect(() => createCommerceQuote(quoteInput(cart.id, { breakdown: { ...BREAKDOWN, totalMinor: 2_101 } })))
      .toThrow('COMMERCE_QUOTE_TOTAL_INVALID')

    const replacement = createCommerceQuote(quoteInput(cart.id, {
      providerQuoteId: 'provider-quote-2', observedAt: MID, expiresAt: AFTER,
      breakdown: { ...BREAKDOWN, deliveryMinor: 200, totalMinor: 2_200 },
    }))
    expect(getCommerceQuote(quote.id)?.status).toBe('superseded')
    expect(replacement.status).toBe('active')
    expect(expireCommerceQuotes(AFTER)).toBe(1)
    expect(getCommerceQuote(replacement.id)?.status).toBe('expired')
  })

  it('replays one workflow identity and enforces CAS transitions, amount, and order binding', () => {
    const quote = seedActiveQuote()
    const transactionInput = { workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1',
      accountId: 'food-account', quoteId: quote.id, providerRequestId: 'request-order-1', createdAt: MID }
    const transaction = createCommerceTransaction(transactionInput)
    expect(expireCommerceQuotes(AFTER)).toBe(1)
    expect(createCommerceTransaction(transactionInput).id).toBe(transaction.id)
    expect(getCommerceTransactionByWorkflow(transaction.workflowId)?.quoteDigest).toBe(quote.quoteDigest)
    expect(() => createCommerceTransaction({ ...transactionInput, intentId: 'intent-commerce-2' }))
      .toThrow('COMMERCE_TRANSACTION_REPLAY_MISMATCH')

    const quoted = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: 1,
      state: 'quoted', updatedAt: MID })
    expect(quoted.version).toBe(2)
    expect(() => transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: 1,
      state: 'waiting_approval', updatedAt: MID })).toThrow('COMMERCE_TRANSACTION_VERSION_CONFLICT')
    expect(() => transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: 2,
      state: 'paid', updatedAt: MID })).toThrow('COMMERCE_TRANSACTION_TRANSITION_INVALID')
    const approval = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: 2,
      state: 'waiting_approval', updatedAt: MID })
    const submitting = transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: approval.version,
      state: 'submitting_order', providerOrderId: 'provider-order-1', updatedAt: MID })
    expect(() => transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: submitting.version,
      state: 'order_pending', providerOrderId: 'provider-order-2', updatedAt: MID }))
      .toThrow('COMMERCE_ORDER_ID_SUBSTITUTION')
    expect(() => transitionCommerceTransaction({ transactionId: transaction.id, expectedVersion: submitting.version,
      state: 'order_pending', actualAmountMinor: 2_101, updatedAt: MID }))
      .toThrow('COMMERCE_TRANSACTION_AMOUNT_INCREASED')
  })

  it('deduplicates immutable checkpoints and rejects credential-shaped evidence', () => {
    const transaction = createCommerceTransaction({ workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1',
      accountId: 'food-account', quoteId: seedActiveQuote().id, providerRequestId: 'request-order-1', createdAt: MID })
    const checkpoint = appendCommerceCheckpoint({ transactionId: transaction.id, stage: 'quote_bound',
      evidenceDigest: 'd'.repeat(64), details: { quoteId: transaction.quoteId, amountMinor: 2_100 }, observedAt: MID })
    expect(appendCommerceCheckpoint({ transactionId: transaction.id, stage: 'quote_bound',
      evidenceDigest: 'd'.repeat(64), details: { amountMinor: 2_100, quoteId: transaction.quoteId }, observedAt: AFTER }).ordinal)
      .toBe(checkpoint.ordinal)
    expect(appendCommerceCheckpoint({ transactionId: transaction.id, stage: 'policy_checked',
      details: { outcome: 'shadowed' }, observedAt: AFTER }).ordinal).toBe(1)
    expect(listCommerceCheckpoints(transaction.id).map(item => item.stage)).toEqual(['quote_bound', 'policy_checked'])
    expect(() => appendCommerceCheckpoint({ transactionId: transaction.id, stage: 'provider_result',
      details: { paymentToken: 'forbidden' } })).toThrow('COMMERCE_SECRET_FIELD_FORBIDDEN')

    expect(withCommerceAutonomyDb(db => db.prepare(
      "SELECT COUNT(*) AS count FROM commerce_checkpoints WHERE details_json LIKE '%forbidden%'",
    ).get())).toEqual({ count: 0 })
  })
})

const OBSERVED = '2026-07-15T10:00:00.000Z'
const MID = '2026-07-15T10:10:00.000Z'
const EXPIRES = '2026-07-15T10:20:00.000Z'
const AFTER = '2026-07-15T10:30:00.000Z'
const BREAKDOWN = { itemsMinor: 2_000, deliveryMinor: 100, serviceMinor: 0,
  taxMinor: 0, discountMinor: 0, totalMinor: 2_100 }

function account(override: Record<string, unknown> = {}) {
  return { id: 'food-account', provider: 'food_delivery' as const, mode: 'shadow' as const,
    currency: 'CNY', displayName: 'Food delivery shadow', ...override }
}

function offerInput(override: Record<string, unknown> = {}) {
  return { accountId: 'food-account', provider: 'food_delivery' as const, providerOfferId: 'offer-provider-1',
    productId: 'product-1', skuId: 'sku-1', merchantId: 'merchant-1', merchantName: 'Meal Lab',
    title: 'Protein meal', unitLabel: 'serving', currency: 'CNY', unitPriceMinor: 1_000, available: true,
    maxQuantity: 10, fulfillment: 'delivery' as const, fulfillmentMinutes: 30, observedAt: OBSERVED,
    expiresAt: EXPIRES, sourceDigest: 'a'.repeat(64), ...override }
}

function candidate(offer: CommerceOfferSnapshot, score: number) {
  return { offerSnapshotId: offer.id, eligible: true, score, priceMinor: offer.money.amountMinor,
    fulfillmentMinutes: offer.fulfillmentMinutes, exclusionCodes: [], rationaleCodes: ['within_budget'] }
}

function quoteInput(cartRevisionId: string, override: Record<string, unknown> = {}) {
  return { accountId: 'food-account', cartRevisionId, providerQuoteId: 'provider-quote-1', currency: 'CNY',
    breakdown: BREAKDOWN, observedAt: OBSERVED, expiresAt: EXPIRES, ...override }
}

function seedActiveQuote() {
  createCommerceAccount(account())
  const offer = recordCommerceOfferSnapshot(offerInput())
  const cart = createCommerceCartRevision({ accountId: 'food-account', items: [{ offerSnapshotId: offer.id, quantity: 2 }],
    destinationToken: 'destination-home', recipientToken: 'recipient-self', substitution: 'deny', createdAt: OBSERVED })
  return createCommerceQuote(quoteInput(cart.id))
}
