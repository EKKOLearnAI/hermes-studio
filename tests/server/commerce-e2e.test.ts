import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approveFabricWorkflow,
  createFabricIntent,
  ensureBuiltInFabricRegistry,
  getFabricWorkflow,
  processActionFabricOnce,
  registerFabricExecutorAdapter,
  unregisterFabricExecutorAdapter,
  type FabricActionIntentInput,
  type FabricJsonObject,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  COMMERCE_CART_CAPABILITY,
  COMMERCE_COMPARE_CAPABILITY,
  COMMERCE_DELIVERY_CAPABILITY,
  COMMERCE_ORDER_CAPABILITY,
  COMMERCE_PAYMENT_CAPABILITY,
  COMMERCE_QUOTE_CAPABILITY,
  COMMERCE_REFUND_CAPABILITY,
  COMMERCE_SEARCH_CAPABILITY,
  COMMERCE_SHADOW_EXECUTOR_ID,
  compareObservedCommerceOffers,
  configureCommerceRuntimeBindings,
  createCommerceAccount,
  createConfiguredCommerceExecutorAdapters,
  getCommerceTransaction,
  listCommerceCheckpoints,
  listCommerceDeliveryObservations,
  listCommerceOfferSnapshots,
  listCommerceRefundRequests,
  prepareCommerceCartFromComparison,
  reconcileCommerceRuntime,
  refreshCommerceQuote,
  stopCommerceRuntime,
  transitionCommerceAccountMode,
  updateCommerceAccountHealth,
  VirtualCommerceProvider,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('commerce autonomy end-to-end', () => {
  const originalHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''
  let registeredAdapters: string[] = []
  let workerTick = 0
  let food: VirtualCommerceProvider
  let taobao: VirtualCommerceProvider

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-commerce-e2e-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'commerce-e2e-managed-audit-key-at-least-32-bytes'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    ensureBuiltInFabricRegistry()
    activateShadowAccount('food-account', 'food_delivery', 'merchant-food')
    activateShadowAccount('taobao-account', 'taobao', 'merchant-taobao')
    food = provider('food_delivery', 'food-offer', 'protein-bowl', 'protein-sku', 'merchant-food',
      'Protein Lab', 'Protein bowl', 'serving', 1_000, 'delivery')
    taobao = provider('taobao', 'taobao-offer', 'keyboard', 'keyboard-sku', 'merchant-taobao',
      'Key Store', 'Mechanical keyboard', 'item', 29_900, 'shipping')
    configureCommerceRuntimeBindings([
      { accountId: 'food-account', provider: food, merchantIds: ['merchant-food'],
        destinationDigests: [destinationDigest()] },
      { accountId: 'taobao-account', provider: taobao, merchantIds: ['merchant-taobao'],
        destinationDigests: [destinationDigest()] },
    ])
    expect(reconcileCommerceRuntime()).toMatchObject({ configuredAccountCount: 2,
      shadowExecutorEnabled: true, liveExecutorEnabled: false, emergencyStopped: false })
    registerCommerceAdapters()
  })

  afterEach(() => {
    unregisterCommerceAdapters()
    try { stopCommerceRuntime() } catch { /* registry may already be torn down by a failed test */ }
    configureCommerceRuntimeBindings(null)
    vi.useRealTimers()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('routes two providers and closes an approved order, payment, delivery, restart, and refund loop', async () => {
    const foodSearch = await runIntent(intent(COMMERCE_SEARCH_CAPABILITY,
      { ...base('food-account', 'food_delivery'), query: 'protein', limit: 10 },
      baseTarget('food-account', 'food_delivery'), 'food-search'))
    const taobaoSearch = await runIntent(intent(COMMERCE_SEARCH_CAPABILITY,
      { ...base('taobao-account', 'taobao'), query: 'keyboard', limit: 10 },
      baseTarget('taobao-account', 'taobao'), 'taobao-search'))
    expect(foodSearch).toMatchObject({ operation: 'search', totalCount: 1 })
    expect(taobaoSearch).toMatchObject({ operation: 'search', totalCount: 1 })
    expect(listCommerceOfferSnapshots({ accountId: 'food-account' })[0]).toMatchObject({ provider: 'food_delivery' })
    expect(listCommerceOfferSnapshots({ accountId: 'taobao-account' })[0]).toMatchObject({ provider: 'taobao' })

    const comparison = compareObservedCommerceOffers({ accountId: 'food-account', activeAt: NOW,
      requirement: { query: 'protein', quantity: 1, maxTotalMinor: 2_000,
        deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: [] } }).comparison
    await runIntent(intent(COMMERCE_COMPARE_CAPABILITY,
      { ...base('food-account', 'food_delivery'), comparisonId: comparison.id,
        inputDigest: comparison.inputDigest }, baseTarget('food-account', 'food_delivery'), 'compare'))
    const cart = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: DESTINATION, recipientToken: 'recipient-self-e2e', substitution: 'deny' }).cart
    await runIntent(intent(COMMERCE_CART_CAPABILITY,
      { ...base('food-account', 'food_delivery'), comparisonId: comparison.id, cartRevisionId: cart.id,
        cartDigest: cart.contentDigest, destinationDigest: destinationDigest() },
      baseTarget('food-account', 'food_delivery'), 'cart'))
    const quote = (await refreshCommerceQuote({ cartRevisionId: cart.id,
      providerRequestId: 'quote-request-e2e', adapter: food })).quote
    await runIntent(intent(COMMERCE_QUOTE_CAPABILITY,
      { ...base('food-account', 'food_delivery'), cartRevisionId: cart.id, cartDigest: cart.contentDigest,
        quoteId: quote.id, quoteDigest: quote.quoteDigest, amountMinor: quote.breakdown.totalMinor },
      baseTarget('food-account', 'food_delivery'), 'quote'))

    const orderCreated = createFabricIntent(intent(COMMERCE_ORDER_CAPABILITY,
      { ...base('food-account', 'food_delivery'), merchantId: 'merchant-food',
        destinationDigest: destinationDigest(), quoteId: quote.id, quoteDigest: quote.quoteDigest,
        providerRequestId: 'order-request-e2e', amountMinor: quote.breakdown.totalMinor },
      transactionTarget(), 'order', quote.breakdown.totalMinor))
    expect(orderCreated.policyDecision.outcome).toBe('waiting_user')
    approveFabricWorkflow(orderCreated.workflow.id, ACTOR)
    await runWorkerPhase(orderCreated.workflow.id, 'prepare')
    unregisterCommerceAdapters()
    registerCommerceAdapters()
    expect(await runWorkflowToSuccess(orderCreated.workflow.id)).toContain('execute')
    const orderOutput = executeOutput(orderCreated.workflow.id)
    const transactionId = String(orderOutput.transactionId)
    expect(orderOutput).toMatchObject({ operation: 'order_place', status: 'shadowed',
      providerOrderId: expect.stringMatching(/^vo-/), amountMinor: quote.breakdown.totalMinor })

    await runIntent(intent(COMMERCE_PAYMENT_CAPABILITY,
      { ...base('food-account', 'food_delivery'), merchantId: 'merchant-food',
        destinationDigest: destinationDigest(), transactionId, quoteDigest: quote.quoteDigest,
        approvalId: 'approval-payment-e2e', amountMinor: quote.breakdown.totalMinor },
      transactionTarget(), 'payment'))
    await runIntent(intent(COMMERCE_DELIVERY_CAPABILITY,
      { ...base('food-account', 'food_delivery'), transactionId },
      baseTarget('food-account', 'food_delivery'), 'delivery'))
    await runIntent(intent(COMMERCE_REFUND_CAPABILITY,
      { ...base('food-account', 'food_delivery'), merchantId: 'merchant-food',
        destinationDigest: destinationDigest(), transactionId, providerRequestId: 'refund-request-e2e',
        reasonCode: 'CUSTOMER_REQUEST', amountMinor: quote.breakdown.totalMinor },
      transactionTarget(), 'refund'))

    expect(getCommerceTransaction(transactionId)).toMatchObject({ state: 'refunded',
      expectedAmountMinor: quote.breakdown.totalMinor, actualAmountMinor: quote.breakdown.totalMinor })
    expect(listCommerceDeliveryObservations(transactionId)).toEqual([
      expect.objectContaining({ state: 'preparing', providerEventId: 'event-0' }),
    ])
    expect(listCommerceRefundRequests(transactionId)).toEqual([
      expect.objectContaining({ state: 'refunded', actualAmountMinor: quote.breakdown.totalMinor }),
    ])
    expect(listCommerceCheckpoints(transactionId).map(item => item.stage)).toEqual(expect.arrayContaining([
      'order_verified', 'payment_verified', 'delivery_observed', 'refund_refunded',
    ]))
  }, 15_000)

  function activateShadowAccount(accountId: string, providerKind: 'food_delivery' | 'taobao', merchantId: string): void {
    let account = createCommerceAccount({ id: accountId, provider: providerKind, mode: 'observe', currency: 'CNY',
      executorId: null, displayName: accountId })
    account = updateCommerceAccountHealth({ accountId, expectedVersion: account.version, health: 'healthy', now: NOW })
    const transitioned = transitionCommerceAccountMode({ accountId, toMode: 'shadow', actorUserId: 'admin-e2e',
      actorIsSuperAdmin: true, limits: { currency: 'CNY', perActionMinor: 50_000, dailyMinor: 100_000,
        merchantIds: [merchantId], destinationDigests: [destinationDigest()] }, now: NOW })
    expect(transitioned.account).toMatchObject({ mode: 'shadow', executorId: COMMERCE_SHADOW_EXECUTOR_ID })
  }

  function registerCommerceAdapters(): void {
    const adapters = createConfiguredCommerceExecutorAdapters()
    for (const adapter of adapters) {
      registerFabricExecutorAdapter(adapter)
      registeredAdapters.push(adapter.id)
    }
  }

  function unregisterCommerceAdapters(): void {
    for (const id of registeredAdapters.splice(0).reverse()) unregisterFabricExecutorAdapter(id)
  }

  async function runIntent(input: FabricActionIntentInput): Promise<FabricJsonObject> {
    const created = createFabricIntent(input)
    if (created.policyDecision.outcome === 'waiting_user') approveFabricWorkflow(created.workflow.id, ACTOR)
    else expect(created.policyDecision.outcome).toBe('allow')
    await runWorkflowToSuccess(created.workflow.id)
    return executeOutput(created.workflow.id)
  }

  async function runWorkflowToSuccess(workflowId: string): Promise<string[]> {
    const phases: string[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = getFabricWorkflow(workflowId)
      if (current?.state === 'succeeded') return phases
      workerTick += 1
      const result = await processActionFabricOnce({ workerId: 'commerce-e2e-worker',
        now: new Date(Date.parse(NOW) + workerTick * 1_000) })
      if (!result.processed) {
        const stalled = getFabricWorkflow(workflowId)
        throw new Error(`COMMERCE_E2E_WORKFLOW_STALLED:${stalled?.state ?? 'missing'}:${stalled?.lastErrorCode ?? 'none'}`)
      }
      expect(result).toMatchObject({ processed: true, workflowId })
      if (result.phase) phases.push(result.phase)
    }
    expect(getFabricWorkflow(workflowId)).toMatchObject({ state: 'succeeded' })
    return phases
  }

  async function runWorkerPhase(workflowId: string, phase: 'prepare' | 'execute' | 'verify'): Promise<void> {
    workerTick += 1
    const result = await processActionFabricOnce({ workerId: 'commerce-e2e-worker',
      now: new Date(Date.parse(NOW) + workerTick * 1_000) })
    expect(result).toMatchObject({ processed: true, workflowId, phase })
  }
})

