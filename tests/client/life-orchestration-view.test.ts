// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, ref } from 'vue'

const api = vi.hoisted(() => Object.fromEntries([
  'fetchLifeOverview', 'fetchLifeCommitments', 'fetchLifeContacts', 'fetchLifeOptions',
  'fetchLifeSubscriptions', 'fetchLifeConstraints', 'fetchLifePlans', 'fetchLifeHandoffs',
  'fetchLifeHolds', 'fetchLifeCancellations', 'fetchLifeWorkflows', 'fetchLifeWorkflow',
  'fetchLifeTakeovers', 'fetchLifeActivationReviews', 'createLifeSource', 'syncLifeSource',
  'createLifeConstraint', 'createLifePlan', 'verifyLifePlan', 'createLifeHold', 'cancelLifeHold',
  'cancelLifeSubscription', 'reviewLifeWorkflow', 'updateLifeSourceHealth', 'activateLifeSource',
  'revokeLifeSource',
].map(name => [name, vi.fn()])))
const isStoredSuperAdmin = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/api/hermes/life-orchestration', () => api)
vi.mock('@/api/client', () => ({ isStoredSuperAdmin }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  NSpin: defineComponent({ props: { show: Boolean }, template: '<div><slot /></div>' }),
}))
import LifeOrchestrationView from '@/views/hermes/LifeOrchestrationView.vue'

const now = '2026-07-15T00:00:00.000Z'
const source = { id: 'calendar-1', sourceKind: 'calendar', mode: 'shadow', executorId: 'life-shadow',
  displayName: 'Calendar', health: 'healthy', enabled: true, policyEpoch: 1, version: 1,
  createdAt: now, updatedAt: now, revokedAt: null }
const workflow = { id: 'workflow-1', capabilityId: 'life.source.sync', state: 'waiting_user', version: 1,
  attempt: 0, lastErrorCode: 'USER_APPROVAL_REQUIRED', createdAt: now, updatedAt: now, completedAt: null,
  availableActions: { approve: true, reject: true, cancel: true, retry: false, compensate: false } }
const overview = { runtime: { configuredAccountCount: 1, sourceExecutorEnabled: false, shadowExecutorEnabled: true,
  liveExecutorEnabled: false, authorizedTargetCount: 1, emergencyStopped: false }, accounts: [source], plans: [],
  workflows: [], holds: [], cancellations: [], takeovers: [], summary: { accountCount: 1, liveAccountCount: 0,
    activePlanCount: 0, activeWorkflowCount: 0, pendingTakeoverCount: 0 } }

describe('LifeOrchestrationView', () => {
  beforeEach(() => {
    vi.clearAllMocks(); isStoredSuperAdmin.mockReturnValue(true); api.fetchLifeOverview.mockResolvedValue(overview)
    for (const method of ['fetchLifeCommitments', 'fetchLifeContacts', 'fetchLifeOptions', 'fetchLifeSubscriptions',
      'fetchLifeConstraints', 'fetchLifePlans', 'fetchLifeHandoffs', 'fetchLifeHolds', 'fetchLifeCancellations',
      'fetchLifeWorkflows', 'fetchLifeTakeovers', 'fetchLifeActivationReviews']) api[method].mockResolvedValue([])
    api.syncLifeSource.mockResolvedValue({ intent: {}, policyDecision: {}, workflow })
    api.fetchLifeWorkflow.mockResolvedValue({ ...workflow, policyDecision: null, steps: [] })
  })

  it('submits one bounded semantic source sync and follows its governed workflow', async () => {
    const wrapper = mount(LifeOrchestrationView, { global: { plugins: [createPinia()] } })
    await flushPromises(); await wrapper.get('[data-test="life-sync-source"]').trigger('click'); await flushPromises()
    expect(api.syncLifeSource).toHaveBeenCalledWith(expect.objectContaining({ accountId: source.id, cursor: null,
      limit: 20, rationale: 'Synchronize one bounded semantic life source page' }))
    expect(api.syncLifeSource.mock.calls[0]![0].idempotencyKey).toMatch(/^life-ui:sync:/)
    expect(api.fetchLifeWorkflow).toHaveBeenCalledWith(workflow.id)
    wrapper.unmount()
  })

  it('keeps ordinary governed actions available while disabling source authority for non-admins', async () => {
    isStoredSuperAdmin.mockReturnValue(false)
    const wrapper = mount(LifeOrchestrationView, { global: { plugins: [createPinia()] } })
    await flushPromises(); expect(wrapper.text()).toContain('life.adminBoundary')
    expect(wrapper.get<HTMLButtonElement>('[data-test="life-sync-source"]').element.disabled).toBe(false)
    expect(wrapper.get<HTMLButtonElement>('[data-test="life-open-activation"]').element.disabled).toBe(true)
    expect(wrapper.find('[data-test="life-create-source"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
