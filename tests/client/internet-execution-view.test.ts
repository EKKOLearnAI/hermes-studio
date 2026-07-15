// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, ref } from 'vue'

const api = vi.hoisted(() => ({
  fetchInternetOverview: vi.fn(), fetchInternetReceipts: vi.fn(), fetchInternetReceipt: vi.fn(),
  fetchInternetWorkflow: vi.fn(), searchBilibiliVideos: vi.fn(), inspectBilibiliVideo: vi.fn(),
}))
const isStoredSuperAdmin = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/api/hermes/internet-execution', () => api)
vi.mock('@/api/client', () => ({ isStoredSuperAdmin }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  NSpin: defineComponent({ props: { show: Boolean }, template: '<div><slot /></div>' }),
}))

import InternetExecutionView from '@/views/hermes/InternetExecutionView.vue'

const overview = { provider: { provider: 'bilibili', profile: 'default', active: true, configured: true,
  discoveryStatus: 'healthy', executorEnabled: true, selectedExecutorType: 'mcp', authorizedTargetCount: 1,
  lastErrorCode: null }, executors: [{ type: 'mcp', environment: 'production', enabled: true, health: 'healthy', selected: true },
  { type: 'browser', environment: 'production', enabled: true, health: 'healthy', selected: false }],
  capabilities: [], summary: { receiptCount: 0, verifiedReceiptCount: 0, waitingUserReceiptCount: 0, activeWorkflowCount: 0 } }
const workflow = { id: 'workflow:one', state: 'waiting_user', version: 1, attempt: 0, lastErrorCode: null,
  availableActions: { approve: false, reject: false, cancel: false, retry: false, compensate: false },
  createdAt: 'now', updatedAt: 'now', completedAt: null }

describe('InternetExecutionView', () => {
  beforeEach(() => {
    vi.clearAllMocks(); isStoredSuperAdmin.mockReturnValue(true)
    api.fetchInternetOverview.mockResolvedValue(overview); api.fetchInternetReceipts.mockResolvedValue([])
    api.searchBilibiliVideos.mockResolvedValue({ intent: {}, policyDecision: {}, workflow })
    api.inspectBilibiliVideo.mockResolvedValue({ intent: {}, policyDecision: {}, workflow })
    api.fetchInternetWorkflow.mockResolvedValue({ ...workflow, capabilityId: 'bilibili.video.search', policyDecision: null, steps: [] })
    api.fetchInternetReceipt.mockResolvedValue({ receipt: { workflowId: workflow.id, status: 'waiting_user', result: null,
      executorType: 'browser', resultDigest: null }, evidence: [] })
  })

  it('submits a semantic search and renders explicit browser takeover state', async () => {
    const wrapper = mount(InternetExecutionView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    await wrapper.find('[data-test="internet-search-query"]').setValue('Hermes Agent')
    await wrapper.find('[data-test="internet-search-form"]').trigger('submit')
    await flushPromises()

    expect(api.searchBilibiliVideos).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Hermes Agent', limit: 10, page: 1, order: 'relevance',
    }))
    expect(api.searchBilibiliVideos.mock.calls[0][0].idempotencyKey).toMatch(/^internet-ui:search:/)
    expect(wrapper.find('[data-test="internet-takeover-state"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('internetExecution.workflow.takeoverPrivacy')
    wrapper.unmount()
  })

  it('disables all intent submission for read-only users', async () => {
    isStoredSuperAdmin.mockReturnValue(false)
    const wrapper = mount(InternetExecutionView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.find<HTMLButtonElement>('[data-test="internet-search-submit"]').element.disabled).toBe(true)
    expect(wrapper.find<HTMLButtonElement>('[data-test="internet-inspect-submit"]').element.disabled).toBe(true)
    expect(wrapper.text()).toContain('internetExecution.readOnly')
    wrapper.unmount()
  })
})
