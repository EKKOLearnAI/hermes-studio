import { describe, expect, it } from 'vitest'
import {
  COMMERCE_ACCOUNT_HEALTH,
  COMMERCE_DELIVERY_STATES,
  COMMERCE_EXECUTION_MODES,
  COMMERCE_PAYMENT_STATES,
  COMMERCE_PROVIDER_KINDS,
  COMMERCE_TRANSACTION_STATES,
  assertCommerceSafeData,
  commerceModeAllowsExternalWrite,
  commercePaymentRequiresFreshApproval,
  isCommerceAccountHealth,
  isCommerceDeliveryState,
  isCommercePaymentState,
  isCommerceProviderKind,
  isCommerceTransactionState,
  isLegalCommerceTransactionTransition,
  isTerminalCommerceTransactionState,
  parseCommerceMoney,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('commerce autonomy contracts', () => {
  it('keeps provider, mode, account, payment, delivery, and transaction enums closed', () => {
    expect(COMMERCE_PROVIDER_KINDS).toEqual(['virtual', 'food_delivery', 'taobao'])
    expect(COMMERCE_EXECUTION_MODES).toEqual(['observe', 'shadow', 'live'])
    expect(COMMERCE_ACCOUNT_HEALTH.every(isCommerceAccountHealth)).toBe(true)
    expect(COMMERCE_PAYMENT_STATES.every(isCommercePaymentState)).toBe(true)
    expect(COMMERCE_DELIVERY_STATES.every(isCommerceDeliveryState)).toBe(true)
    expect(COMMERCE_TRANSACTION_STATES.every(isCommerceTransactionState)).toBe(true)
    expect(isCommerceProviderKind('browser')).toBe(false)
    expect(isCommerceTransactionState('charged_again')).toBe(false)
  })

  it('accepts only exact uppercase currency and safe integer minor units', () => {
    expect(parseCommerceMoney({ currency: 'CNY', amountMinor: 8_050 }))
      .toEqual({ currency: 'CNY', amountMinor: 8_050 })
    for (const value of [
      { currency: 'cny', amountMinor: 1 },
      { currency: 'CNY', amountMinor: 1.2 },
      { currency: 'CNY', amountMinor: -1 },
      { currency: 'CNY', amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { currency: 'CNY', amountMinor: 1, display: '¥0.01' },
      null,
    ]) expect(() => parseCommerceMoney(value)).toThrow('COMMERCE_MONEY_INVALID')
  })

  it('makes observe and shadow physically incapable of external writes', () => {
    expect(commerceModeAllowsExternalWrite('observe')).toBe(false)
    expect(commerceModeAllowsExternalWrite('shadow')).toBe(false)
    expect(commerceModeAllowsExternalWrite('live')).toBe(true)
    expect(commercePaymentRequiresFreshApproval('observe')).toBe(false)
    expect(commercePaymentRequiresFreshApproval('shadow')).toBe(false)
    expect(commercePaymentRequiresFreshApproval('live')).toBe(true)
  })

  it('allows only explicit monotonic transaction transitions', () => {
    expect(isLegalCommerceTransactionTransition('quoted', 'waiting_approval')).toBe(true)
    expect(isLegalCommerceTransactionTransition('submitting_order', 'lookup_required')).toBe(true)
    expect(isLegalCommerceTransactionTransition('submitting_payment', 'lookup_required')).toBe(true)
    expect(isLegalCommerceTransactionTransition('delivered', 'refunding')).toBe(true)
    expect(isLegalCommerceTransactionTransition('quoted', 'paid')).toBe(false)
    expect(isLegalCommerceTransactionTransition('lookup_required', 'submitting_payment')).toBe(false)
    expect(isLegalCommerceTransactionTransition('refunded', 'paid')).toBe(false)
    expect(isTerminalCommerceTransactionState('delivered')).toBe(false)
    expect(isTerminalCommerceTransactionState('waiting_user')).toBe(false)
  })

  it('bounds safe evidence and rejects secret-shaped, sparse, accessor, and oversized data', () => {
    expect(() => assertCommerceSafeData({ quoteId: 'quote-1', amountMinor: 1_000,
      rationaleCodes: ['lowest_total', 'fast_delivery'] })).not.toThrow()
    for (const value of [
      { paymentToken: 'do-not-store' },
      { card_number: '4111111111111111' },
      { nested: { cookie: 'session' } },
      { text: 'x'.repeat(2_001) },
      { value: Number.NaN },
      Array.from({ length: 65 }, () => 'x'),
    ]) expect(() => assertCommerceSafeData(value)).toThrow(/COMMERCE_/)

    const sparse = new Array(2)
    sparse[1] = 'x'
    expect(() => assertCommerceSafeData(sparse)).toThrow('COMMERCE_DATA_BOUNDS_EXCEEDED')
    const accessor = Object.defineProperty({}, 'quoteId', { enumerable: true, get: () => 'quote-1' })
    expect(() => assertCommerceSafeData(accessor)).toThrow('COMMERCE_DATA_INVALID')

    let arrayGetterInvoked = false
    const accessorArray = ['safe']
    Object.defineProperty(accessorArray, '0', { enumerable: true,
      get: () => { arrayGetterInvoked = true; return 'unsafe' } })
    expect(() => assertCommerceSafeData(accessorArray)).toThrow('COMMERCE_DATA_BOUNDS_EXCEEDED')
    expect(arrayGetterInvoked).toBe(false)
    expect(() => assertCommerceSafeData(new Proxy({ quoteId: 'quote-1' }, {})))
      .toThrow('COMMERCE_DATA_INVALID')
  })

})
