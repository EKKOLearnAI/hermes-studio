import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureBuiltInFabricRegistry,
  getFabricControlState,
  listFabricExecutors,
  setFabricEmergencyStop,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  compareObservedCommerceOffers,
  COMMERCE_LIVE_EXECUTOR_ID,
  COMMERCE_SHADOW_EXECUTOR_ID,
  configureCommerceRuntimeBindings,
  createCommerceAccount,
  executeShadowCommerceOrder,
  executeShadowCommercePayment,
  getCommerceAccount,
  getCommerceRuntimeStatus,
  listCommerceActivationReviews,
  observeCommerceOffers,
  prepareCommerceCartFromComparison,
  reconcileCommerceRuntime,
  refreshShadowCommerceQuote,
  revokeCommerceAccount,
  stopCommerceRuntime,
  transitionCommerceAccountMode,
  updateCommerceAccountHealth,
  VirtualCommerceProvider,
  type CommerceProviderAdapter,
} from '../../packages/server/src/services/hermes/commerce-autonomy'
import { getAssistantRole } from '../../packages/server/src/services/hermes/personal-twin'

describe('commerce activation and runtime recovery', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-commerce-activation-'))
    process.env.HERMES_HOME = home
    ensureBuiltInFabricRegistry()
    configureCommerceRuntimeBindings(null)
  })

  afterEach(() => {
    try { stopCommerceRuntime() } catch { /* a test may stop before registry setup completes */ }
    configureCommerceRuntimeBindings(null)
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('requires super-admin, shadow mode, recent terminal evidence, and positive bounded limits for live activation', async () => {
    const provider = createProvider()
    let account = createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'observe',
      currency: 'CNY', executorId: COMMERCE_SHADOW_EXECUTOR_ID, displayName: 'Food' })
    account = updateCommerceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    expect(() => transitionCommerceAccountMode({ accountId: account.id, toMode: 'shadow', actorUserId: 'admin-1',
      actorIsSuperAdmin: false, limits: limits(), now: NOW })).toThrow('COMMERCE_ACTIVATION_SUPER_ADMIN_REQUIRED')
    account = transitionCommerceAccountMode({ accountId: account.id, toMode: 'shadow', actorUserId: 'admin-1',
      actorIsSuperAdmin: true, limits: limits(), now: NOW }).account
    expect(account).toMatchObject({ mode: 'shadow', executorId: COMMERCE_SHADOW_EXECUTOR_ID, policyEpoch: 2 })
    await seedPaid(provider, 'activation')

    const activated = transitionCommerceAccountMode({ accountId: account.id, toMode: 'live', actorUserId: 'admin-1',
      actorIsSuperAdmin: true, limits: limits(), now: LATER })
    expect(activated).toMatchObject({ account: { mode: 'live', executorId: COMMERCE_LIVE_EXECUTOR_ID,
      policyEpoch: 3 }, review: { approved: true, shadowEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(getAssistantRole('commerce-assistant')?.spendingLimits).toEqual({
      currency: 'CNY', perAction: 5_000, daily: 10_000,
    })
    const reviews = listCommerceActivationReviews(account.id)
    expect(reviews).toHaveLength(2)
    expect(reviews[0]?.toMode).toBe('live')
  })

  it('records a denied review when recent shadow evidence is absent and forbids direct live creation', () => {
    expect(() => createCommerceAccount({ id: 'live-account', provider: 'food_delivery', mode: 'live',
      currency: 'CNY', executorId: COMMERCE_LIVE_EXECUTOR_ID, displayName: 'Unsafe' }))
      .toThrow('COMMERCE_ACCOUNT_INPUT_INVALID')
    let account = createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'shadow',
      currency: 'CNY', executorId: COMMERCE_SHADOW_EXECUTOR_ID, displayName: 'Food' })
    account = updateCommerceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    expect(() => transitionCommerceAccountMode({ accountId: account.id, toMode: 'live', actorUserId: 'admin-1',
      actorIsSuperAdmin: true, limits: limits(), now: LATER })).toThrow('COMMERCE_ACTIVATION_GATE_FAILED')
    expect(getCommerceAccount(account.id)?.mode).toBe('shadow')
    expect(listCommerceActivationReviews(account.id)).toEqual([
      expect.objectContaining({ approved: false, fromMode: 'shadow', toMode: 'live', shadowEvidenceDigest: null }),
    ])
  })

  it('normalizes malformed activation clocks to a stable commerce error', () => {
    createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'observe',
      currency: 'CNY', executorId: null, displayName: 'Food' })
    expect(() => transitionCommerceAccountMode({ accountId: 'food-account', toMode: 'shadow',
      actorUserId: 'admin-1', actorIsSuperAdmin: true, limits: limits(), now: 'not-a-timestamp' }))
      .toThrow('COMMERCE_TIME_INVALID')
  })

  it('invalidates stale transaction policy epochs and makes account revocation permanent', async () => {
    const provider = createProvider()
    let account = createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'shadow',
      currency: 'CNY', executorId: COMMERCE_SHADOW_EXECUTOR_ID, displayName: 'Food' })
    account = updateCommerceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    const seeded = await seedPaid(provider, 'stale')
    account = transitionCommerceAccountMode({ accountId: account.id, toMode: 'live', actorUserId: 'admin-1',
      actorIsSuperAdmin: true, limits: limits(), now: LATER }).account
    await expect(executeShadowCommercePayment({ transactionId: seeded.transactionId,
      quoteDigest: seeded.quoteDigest, providerRequestId: 'payment-request-stale', approvalId: 'approval-stale',
      amountMinor: 1_600, provider, now: LATER })).rejects.toMatchObject({
      code: 'COMMERCE_PAYMENT_MATERIAL_MISMATCH',
    })
    const revoked = revokeCommerceAccount({ accountId: account.id, actorUserId: 'admin-1', actorIsSuperAdmin: true,
      expectedVersion: account.version, now: LATER })
    expect(revoked).toMatchObject({ health: 'revoked', enabled: false, policyEpoch: 3 })
    expect(() => updateCommerceAccountHealth({ accountId: account.id, expectedVersion: revoked.version,
      health: 'healthy', now: LATER })).toThrow('COMMERCE_ACCOUNT_REVOKED')
  })

  it('reconciles exact transport bindings and disables live execution under emergency stop', async () => {
    const virtual = createProvider()
    let account = createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'shadow',
      currency: 'CNY', executorId: COMMERCE_SHADOW_EXECUTOR_ID, displayName: 'Food' })
    account = updateCommerceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    await seedPaid(virtual, 'runtime')
    account = transitionCommerceAccountMode({ accountId: account.id, toMode: 'live', actorUserId: 'admin-1',
      actorIsSuperAdmin: true, limits: limits(), now: LATER }).account
    const external = externalView(virtual)
    configureCommerceRuntimeBindings([{ accountId: account.id, provider: external,
      merchantIds: ['merchant-1'], destinationDigests: ['d'.repeat(64)] }])
    expect(reconcileCommerceRuntime()).toMatchObject({ configuredAccountCount: 1,
      liveExecutorEnabled: true, emergencyStopped: false })
    expect(listFabricExecutors().find(item => item.id === COMMERCE_LIVE_EXECUTOR_ID)?.enabled).toBe(true)

    const control = getFabricControlState()
    setFabricEmergencyStop(3, 'admin-1', 'commerce emergency', control.version)
    expect(reconcileCommerceRuntime()).toMatchObject({ liveExecutorEnabled: false, emergencyStopped: true })
    expect(getCommerceRuntimeStatus().authorizedTargetCount).toBe(0)
  })

  it('authorizes observe accounts as read-only without mutating existing assistant roles', () => {
    const homeRole = structuredClone(getAssistantRole('home-manager'))
    const entertainmentRole = structuredClone(getAssistantRole('entertainment-assistant'))
    const provider = createProvider()
    const account = createCommerceAccount({ id: 'food-account', provider: 'food_delivery', mode: 'observe',
      currency: 'CNY', executorId: null, displayName: 'Food observer' })
    configureCommerceRuntimeBindings([{ accountId: account.id, provider,
      merchantIds: ['merchant-1'], destinationDigests: ['d'.repeat(64)] }])

    expect(reconcileCommerceRuntime()).toMatchObject({ configuredAccountCount: 1,
      shadowExecutorEnabled: true, liveExecutorEnabled: false, emergencyStopped: false })
    expect(getAssistantRole('commerce-assistant')).toMatchObject({
      capabilityScope: { allow: ['commerce.cart.prepare', 'commerce.offer.compare', 'commerce.product.search'],
        deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'low', requireApprovalAbove: 'low' },
    })
    expect(getAssistantRole('home-manager')).toEqual(homeRole)
    expect(getAssistantRole('entertainment-assistant')).toEqual(entertainmentRole)
  })
})

