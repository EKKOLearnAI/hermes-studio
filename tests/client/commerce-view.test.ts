// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, ref } from 'vue'

const api = vi.hoisted(() => Object.fromEntries([
  'fetchCommerceOverview', 'fetchCommerceOffers', 'fetchCommerceComparisons', 'fetchCommerceCarts',
  'fetchCommerceQuotes', 'fetchCommerceWorkflows', 'fetchCommerceWorkflow', 'fetchCommerceTransactions',
  'fetchCommerceTransaction', 'fetchCommerceTakeovers', 'fetchCommerceActivationReviews',
  'searchCommerceOffers', 'compareCommerceOffers', 'createCommerceCart', 'createCommerceQuote',
  'placeCommerceOrder', 'confirmCommercePayment', 'trackCommerceDelivery', 'cancelCommerceOrder',
  'requestCommerceRefund', 'reviewCommerceWorkflow', 'updateCommerceAccountHealth',
  'activateCommerceAccount', 'revokeCommerceAccount',
].map(name => [name, vi.fn()])))
const isStoredSuperAdmin = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/api/hermes/commerce', () => api)
vi.mock('@/api/client', () => ({ isStoredSuperAdmin }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  NSpin: defineComponent({ props: { show: Boolean }, template: '<div><slot /></div>' }),
}))

import CommerceView from '@/views/hermes/CommerceView.vue'

const account = { id: 'account-1', provider: 'food_delivery', mode: 'shadow', currency: 'CNY',
  executorId: 'commerce-shadow', displayName: 'Food', health: 'healthy', enabled: true, policyEpoch: 1,
  version: 1, createdAt: 'now', updatedAt: 'now', revokedAt: null }
const workflow = { id: 'workflow-1', capabilityId: 'commerce.product.search', state: 'waiting_user', version: 1,
  attempt: 0, lastErrorCode: null, createdAt: 'now', updatedAt: 'now', completedAt: null,
  availableActions: { approve: true, reject: true, cancel: true, retry: false, compensate: false } }
const overview = { runtime: { configuredAccountCount: 1, shadowExecutorEnabled: true, liveExecutorEnabled: false,
  authorizedTargetCount: 3, emergencyStopped: false }, accounts: [account], offers: [], workflows: [],
  transactions: [], takeovers: [], summary: { accountCount: 1, liveAccountCount: 0, activeOfferCount: 0,
    activeWorkflowCount: 0, activeTransactionCount: 0, pendingTakeoverCount: 0 } }

describe('CommerceView', () => {
  beforeEach(() => {
    vi.clearAllMocks(); isStoredSuperAdmin.mockReturnValue(true)
    api.fetchCommerceOverview.mockResolvedValue(overview)
    for (const method of ['fetchCommerceOffers', 'fetchCommerceComparisons', 'fetchCommerceCarts',
      'fetchCommerceQuotes', 'fetchCommerceWorkflows', 'fetchCommerceTransactions', 'fetchCommerceTakeovers',
      'fetchCommerceActivationReviews']) api[method].mockResolvedValue([])
    api.searchCommerceOffers.mockResolvedValue({ intent: {}, policyDecision: {}, workflow })
    api.fetchCommerceWorkflow.mockResolvedValue({ ...workflow, policyDecision: null, steps: [] })
  })

  it('submits a semantic product search and follows the governed workflow', async () => {
    const wrapper = mount(CommerceView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    await wrapper.get('[data-test="commerce-query"]').setValue('lunch')
    await wrapper.get('[data-test="commerce-search"]').trigger('click')
    await flushPromises()
    expect(api.searchCommerceOffers).toHaveBeenCalledWith(expect.objectContaining({ accountId: account.id,
      query: 'lunch', limit: 20, rationale: 'Authenticated product search' }))
    expect(api.searchCommerceOffers.mock.calls[0]![0].idempotencyKey).toMatch(/^commerce-ui:search:/)
    expect(api.fetchCommerceWorkflow).toHaveBeenCalledWith(workflow.id)
    wrapper.unmount()
  })

  it('keeps ordinary commerce intent creation available while disabling account authority for non-admins', async () => {
    isStoredSuperAdmin.mockReturnValue(false)
    const wrapper = mount(CommerceView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.text()).toContain('commerce.adminBoundary')
    expect(wrapper.get<HTMLButtonElement>('[data-test="commerce-search"]').element.disabled).toBe(true)
    await wrapper.get('[data-test="commerce-query"]').setValue('lunch')
    expect(wrapper.get<HTMLButtonElement>('[data-test="commerce-search"]').element.disabled).toBe(false)
    expect(wrapper.get<HTMLButtonElement>('[data-test="commerce-open-activation"]').element.disabled).toBe(true)
    wrapper.unmount()
  })
})
