// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) }))
import LifePlannerPanel from '@/components/hermes/life/LifePlannerPanel.vue'
import LifeSubscriptionsPanel from '@/components/hermes/life/LifeSubscriptionsPanel.vue'
import LifeSourcesPanel from '@/components/hermes/life/LifeSourcesPanel.vue'

const now = '2026-07-15T00:00:00.000Z'
const source = { id: 'calendar-1', sourceKind: 'calendar', mode: 'shadow', executorId: 'life-shadow',
  displayName: 'Calendar', health: 'healthy', enabled: true, policyEpoch: 4, version: 3,
  createdAt: now, updatedAt: now, revokedAt: null }
const constraint = { id: 'constraint-1', subjectId: 'self', horizon: { startsAt: now, endsAt: '2026-07-16T00:00:00.000Z' },
  timezone: 'Asia/Shanghai', freeWindows: [], commitmentIds: [], readiness: 'normal', recovery: 'good', sleepDebt: 'none',
  screenTimeUsedMinutes: 0, screenTimeLimitMinutes: 120, leisureTimeLimitMinutes: 180,
  budget: { currency: 'CNY', amountMinor: 10000 }, quietStartMinute: 1320, quietEndMinute: 420,
  maxTravelRadiusKm: 30, excludedCategories: [], preferredCategories: ['music'], factRefs: [],
  materialDigest: 'a'.repeat(64), createdAt: now, expiresAt: '2026-07-16T00:00:00.000Z' }
const option = { id: 'option-1', accountId: null, kind: 'music', source: 'twin', title: 'Evening album',
  categoryTags: ['music'], durationMinutes: 60, exertion: 'low', screenBased: false, locationClass: 'home',
  cost: { currency: 'CNY', amountMinor: 0 }, available: true, observedAt: now,
  expiresAt: '2026-07-16T00:00:00.000Z', sourceDigest: 'd'.repeat(64) }
const plan = { id: 'plan-1', constraintSnapshotId: constraint.id, constraintDigest: constraint.materialDigest,
  candidates: [{ optionId: option.id, eligible: true, score: 900, exclusionCodes: [], rationaleCodes: ['preferred'] }],
  sessions: [{ optionId: option.id, startsAt: now, endsAt: '2026-07-15T01:00:00.000Z',
    cost: option.cost, rationaleCodes: ['preferred'] }], totalMinutes: 60, totalCost: option.cost,
  planDigest: 'b'.repeat(64), state: 'proposed', version: 1, createdAt: now, updatedAt: now }
const subscription = { id: 'subscription-1', accountId: 'subscriptions-1', serviceLabel: 'Music Plus',
  planLabel: 'Monthly', recurringCost: { currency: 'CNY', amountMinor: 1500 }, renewalAt: '2026-08-01T00:00:00.000Z',
  cancellationDeadline: '2026-07-31T00:00:00.000Z', state: 'active', observedAt: now,
  sourceDigest: 'c'.repeat(64), version: 1 }

describe('life orchestration Studio panels', () => {
  it('renders immutable plan material and submits only the selected exact calendar session', async () => {
    const wrapper = mount(LifePlannerPanel, { props: { constraints: [constraint] as any, plans: [plan] as any,
      selectedPlanId: plan.id, options: [option] as any, sources: [source] as any,
      materialChanged: false, canWrite: true, busy: false } })
    await wrapper.get('[data-test="life-hold-session"]').setValue(option.id)
    await wrapper.get('[data-test="life-hold-calendar"]').setValue(source.id)
    await wrapper.get('[data-test="life-open-hold-confirmation"]').trigger('click')
    const confirmation = wrapper.get('[data-test="life-hold-confirmation"]')
    expect(confirmation.text()).toContain('Evening album'); expect(confirmation.text()).toContain(plan.planDigest)
    expect(confirmation.text()).toContain('CNY 0.00')
    await wrapper.get('[data-test="life-confirm-hold"]').trigger('click')
    expect(wrapper.emitted('hold')).toEqual([[{ accountId: source.id, planRevisionId: plan.id, optionId: option.id }]])
  })

  it('blocks calendar hold creation after material changes until a plan is regenerated', async () => {
    const wrapper = mount(LifePlannerPanel, { props: { constraints: [{ ...constraint, materialDigest: 'e'.repeat(64) }] as any,
      plans: [plan] as any, selectedPlanId: plan.id, options: [option] as any, sources: [source] as any,
      materialChanged: true, canWrite: true, busy: false } })
    await wrapper.get('[data-test="life-hold-session"]').setValue(option.id)
    await wrapper.get('[data-test="life-hold-calendar"]').setValue(source.id)
    expect(wrapper.get('[data-test="life-material-change"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="life-open-hold-confirmation"]').attributes('disabled')).toBeDefined()
  })

  it('shows exact recurring cost and deadline before subscription cancellation', async () => {
    const wrapper = mount(LifeSubscriptionsPanel, { props: { subscriptions: [subscription] as any,
      cancellations: [], canWrite: true, busy: false } })
    await wrapper.get(`[data-test="life-cancel-${subscription.id}"]`).trigger('click')
    const confirmation = wrapper.get('[data-test="life-subscription-confirmation"]')
    expect(confirmation.text()).toContain('Music Plus'); expect(confirmation.text()).toContain('CNY 15.00')
    await wrapper.get('[data-test="life-cancellation-reason"]').setValue('TOO_EXPENSIVE')
    await wrapper.get('[data-test="life-confirm-subscription-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toEqual([[{ subscriptionId: subscription.id, reasonCode: 'TOO_EXPENSIVE' }]])
  })

  it('binds live calendar activation to the selected exact semantic calendar id', async () => {
    const wrapper = mount(LifeSourcesPanel, { props: { sources: [source] as any, selectedId: source.id,
      reviews: [], canAdmin: true, canOperate: true, busy: false } })
    await wrapper.findAll('select')[1]!.setValue('live')
    expect(wrapper.get('[data-test="life-open-activation"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-test="life-open-activation"]').trigger('click')
    expect(wrapper.get('[data-test="life-activation-confirmation"]').text()).toContain(source.id)
    await wrapper.get('[data-test="life-confirm-activation"]').trigger('click')
    expect(wrapper.emitted('activate')?.[0]?.[0]).toEqual({ toMode: 'live',
      limits: { currency: 'CNY', calendarIds: [source.id], subscriptionIds: [] } })
  })
})