const NOW = '2026-07-15T10:00:00.000Z'
const LATER = '2026-07-15T11:00:00.000Z'

function limits() { return { currency: 'CNY', perActionMinor: 5_000, dailyMinor: 10_000,
  merchantIds: ['merchant-1'], destinationDigests: ['d'.repeat(64)] } }

function createProvider() {
  return new VirtualCommerceProvider({ provider: 'food_delivery', clock: () => new Date(NOW), catalog: [{
    providerOfferId: 'offer-1', productId: 'product-1', skuId: 'sku-1', merchantId: 'merchant-1',
    merchantName: 'Protein Lab', title: 'Protein meal', unitLabel: 'serving', currency: 'CNY',
    unitPriceMinor: 1_000, available: true, maxQuantity: 10, fulfillment: 'delivery', fulfillmentMinutes: 20,
  }] })
}

async function seedPaid(provider: VirtualCommerceProvider, suffix: string) {
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
    providerRequestId: `order-request-${suffix}`, amountMinor: 1_600, provider, now: NOW })
  await executeShadowCommercePayment({ transactionId: order.transaction.id, quoteDigest: quote.quoteDigest,
    providerRequestId: `payment-request-${suffix}`, approvalId: `approval-${suffix}`,
    amountMinor: 1_600, provider, now: NOW })
  return { transactionId: order.transaction.id, quoteDigest: quote.quoteDigest }
}

function externalView(provider: VirtualCommerceProvider): CommerceProviderAdapter {
  return new Proxy(provider, { get(target, property) {
    if (property === 'transport') return 'external'
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as CommerceProviderAdapter
}
