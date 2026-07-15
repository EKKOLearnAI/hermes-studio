// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) }))

import CommercePlanPanel from '@/components/hermes/commerce/CommercePlanPanel.vue'
import CommerceTransactionPanel from '@/components/hermes/commerce/CommerceTransactionPanel.vue'
import CommerceGovernancePanel from '@/components/hermes/commerce/CommerceGovernancePanel.vue'

const account = { id: 'account-1', provider: 'food_delivery', mode: 'live', currency: 'CNY',
  executorId: 'commerce-live', displayName: 'Food', health: 'healthy', enabled: true, policyEpoch: 4,
  version: 3, createdAt: 'now', updatedAt: 'now', revokedAt: null }
const offer = { id: 'offer-1', accountId: account.id, provider: account.provider, productId: 'product-1',
  skuId: 'sku-1', merchantId: 'merchant-1', merchantName: 'Merchant', title: 'Lunch', unitLabel: '份',
  money: { currency: 'CNY', amountMinor: 3200 }, available: true, maxQuantity: 2, fulfillment: 'delivery',
  fulfillmentMinutes: 30, observedAt: 'now', expiresAt: 'later' }
const comparison = { id: 'comparison-1', accountId: account.id, requirement: { query: 'lunch', quantity: 1,
  maxTotalMinor: null, deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: ['lowest_price'] },
  candidates: [{ offerSnapshotId: offer.id, eligible: true, score: 900000, priceMinor: 3200,
    fulfillmentMinutes: 30, exclusionCodes: [], rationaleCodes: ['within_budget'] }],
  selectedOfferSnapshotId: offer.id, inputDigest: 'a'.repeat(64), createdAt: 'now' }
const cart = { id: 'cart-1', accountId: account.id, revision: 1,
  items: [{ offerSnapshotId: offer.id, quantity: 1 }], destinationDigest: 'b'.repeat(64),
  recipientDigest: 'c'.repeat(64), substitution: 'deny', contentDigest: 'd'.repeat(64), createdAt: 'now' }
const quote = { id: 'quote-1', accountId: account.id, cartRevisionId: cart.id, cartDigest: cart.contentDigest,
  currency: 'CNY', breakdown: { itemsMinor: 3200, deliveryMinor: 300, serviceMinor: 0, taxMinor: 0,
    discountMinor: 0, totalMinor: 3500 }, quoteDigest: 'e'.repeat(64), observedAt: 'now',
  expiresAt: '2026-07-15T01:00:00.000Z', status: 'active' }
const transaction = { id: 'transaction-1', workflowId: 'workflow-1', accountId: account.id,
  provider: account.provider, mode: 'live', policyEpoch: 4, quoteId: quote.id, quoteDigest: quote.quoteDigest,
  providerOrderId: 'order-1', currency: 'CNY', expectedAmountMinor: 3500, actualAmountMinor: null,
  state: 'waiting_payment', version: 2, createdAt: 'now', updatedAt: 'now', completedAt: null }

describe('commerce studio panels', () => {
  it('renders exact immutable order material and never echoes address or recipient tokens in confirmation', async () => {
    const wrapper = mount(CommercePlanPanel, { props: { accounts: [account] as any, selectedAccountId: account.id,
      offers: [offer] as any, comparisons: [comparison] as any, carts: [cart] as any, quotes: [quote] as any,
      canWrite: true, busy: false } })
    await wrapper.get('[data-test="commerce-open-order-confirmation"]').trigger('click')
    const dialog = wrapper.get('[data-test="commerce-order-confirmation"]')
    expect(dialog.text()).toContain('Merchant')
    expect(dialog.text()).toContain('CNY 35.00')
    expect(dialog.text()).toContain(cart.destinationDigest)
    expect(dialog.text()).not.toMatch(/destination-secret|recipient-secret/)
    await wrapper.get('[data-test="commerce-confirm-order"]').trigger('click')
    expect(wrapper.emitted('order')).toEqual([[quote.id]])
  })

  it('requires an opaque fresh approval before showing and submitting exact payment confirmation', async () => {
    const detail = { transaction, payment: null, delivery: [], cancellations: [], refunds: [], checkpoints: [] }
    const wrapper = mount(CommerceTransactionPanel, { props: { transactions: [transaction] as any,
      detail: detail as any, canWrite: true, busy: false } })
    expect(wrapper.get('[data-test="commerce-open-payment-confirmation"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="commerce-payment-approval"]').setValue('approval-123')
    await wrapper.get('[data-test="commerce-open-payment-confirmation"]').trigger('click')
    expect(wrapper.get('[data-test="commerce-payment-confirmation"]').text()).toContain('CNY 35.00')
    await wrapper.get('[data-test="commerce-confirm-payment"]').trigger('click')
    expect(wrapper.emitted('payment')).toEqual([[{ transactionId: transaction.id, approvalId: 'approval-123' }]])
  })

  it('keeps live activation disabled until a valid destination digest is supplied', async () => {
    const wrapper = mount(CommerceGovernancePanel, { props: { account: account as any, reviews: [], workflows: [],
      takeovers: [], canWrite: true, busy: false } })
    const mode = wrapper.findAll('select')[0]!
    await mode.setValue('live')
    expect(wrapper.get('[data-test="commerce-open-activation"]').attributes('disabled')).toBeDefined()
    const destination = wrapper.findAll('input')[3]!
    await destination.setValue('f'.repeat(64))
    expect(wrapper.get('[data-test="commerce-open-activation"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-test="commerce-open-activation"]').trigger('click')
    await wrapper.get('[data-test="commerce-confirm-activation"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('activate')?.[0]?.[0]).toMatchObject({ toMode: 'live',
      limits: { currency: 'CNY', destinationDigests: ['f'.repeat(64)] } })
  })
})
