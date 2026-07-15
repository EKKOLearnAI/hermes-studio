import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindFabricExecutorCapability,
  createFabricExecutor,
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  getFabricCapability,
  listFabricCapabilities,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  clearCommerceAssistantAuthorization,
  commerceTargetAtoms,
  COMMERCE_CAPABILITY_IDS,
  COMMERCE_ORDER_CAPABILITY,
  COMMERCE_PAYMENT_CAPABILITY,
  COMMERCE_QUOTE_CAPABILITY,
  refreshCommerceAssistantAuthorization,
  validateCommerceFabricOutput,
  validateCommerceFabricSemantics,
} from '../../packages/server/src/services/hermes/commerce-autonomy'
import {
  ensureBuiltInAssistantRoles,
  getAssistantRole,
  updateAssistantRole,
} from '../../packages/server/src/services/hermes/personal-twin'

describe('commerce Action Fabric contracts', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-commerce-fabric-'))
    process.env.HERMES_HOME = home
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'))
    ensureBuiltInAssistantRoles()
    ensureBuiltInFabricRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('registers the closed commerce capability set with financial risk and replay contracts', () => {
    const capabilities = listFabricCapabilities().filter(item => item.id.startsWith('commerce.'))
    expect(capabilities.map(item => item.id)).toEqual([...COMMERCE_CAPABILITY_IDS].sort())
    expect(getFabricCapability(COMMERCE_ORDER_CAPABILITY)).toMatchObject({
      risk: 'high', sideEffect: true, idempotency: 'required', reversible: true,
      compensationCapabilityId: 'commerce.order.cancel', verificationStrategy: 'provider_order_lookup_before_retry',
    })
    expect(getFabricCapability(COMMERCE_PAYMENT_CAPABILITY)).toMatchObject({
      risk: 'critical', sideEffect: true, idempotency: 'required', reversible: false,
      authentication: expect.arrayContaining(['commerce_payment:fresh_exact_approval']),
    })
  })

  it('accepts exact semantic inputs and rejects raw provider or UI primitives', () => {
    expect(validateCommerceFabricSemantics(COMMERCE_QUOTE_CAPABILITY, quoteInput())).toBe(true)
    expect(validateCommerceFabricSemantics(COMMERCE_ORDER_CAPABILITY, orderInput())).toBe(true)
    expect(validateCommerceFabricSemantics(COMMERCE_ORDER_CAPABILITY, { ...orderInput(), url: 'https://pay.invalid' })).toBe(false)
    expect(validateCommerceFabricSemantics(COMMERCE_ORDER_CAPABILITY, { ...orderInput(), provider: 'virtual' })).toBe(false)
    expect(validateCommerceFabricSemantics(COMMERCE_ORDER_CAPABILITY, { ...orderInput(), amountMinor: 1.5 })).toBe(false)
    expect(validateCommerceFabricSemantics('android.tap', orderInput())).toBe(false)
  })

  it('derives exact account targets and rejects merchant, destination, and field substitution', () => {
    const target = transactionTarget()
    expect(commerceTargetAtoms(COMMERCE_ORDER_CAPABILITY, target, orderInput())).toEqual([
      'commerce:account:food-account',
      'commerce:provider:food_delivery',
      'commerce:currency:CNY',
      'commerce:merchant:merchant-1',
      `commerce:destination:${'d'.repeat(64)}`,
    ])
    expect(commerceTargetAtoms(COMMERCE_ORDER_CAPABILITY,
      { ...target, merchantId: 'merchant-2' }, orderInput())).toBeNull()
    expect(commerceTargetAtoms(COMMERCE_ORDER_CAPABILITY,
      { ...target, click: { x: 1, y: 2 } }, orderInput())).toBeNull()
    expect(commerceTargetAtoms(COMMERCE_QUOTE_CAPABILITY, baseTarget(), quoteInput())).toHaveLength(3)
  })

  it('rejects output identity or amount substitution even after JSON schema validation', () => {
    const valid = { schemaVersion: 1, operation: 'order_place', accountId: 'food-account',
      provider: 'food_delivery', currency: 'CNY', merchantId: 'merchant-1', destinationDigest: 'd'.repeat(64),
      transactionId: 'transaction-1', providerOrderId: 'provider-order-1', amountMinor: 1_600,
      status: 'pending_payment' }
    expect(validateCommerceFabricOutput(COMMERCE_ORDER_CAPABILITY, orderInput(), valid)).toBe(true)
    expect(validateCommerceFabricOutput(COMMERCE_ORDER_CAPABILITY, orderInput(), { ...valid, amountMinor: 1_601 })).toBe(false)
    expect(validateCommerceFabricOutput(COMMERCE_ORDER_CAPABILITY, orderInput(), { ...valid, accountId: 'other' })).toBe(false)
  })

  it('composes observe/shadow role authority without silently granting a spending limit', () => {
    updateAssistantRole('commerce-assistant', { spendingLimits: { currency: 'CNY', perAction: 5_000, daily: 10_000 } })
    const observeTargets = refreshCommerceAssistantAuthorization({ accountId: 'food-account', provider: 'food_delivery',
      currency: 'CNY', mode: 'observe' })
    expect(observeTargets).toHaveLength(3)
    expect(getAssistantRole('commerce-assistant')).toMatchObject({
      capabilityScope: { allow: ['commerce.cart.prepare', 'commerce.offer.compare', 'commerce.product.search'] },
      decisionAuthority: { maxRisk: 'low', requireApprovalAbove: 'low' },
      spendingLimits: { currency: 'CNY', perAction: 5_000, daily: 10_000 },
    })

    refreshCommerceAssistantAuthorization({ accountId: 'food-account', provider: 'food_delivery', currency: 'CNY',
      mode: 'shadow', merchantIds: ['merchant-1'], destinationDigests: ['d'.repeat(64)] })
    expect(getAssistantRole('commerce-assistant')).toMatchObject({
      capabilityScope: { allow: [...COMMERCE_CAPABILITY_IDS].sort() },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'low',
        allowedTargets: expect.arrayContaining(['commerce:merchant:merchant-1', `commerce:destination:${'d'.repeat(64)}`]) },
      spendingLimits: { currency: 'CNY', perAction: 5_000, daily: 10_000 },
    })
    clearCommerceAssistantAuthorization()
    expect(getAssistantRole('commerce-assistant')).toMatchObject({
      capabilityScope: { allow: ['twin.read'], deny: ['action.execute'] },
      decisionAuthority: { maxRisk: 'none', allowedTargets: [] },
      spendingLimits: { currency: 'CNY', perAction: 5_000, daily: 10_000 },
    })
  })

  it('routes commerce policy through exact target atoms and requires approval for order/payment', () => {
    createFabricExecutor({ id: 'commerce-contract-test', type: 'connector', name: 'Commerce contract test',
      environment: 'sandbox', configuration: { externalWrite: false, shadow: true, interruptible: true }, enabled: true })
    for (const capabilityId of [COMMERCE_QUOTE_CAPABILITY, COMMERCE_ORDER_CAPABILITY, COMMERCE_PAYMENT_CAPABILITY]) {
      const capability = getFabricCapability(capabilityId)!
      bindFabricExecutorCapability('commerce-contract-test', capability.id, capability.version, capability.contractDigest)
    }
    refreshCommerceAssistantAuthorization({ accountId: 'food-account', provider: 'food_delivery', currency: 'CNY',
      mode: 'shadow', merchantIds: ['merchant-1'], destinationDigests: ['d'.repeat(64)] })
    updateAssistantRole('commerce-assistant', { spendingLimits: { currency: 'CNY', perAction: 5_000, daily: 10_000 } })

    expect(evaluateFabricPolicy(intent(COMMERCE_QUOTE_CAPABILITY, quoteInput(), baseTarget(), 'quote')))
      .toMatchObject({ outcome: 'allow', reasonCodes: [] })
    const order = evaluateFabricPolicy(intent(COMMERCE_ORDER_CAPABILITY, orderInput(), transactionTarget(), 'order',
      { currency: 'CNY', amountMinor: 1_600 }))
    expect(order.outcome).toBe('waiting_user')
    expect(order.reasonCodes).toContain('risk_requires_approval')
    const payment = evaluateFabricPolicy(intent(COMMERCE_PAYMENT_CAPABILITY, paymentInput(), transactionTarget(), 'payment',
      { currency: 'CNY', amountMinor: 1_600 }))
    expect(payment.outcome).toBe('waiting_user')
    expect(payment.reasonCodes).toContain('risk_requires_approval')

    const denied = evaluateFabricPolicy(intent(COMMERCE_ORDER_CAPABILITY, orderInput(),
      { ...transactionTarget(), destinationDigest: 'e'.repeat(64) }, 'substitution',
      { currency: 'CNY', amountMinor: 1_600 }))
    expect(denied).toMatchObject({ outcome: 'deny', reasonCodes: ['target_not_allowed'] })
  })
})

