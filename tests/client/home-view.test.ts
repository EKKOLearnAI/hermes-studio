// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'

const api = vi.hoisted(() => ({
  fetchHomeOverview: vi.fn(), fetchHomeProvider: vi.fn(), fetchHomeSpaces: vi.fn(), fetchHomeDevices: vi.fn(),
  fetchHomeInventory: vi.fn(), fetchHomeWorkflow: vi.fn(), upsertHomeSpace: vi.fn(),
  upsertHomeInventoryItem: vi.fn(), adjustHomeInventory: vi.fn(), refreshHomeDevice: vi.fn(),
  commandHomeDevice: vi.fn(), activateHomeScene: vi.fn(), reviewHomeWorkflow: vi.fn(),
}))
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/api/hermes/home', () => api)
vi.mock('@/api/client', () => ({ isStoredSuperAdmin: () => true }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => notices,
  NSpin: defineComponent({ name: 'NSpin', props: { show: Boolean }, template: '<div><slot /></div>' }),
}))

import HomeView from '@/views/hermes/HomeView.vue'

const now = '2026-07-15T02:00:00.000Z'
const provider = { provider: 'home-assistant', profile: 'default', active: true, configured: true,
  connectionStatus: 'connected', executorEnabled: true, authorizedTargetCount: 1, lastErrorCode: null }
const workflow = { id: 'workflow:one', state: 'waiting_user', version: 1, attempt: 0, lastErrorCode: null,
  availableActions: { approve: true, reject: true, cancel: false, retry: false, compensate: false },
  createdAt: now, updatedAt: now, completedAt: null }
const device = { id: 'device:lamp', name: 'Office lamp', deviceClass: 'light', spaceId: null,
  availability: 'available', attributes: {}, version: 1, createdAt: now, updatedAt: now,
  bindings: [{ id: 'binding:lamp', deviceId: 'device:lamp', provider: 'home-assistant',
    externalId: 'light.office_lamp', capabilities: ['power'], version: 1, createdAt: now, updatedAt: now }],
  states: [{ deviceId: 'device:lamp', key: 'power', value: false, sourceEventId: 'event:one',
    observedAt: now, receivedAt: now, version: 3 }] }

describe('HomeView', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); vi.clearAllMocks()
    api.fetchHomeOverview.mockResolvedValue({ provider, summary: { spaceCount: 0, deviceCount: 1,
      unavailableDeviceCount: 0, inventoryItemCount: 0, lowStockItemCount: 0, activeWorkflowCount: 0 } })
    api.fetchHomeSpaces.mockResolvedValue([]); api.fetchHomeDevices.mockResolvedValue([device])
    api.fetchHomeInventory.mockResolvedValue([]); api.fetchHomeProvider.mockResolvedValue(provider)
    api.fetchHomeWorkflow.mockResolvedValue({ ...workflow, capabilityId: 'home.device.set_power',
      policyDecision: null, steps: [] })
    api.commandHomeDevice.mockResolvedValue({ intent: { id: 'intent:one', capabilityId: 'home.device.set_power' },
      policyDecision: { id: 'decision:one', outcome: 'waiting_user', reasonCodes: [] }, workflow })
  })

  it('loads the dashboard and submits a confirmed exact command into workflow tracking', async () => {
    const wrapper = mount(HomeView)
    await flushPromises()
    expect(api.fetchHomeOverview).toHaveBeenCalledTimes(1)
    expect(api.fetchHomeDevices).toHaveBeenCalledWith({ limit: 200 })
    expect(wrapper.find('[data-test="home-provider-status"]').text()).toContain('home.status.connected')

    await wrapper.find('[data-test="home-command-power"]').trigger('click')
    expect(api.commandHomeDevice).not.toHaveBeenCalled()
    await wrapper.find('[data-test="home-command-confirm"]').trigger('click')
    await flushPromises()

    expect(api.commandHomeDevice).toHaveBeenCalledWith('device:lamp', expect.objectContaining({
      command: 'set_power', bindingId: 'binding:lamp', externalId: 'light.office_lamp',
      expectedStateVersion: 3, desiredPower: true, verificationTimeoutMs: 30_000,
      idempotencyKey: expect.stringMatching(/^home-ui:set_power:/),
    }))
    expect(api.fetchHomeWorkflow).toHaveBeenCalledWith('workflow:one')
    expect(wrapper.text()).toContain('workflow:one')
    expect(notices.success).toHaveBeenCalledWith('home.success.queued')
    wrapper.unmount()
  })
})
