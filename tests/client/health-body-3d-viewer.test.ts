// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import HealthBody3DViewer from '@/views/hermes/health/HealthBody3DViewer.vue'

describe('HealthBody3DViewer', () => {
  it('renders selectable body regions with selected model and workout context', async () => {
    const wrapper = mount(HealthBody3DViewer, {
      props: {
        bodyMap: {
          upper_chest: { development_level: 2, activation_level: 2, priority: 'high', posture_constraint_level: 2 },
          rear_delts: { development_level: 3, activation_level: 3, priority: 'medium', posture_constraint_level: 1 },
        },
        selectedRegion: 'chest',
        workouts: [
          {
            id: 'workout-1',
            title: 'Bench Press',
            durationMinutes: 45,
            intensity: 'medium',
            startedAt: '2026-06-20T12:00:00Z',
          },
        ],
        postureProfile: {
          issues: [{ id: 'right_scapular_downward_rotation' }],
          compensation_chain: ['head_neck', 'ribcage'],
        },
      },
    })

    expect(wrapper.text()).toContain('Body3D')
    expect(wrapper.text()).toContain('身体数字孪生')
    expect(wrapper.text()).toContain('全身扫描')
    expect(wrapper.text()).toContain('胸部')
    expect(wrapper.text()).toContain('6 STL')
    expect(wrapper.text()).toContain('Bench Press')
    expect(wrapper.find('[data-test="digital-twin-human"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="twin-region-chest"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="twin-vital-strip"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="selected-region"]').text()).toContain('高优先级')

    await wrapper.find('[data-test="body-region-shoulders"]').trigger('click')

    expect(wrapper.emitted('update:selectedRegion')?.[0]).toEqual(['shoulders'])
    expect(wrapper.emitted('select-region')?.[0]).toEqual(['shoulders'])
    expect(wrapper.text()).toContain('肩部')
    expect(wrapper.text()).toContain('右侧肩胛下回旋')
    expect(wrapper.text()).toContain('FMA34680.stl')
  })
})