function base() { return { schemaVersion: 1, accountId: 'food-account', provider: 'food_delivery', currency: 'CNY' } }
function quoteInput() { return { ...base(), cartRevisionId: 'cart-1', cartDigest: 'c'.repeat(64),
  quoteId: 'quote-1', quoteDigest: 'q'.repeat(64).replaceAll('q', 'a'), amountMinor: 1_600 } }
function orderInput() { return { ...base(), merchantId: 'merchant-1', destinationDigest: 'd'.repeat(64),
  quoteId: 'quote-1', quoteDigest: 'a'.repeat(64), providerRequestId: 'request-order-1', amountMinor: 1_600 } }
function paymentInput() { return { ...base(), merchantId: 'merchant-1', destinationDigest: 'd'.repeat(64),
  transactionId: 'transaction-1', quoteDigest: 'a'.repeat(64), approvalId: 'approval-1', amountMinor: 1_600 } }
function baseTarget() { return { kind: 'commerce_account', accountId: 'food-account', provider: 'food_delivery', currency: 'CNY' } }
function transactionTarget() { return { ...baseTarget(), merchantId: 'merchant-1', destinationDigest: 'd'.repeat(64) } }
function intent(capabilityId: string, input: Record<string, unknown>, target: Record<string, unknown>, key: string,
  expectedCost?: { currency: string; amountMinor: number }) {
  return { capabilityId, requestedByRoleId: 'commerce-assistant', requestedByUserId: 'user-1', idempotencyKey: key,
    goal: 'Execute bounded commerce action', target, input, constraints: {}, rationale: 'Commerce contract test',
    ...(expectedCost ? { expectedCost } : {}) }
}
