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
    expect(wrapper.emitted('update')?.[0]?.[0]).toEqual({ level: 2, reason: 'Incident containment', expectedVersion: 7 })
  })

  it('serializes dialog creation and emits one versioned update for repeated positive callbacks', async () => {
    warnings.length = 0
    const wrapper = mount(EmergencyStopPanel, { props: { control: { level: 0, version: 7, actorUserId: null, reason: '', updatedAt: 'now' }, saving: false } })
    await wrapper.get('[data-test="emergency-level-input-2"]').setValue(true)
    await wrapper.get('[data-test="emergency-reason"]').setValue('Incident containment')
    const button = wrapper.get('[data-test="apply-emergency-stop"]')

    await Promise.all([button.trigger('click'), button.trigger('click')])
    expect(warnings).toHaveLength(1)
    warnings[0].onPositiveClick()
    warnings[0].onPositiveClick()
    expect(wrapper.emitted('update')).toHaveLength(1)
    expect(wrapper.emitted('update')?.[0]?.[0]).toEqual({ level: 2, reason: 'Incident containment', expectedVersion: 7 })
    warnings[0].onClose()
    await wrapper.vm.$nextTick()
    expect(button.attributes('disabled')).toBeDefined()

    await wrapper.setProps({ saving: true })
    await wrapper.setProps({ saving: false })
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('releases a cancelled confirmation so the same version can be confirmed again', async () => {
    warnings.length = 0
    const wrapper = mount(EmergencyStopPanel, { props: { control: { level: 0, version: 7, actorUserId: null, reason: '', updatedAt: 'now' }, saving: false } })
    await wrapper.get('[data-test="emergency-level-input-2"]').setValue(true)
    await wrapper.get('[data-test="emergency-reason"]').setValue('Incident containment')
    const button = wrapper.get('[data-test="apply-emergency-stop"]')

    await button.trigger('click')
    warnings[0].onNegativeClick()
    await wrapper.vm.$nextTick()
    await button.trigger('click')

    expect(warnings).toHaveLength(2)
  })

  it('does not let a stale completion release a newer submitted versioned update', async () => {
    warnings.length = 0
    const wrapper = mount(EmergencyStopPanel, { props: { control: { level: 0, version: 7, actorUserId: null, reason: '', updatedAt: 'now' }, saving: false } })
    await wrapper.get('[data-test="emergency-level-input-2"]').setValue(true)
    await wrapper.get('[data-test="emergency-reason"]').setValue('Incident containment')
    const button = wrapper.get('[data-test="apply-emergency-stop"]')

    await button.trigger('click')
    warnings[0].onPositiveClick()
    const completeA = wrapper.emitted('update')?.[0]?.[1] as () => void
    await wrapper.setProps({ saving: true })
    await wrapper.setProps({ saving: false })
    await button.trigger('click')
    warnings[1].onPositiveClick()
    const completeB = wrapper.emitted('update')?.[1]?.[1] as () => void

    completeA()
    await wrapper.vm.$nextTick()
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(warnings).toHaveLength(2)
    expect(wrapper.emitted('update')?.map(args => (args[0] as any).expectedVersion)).toEqual([7, 7])

    completeB()
    await wrapper.vm.$nextTick()
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('ignores stale dialog callbacks after the authoritative control version changes', async () => {
    warnings.length = 0
    const wrapper = mount(EmergencyStopPanel, { props: { control: { level: 0, version: 7, actorUserId: null, reason: '', updatedAt: 'now' }, saving: false } })
    await wrapper.get('[data-test="emergency-level-input-2"]').setValue(true)
    await wrapper.get('[data-test="emergency-reason"]').setValue('Incident containment')
    await wrapper.get('[data-test="apply-emergency-stop"]').trigger('click')
    const staleDialog = warnings[0]

    await wrapper.setProps({ control: { level: 0, version: 8, actorUserId: null, reason: '', updatedAt: 'later' } })
    const button = wrapper.get('[data-test="apply-emergency-stop"]')
    await button.trigger('click')
    staleDialog.onNegativeClick()
    staleDialog.onClose()
    await wrapper.vm.$nextTick()

    expect(button.attributes('disabled')).toBeDefined()
    warnings[1].onPositiveClick()
    warnings[1].onPositiveClick()
    expect(wrapper.emitted('update')).toHaveLength(1)
    expect(wrapper.emitted('update')?.[0]?.[0]).toMatchObject({ expectedVersion: 8 })
  })
})