const NOW = '2026-07-15T10:00:00.000Z'
const ACTOR = 'user-commerce-e2e'
const DESTINATION = 'destination-home-e2e'

function provider(
  providerKind: 'food_delivery' | 'taobao',
  providerOfferId: string,
  productId: string,
  skuId: string,
  merchantId: string,
  merchantName: string,
  title: string,
  unitLabel: string,
  unitPriceMinor: number,
  fulfillment: 'delivery' | 'shipping',
): VirtualCommerceProvider {
  return new VirtualCommerceProvider({ provider: providerKind, clock: () => new Date(NOW), catalog: [{
    providerOfferId, productId, skuId, merchantId, merchantName, title, unitLabel, currency: 'CNY', unitPriceMinor,
    available: true, maxQuantity: 10, fulfillment, fulfillmentMinutes: fulfillment === 'delivery' ? 20 : 2_880,
  }] })
}

function base(accountId: string, providerKind: 'food_delivery' | 'taobao') {
  return { schemaVersion: 1, accountId, provider: providerKind, currency: 'CNY' }
}

function baseTarget(accountId: string, providerKind: 'food_delivery' | 'taobao') {
  return { kind: 'commerce_account', accountId, provider: providerKind, currency: 'CNY' }
}

function transactionTarget() {
  return { ...baseTarget('food-account', 'food_delivery'), merchantId: 'merchant-food',
    destinationDigest: destinationDigest() }
}

function destinationDigest(): string {
  return createHash('sha256').update(DESTINATION).digest('hex')
}

function intent(
  capabilityId: string,
  input: FabricJsonObject,
  target: FabricJsonObject,
  suffix: string,
  expectedCostMinor?: number,
): FabricActionIntentInput {
  return { capabilityId, requestedByRoleId: 'commerce-assistant', requestedByUserId: ACTOR,
    idempotencyKey: `commerce-e2e-${suffix}`, goal: `Commerce E2E ${suffix}`, target, input,
    constraints: {}, rationale: 'Verify the governed commerce closed loop', environments: ['sandbox'],
    ...(expectedCostMinor === undefined ? {} : { expectedCost: { currency: 'CNY', amountMinor: expectedCostMinor } }) }
}

function executeOutput(workflowId: string): FabricJsonObject {
  const workflow = getFabricWorkflow(workflowId)
  expect(workflow).toMatchObject({ state: 'succeeded' })
  const output = workflow?.steps.find(step => step.kind === 'execute')?.output
  if (!output) throw new Error('COMMERCE_E2E_EXECUTION_OUTPUT_MISSING')
  return output
}
