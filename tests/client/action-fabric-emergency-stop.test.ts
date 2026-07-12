// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const warnings: any[] = []
vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: ref('en') }) }))
vi.mock('naive-ui', () => ({ useDialog: () => ({ warning: (options: any) => warnings.push(options) }) }))

import EmergencyStopPanel from '@/components/hermes/action-fabric/EmergencyStopPanel.vue'

describe('EmergencyStopPanel', () => {
  it('describes all four authoritative levels and identifies the current level', () => {
    const wrapper = mount(EmergencyStopPanel, { props: { control: { level: 1, version: 4, actorUserId: 'admin', reason: 'pause', updatedAt: 'now' }, saving: false } })
    for (let level = 0; level <= 3; level += 1) expect(wrapper.get(`[data-test="emergency-level-${level}"]`).text()).toContain(`Level ${level}`)
    expect(wrapper.get('[data-test="emergency-current"]').text()).toContain('Level 1')
    expect(wrapper.find('fieldset[aria-label="Emergency stop level"]').exists()).toBe(true)
  })

  it('requires a reason and confirmation before emitting a versioned update', async () => {
    warnings.length = 0
    const wrapper = mount(EmergencyStopPanel, { props: { control: { level: 0, version: 7, actorUserId: null, reason: '', updatedAt: 'now' }, saving: false } })
    await wrapper.get('[data-test="emergency-level-input-2"]').setValue(true)
    expect(wrapper.get('[data-test="apply-emergency-stop"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="emergency-reason"]').setValue('Incident containment')
    await wrapper.get('[data-test="apply-emergency-stop"]').trigger('click')
    expect(warnings).toHaveLength(1)
    warnings[0].onPositiveClick()
    expect(wrapper.emitted('update')?.[0]).toEqual([{ level: 2, reason: 'Incident containment', expectedVersion: 7 }])
  })
})
