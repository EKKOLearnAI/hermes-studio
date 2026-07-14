// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import HomeDevicePanel from '@/components/hermes/home/HomeDevicePanel.vue'
import HomeInventoryPanel from '@/components/hermes/home/HomeInventoryPanel.vue'
import HomeWorkflowPanel from '@/components/hermes/home/HomeWorkflowPanel.vue'
import { homeDeviceFreshness } from '@/components/hermes/home/home-ui'

const observedAt = '2026-07-15T02:00:00.000Z'
const device = {
  id: 'device:lamp', name: 'Office lamp', deviceClass: 'light', spaceId: 'space:office', availability: 'available',
  attributes: {}, version: 1, createdAt: observedAt, updatedAt: observedAt,
  bindings: [{ id: 'binding:lamp', deviceId: 'device:lamp', provider: 'home-assistant',
    externalId: 'light.office_lamp', capabilities: ['power', 'level'], version: 1,
    createdAt: observedAt, updatedAt: observedAt }],
  states: [
    { deviceId: 'device:lamp', key: 'power', value: true, sourceEventId: 'event:1', observedAt,
      receivedAt: observedAt, version: 4 },
    { deviceId: 'device:lamp', key: 'level', value: 25, sourceEventId: 'event:1', observedAt,
      receivedAt: observedAt, version: 7 },
  ],
} as any

describe('home command center panels', () => {
  it('classifies observation freshness at bounded thresholds', () => {
    const base = Date.parse(observedAt)
    expect(homeDeviceFreshness(device, base + 5 * 60_000)).toBe('fresh')
    expect(homeDeviceFreshness(device, base + 6 * 60_000)).toBe('aging')
    expect(homeDeviceFreshness(device, base + 31 * 60_000)).toBe('stale')
    expect(homeDeviceFreshness({ ...device, states: [] }, base)).toBe('unknown')
  })

  it('requires explicit confirmation before emitting an exact semantic device command', async () => {
    const wrapper = mount(HomeDevicePanel, { props: { devices: [device], canWrite: true } })
    await wrapper.find('[data-test="home-command-power"]').trigger('click')
    expect(wrapper.emitted('action')).toBeUndefined()
    expect(wrapper.find('[data-test="home-command-confirmation"]').attributes('role')).toBe('dialog')
    expect(wrapper.text()).toContain('light.office_lamp')

    await wrapper.find('[data-test="home-command-confirm"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual([{
      kind: 'set_power', deviceId: 'device:lamp', bindingId: 'binding:lamp', externalId: 'light.office_lamp',
      expectedStateVersion: 4, desiredPower: false,
    }])
    expect(JSON.stringify(wrapper.emitted())).not.toMatch(/service_data|access_token|credential/i)
  })

  it('rejects out-of-range semantic values before they reach the API boundary', async () => {
    const wrapper = mount(HomeDevicePanel, { props: { devices: [device], canWrite: true } })
    await wrapper.find('[data-test="home-command-level"]').trigger('click')
    await wrapper.find('[data-test="home-command-value"]').setValue('101')
    expect(wrapper.find<HTMLButtonElement>('[data-test="home-command-confirm"]').element.disabled).toBe(true)
    await wrapper.find('[data-test="home-command-value"]').setValue('55')
    expect(wrapper.find<HTMLButtonElement>('[data-test="home-command-confirm"]').element.disabled).toBe(false)
  })

  it('disables all physical writes for read-only users', () => {
    const wrapper = mount(HomeDevicePanel, { props: { devices: [device], canWrite: false } })
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  it('confirms inventory ledger changes instead of mutating from the first click', async () => {
    const item = { id: 'inventory:filter', name: 'Air filter', unit: 'piece', quantity: 1,
      lowStockThreshold: 1, attributes: {}, version: 1, createdAt: observedAt, updatedAt: observedAt } as any
    const wrapper = mount(HomeInventoryPanel, { props: { items: [item], canWrite: true } })
    expect(wrapper.text()).toContain('home.inventory.lowStock')
    await wrapper.find('[data-test="home-inventory-use"]').trigger('click')
    expect(wrapper.emitted('adjust')).toBeUndefined()
    await wrapper.find('[data-test="home-inventory-confirm"]').trigger('click')
    expect(wrapper.emitted('adjust')?.[0]).toEqual([{ id: item.id, delta: -1, reason: 'home.inventory.adjustmentReason' }])
  })

  it('shows only server-authorized workflow reviews and requires a rejection reason', async () => {
    const workflow = { id: 'workflow:one', state: 'waiting_user', version: 1, attempt: 0, lastErrorCode: null,
      availableActions: { approve: true, reject: true, cancel: false, retry: false, compensate: false },
      createdAt: observedAt, updatedAt: observedAt, completedAt: null,
      capabilityId: 'home.device.set_power', policyDecision: null,
      steps: [{ kind: 'prepare', state: 'waiting_user', attempt: 0, lastErrorCode: null, output: null, updatedAt: observedAt }] } as any
    const wrapper = mount(HomeWorkflowPanel, { props: { workflow, canWrite: true } })
    expect(wrapper.find('[data-test="home-workflow-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="home-workflow-reject"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('prepare')

    await wrapper.find('[data-test="home-workflow-reject"]').trigger('click')
    expect(wrapper.find<HTMLButtonElement>('[data-test="home-workflow-reject-confirm"]').element.disabled).toBe(true)
    await wrapper.find('[data-test="home-workflow-rejection-reason"]').setValue('Nobody is home')
    await wrapper.find('[data-test="home-workflow-reject-confirm"]').trigger('submit')
    expect(wrapper.emitted('review')?.[0]).toEqual([{ action: 'reject', reason: 'Nobody is home' }])
  })
})
