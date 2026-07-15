import { beforeEach, describe, expect, it, vi } from 'vitest'

const fabric = vi.hoisted(() => ({
  createFabricIntent: vi.fn(), getFabricWorkflow: vi.fn(), listFabricWorkflows: vi.fn(),
}))
const commerce = vi.hoisted(() => ({
  COMMERCE_ASSISTANT_ROLE_ID: 'commerce-assistant', COMMERCE_CANCEL_CAPABILITY: 'commerce.order.cancel',
  COMMERCE_CART_CAPABILITY: 'commerce.cart.prepare', COMMERCE_COMPARE_CAPABILITY: 'commerce.offer.compare',
  COMMERCE_DELIVERY_CAPABILITY: 'commerce.delivery.track', COMMERCE_ORDER_CAPABILITY: 'commerce.order.place',
  COMMERCE_PAYMENT_CAPABILITY: 'commerce.payment.confirm', COMMERCE_QUOTE_CAPABILITY: 'commerce.quote.refresh',
  COMMERCE_REFUND_CAPABILITY: 'commerce.refund.request', COMMERCE_SEARCH_CAPABILITY: 'commerce.product.search',
  COMMERCE_SHADOW_EXECUTOR_ID: 'commerce-shadow',
  CommerceContractError: class CommerceContractError extends Error {},
  compareObservedCommerceOffers: vi.fn(), createCommerceAccount: vi.fn(), getCommerceAccount: vi.fn(),
  getCommerceCartRevision: vi.fn(), getCommerceComparison: vi.fn(), getCommercePaymentAttemptByTransaction: vi.fn(),
  getCommerceOfferSnapshot: vi.fn(), getCommerceQuote: vi.fn(), getCommerceRuntimeStatus: vi.fn(),
  getCommerceTransaction: vi.fn(),
  getConfiguredCommerceProvider: vi.fn(), listCommerceAccounts: vi.fn(), listCommerceActivationReviews: vi.fn(),
  listCommerceCancellationRequests: vi.fn(), listCommerceCartRevisions: vi.fn(), listCommerceCheckpoints: vi.fn(),
  listCommerceComparisons: vi.fn(), listCommerceDeliveryObservations: vi.fn(), listCommerceOfferSnapshots: vi.fn(),
  listCommerceQuotes: vi.fn(), listCommerceRefundRequests: vi.fn(), listCommerceTransactions: vi.fn(),
  prepareCommerceCartFromComparison: vi.fn(), reconcileCommerceRuntime: vi.fn(), refreshCommerceQuote: vi.fn(),
  revokeCommerceAccount: vi.fn(), transitionCommerceAccountMode: vi.fn(), updateCommerceAccountHealth: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/action-fabric', () => fabric)
vi.mock('../../packages/server/src/services/hermes/commerce-autonomy', () => commerce)

const account = { id: 'account-food-1', provider: 'food_delivery', mode: 'shadow', currency: 'CNY',
  executorId: 'commerce-shadow', displayName: 'Food', health: 'healthy', enabled: true, policyEpoch: 3,
  version: 2, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', revokedAt: null }
const offer = { id: 'offer-food-1', accountId: account.id, provider: account.provider,
  providerOfferId: 'provider-offer-private', productId: 'product-1', skuId: 'sku-1', merchantId: 'merchant-1',
  merchantName: 'Merchant', title: 'Lunch', unitLabel: '份', money: { currency: 'CNY', amountMinor: 3200 },
  available: true, maxQuantity: 3, fulfillment: 'delivery', fulfillmentMinutes: 30,
  observedAt: '2026-07-15T00:00:00.000Z', expiresAt: '2026-07-15T01:00:00.000Z', sourceDigest: 'a'.repeat(64) }
const cart = { id: 'cart-food-1', accountId: account.id, revision: 1,
  items: [{ offerSnapshotId: offer.id, quantity: 1 }], destinationToken: 'destination-secret-token',
  recipientToken: 'recipient-secret-token', substitution: 'deny', contentDigest: 'b'.repeat(64),
  createdAt: '2026-07-15T00:00:00.000Z' }
const quote = { id: 'quote-food-1', accountId: account.id, cartRevisionId: cart.id, cartDigest: cart.contentDigest,
  providerQuoteId: 'provider-quote-private', currency: 'CNY', breakdown: { itemsMinor: 3200, deliveryMinor: 300,
    serviceMinor: 0, taxMinor: 0, discountMinor: 0, totalMinor: 3500 }, quoteDigest: 'c'.repeat(64),
  observedAt: '2026-07-15T00:00:00.000Z', expiresAt: '2026-07-15T01:00:00.000Z', status: 'active' }
const transaction = { id: 'transaction-food-1', workflowId: 'workflow-order-1', intentId: 'intent-order-1',
  accountId: account.id, provider: account.provider, mode: 'shadow', policyEpoch: 3, quoteId: quote.id,
  quoteDigest: quote.quoteDigest, providerRequestId: 'provider-request-private', providerOrderId: 'order-1',
  currency: 'CNY', expectedAmountMinor: 3500, actualAmountMinor: null, state: 'waiting_payment', version: 4,
  createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:01:00.000Z', completedAt: null }
const workflow = { id: 'workflow-search-1', intentId: 'intent-search-1', executorId: 'commerce-shadow',
  policyDecisionId: 'decision-1', compensationIntentId: null, state: 'preparing', version: 1, attempt: 0,
  maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, retryAt: null, lastErrorCode: null,
  capabilityId: 'commerce.product.search', goal: 'Search', requestedByRoleId: 'commerce-assistant',
  requestedByUserId: '42', createdAt: 'now', updatedAt: 'now', completedAt: null,
  availableActions: { approve: false, reject: false, cancel: true, retry: false, compensate: false },
  intent: {}, steps: [], policyDecision: null }
const intentResult = { intent: { id: 'intent-search-1', capabilityId: 'commerce.product.search' },
  policyDecision: { id: 'decision-1', outcome: 'allow', reasonCodes: [] }, workflow }

function ctx(options: { body?: unknown; query?: Record<string, unknown>; id?: string } = {}): any {
  const request: Record<string, unknown> = { type: 'application/json' }
  if ('body' in options) request.body = options.body
  return { request, query: options.query ?? {}, params: { id: options.id ?? account.id },
    state: { user: { id: 42, role: 'super_admin' } }, body: null, status: 200 }
}

describe('commerce controller', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(fabric).forEach(mock => mock.mockReset())
    Object.values(commerce).filter(value => typeof value === 'function' && 'mockReset' in value)
      .forEach((mock: any) => mock.mockReset())
    commerce.getCommerceAccount.mockReturnValue(account)
    commerce.getCommerceCartRevision.mockReturnValue(cart)
    commerce.getCommerceOfferSnapshot.mockReturnValue(offer)
    commerce.getCommerceQuote.mockReturnValue(quote)
    commerce.getCommerceTransaction.mockReturnValue(transaction)
    commerce.listCommerceAccounts.mockReturnValue([account])
    commerce.listCommerceOfferSnapshots.mockReturnValue([offer])
    commerce.listCommerceTransactions.mockReturnValue([transaction])
    commerce.listCommerceComparisons.mockReturnValue([])
    commerce.listCommerceCartRevisions.mockReturnValue([])
    commerce.listCommerceQuotes.mockReturnValue([])
    commerce.listCommerceActivationReviews.mockReturnValue([])
    commerce.listCommerceDeliveryObservations.mockReturnValue([])
    commerce.listCommerceCancellationRequests.mockReturnValue([])
    commerce.listCommerceRefundRequests.mockReturnValue([])
    commerce.listCommerceCheckpoints.mockReturnValue([])
    commerce.getCommercePaymentAttemptByTransaction.mockReturnValue(null)
    commerce.getCommerceRuntimeStatus.mockReturnValue({ configuredAccountCount: 1, shadowExecutorEnabled: true,
      liveExecutorEnabled: false, authorizedTargetCount: 5, emergencyStopped: false })
    fabric.listFabricWorkflows.mockReturnValue([workflow])
    fabric.createFabricIntent.mockReturnValue(intentResult)
  })

  it('returns a minimized overview without provider identities or opaque tokens', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const context = ctx()
    await ctrl.overview(context)
    const text = JSON.stringify(context.body)
    expect(context.body.summary).toMatchObject({ accountCount: 1, activeOfferCount: 1, activeTransactionCount: 1 })
    expect(text).not.toContain('provider-offer-private')
    expect(text).not.toContain('provider-request-private')
    expect(text).not.toContain('destination-secret-token')
    expect(text).not.toContain('recipient-secret-token')
  })

  it('creates only observe or shadow accounts and derives the executor binding', async () => {
    commerce.createCommerceAccount.mockReturnValue(account)
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const context = ctx({ body: { id: account.id, provider: 'food_delivery', mode: 'shadow', currency: 'CNY',
      displayName: 'Food', enabled: true } })
    await ctrl.createAccount(context)
    expect(context.status).toBe(201)
    expect(commerce.createCommerceAccount).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'shadow', executorId: 'commerce-shadow',
    }))

    const live = ctx({ body: { id: account.id, provider: 'food_delivery', mode: 'live', currency: 'CNY',
      displayName: 'Food' } })
    await ctrl.createAccount(live)
    expect(live.status).toBe(400)
    expect(commerce.createCommerceAccount).toHaveBeenCalledOnce()
  })

  it('creates governed search intents with server-owned role, actor, target, and environment', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const context = ctx({ body: { accountId: account.id, query: 'lunch', limit: 10,
      idempotencyKey: 'search-request-1', rationale: 'Find lunch' } })
    await ctrl.searchOffers(context)
    expect(context.status).toBe(202)
    expect(fabric.createFabricIntent).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'commerce.product.search', requestedByRoleId: 'commerce-assistant', requestedByUserId: '42',
      environments: ['sandbox'], target: { kind: 'commerce_account', accountId: account.id,
        provider: 'food_delivery', currency: 'CNY' },
    }))
    expect(commerce.reconcileCommerceRuntime).toHaveBeenCalledOnce()
  })

  it('derives order merchant and destination bindings from immutable server material', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const context = ctx({ body: { quoteId: quote.id, providerRequestId: 'order-request-123',
      idempotencyKey: 'order-intent-123', rationale: 'Place exact order' } })
    await ctrl.placeOrder(context)
    const input = fabric.createFabricIntent.mock.calls[0]![0]
    expect(input.input).toMatchObject({ quoteId: quote.id, merchantId: offer.merchantId,
      amountMinor: 3500, destinationDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(input.target).toMatchObject({ merchantId: offer.merchantId,
      destinationDigest: input.input.destinationDigest })
    expect(input.expectedCost).toEqual({ currency: 'CNY', amountMinor: 3500 })
    expect(JSON.stringify(input)).not.toContain(cart.destinationToken)
    expect(JSON.stringify(input)).not.toContain(cart.recipientToken)
  })

  it('rejects cross-account quote material before creating a Fabric intent', async () => {
    commerce.getCommerceCartRevision.mockReturnValue({ ...cart, accountId: 'account-other-1' })
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const context = ctx({ body: { quoteId: quote.id, providerRequestId: 'order-request-123',
      idempotencyKey: 'order-intent-123', rationale: 'Place exact order' } })
    await ctrl.placeOrder(context)
    expect(context).toMatchObject({ status: 400, body: { code: 'COMMERCE_MATERIAL_MISMATCH' } })
    expect(fabric.createFabricIntent).not.toHaveBeenCalled()
  })

  it('returns transaction detail without provider request or recipient material', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const context = ctx({ id: transaction.id })
    await ctrl.transaction(context)
    expect(context.status).toBe(200)
    expect(JSON.stringify(context.body)).not.toContain(transaction.providerRequestId)
    expect(context.body.transaction).not.toHaveProperty('intentId')
  })

  it('rejects unexpected or accessor-backed fields before invoking services', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const unexpected = ctx({ body: { accountId: account.id, query: 'lunch', limit: 10,
      idempotencyKey: 'search-request-1', rationale: 'Find lunch', credential: 'secret' } })
    await ctrl.searchOffers(unexpected)
    expect(unexpected.status).toBe(400)

    let accessed = false
    const body: Record<string, unknown> = { accountId: account.id, query: 'lunch', limit: 10,
      idempotencyKey: 'search-request-1' }
    Object.defineProperty(body, 'rationale', { enumerable: true, get: () => { accessed = true; return 'Find lunch' } })
    const accessor = ctx({ body })
    await ctrl.searchOffers(accessor)
    expect(accessor.status).toBe(400)
    expect(accessed).toBe(false)
    expect(fabric.createFabricIntent).not.toHaveBeenCalled()
  })

  it('rejects credential-shaped action text and redacts provider free text at the API boundary', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/commerce')
    const credential = ctx({ body: { accountId: account.id, query: 'Bearer abcdefghijklmnopqrstuvwxyz', limit: 10,
      idempotencyKey: 'search-request-1', rationale: 'Find lunch' } })
    await ctrl.searchOffers(credential)
    expect(credential.status).toBe(400)
    expect(fabric.createFabricIntent).not.toHaveBeenCalled()

    commerce.listCommerceOfferSnapshots.mockReturnValue([{ ...offer, title: 'Bearer provider-secret-value' }])
    const projected = ctx({ query: { accountId: account.id } })
    await ctrl.offers(projected)
    expect(projected.status).toBe(200)
    expect(projected.body.offers[0].title).toBe('[REDACTED]')
    expect(JSON.stringify(projected.body)).not.toContain('provider-secret-value')
  })
})
