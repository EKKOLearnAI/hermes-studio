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
        regionData: {
          chest: {
            title: '胸部数据',
            metrics: [
              { label: '胸围', value: '102.5 cm' },
              { label: '体脂率', value: '23.9%' },
            ],
            notes: ['胸部围度来自 Obsidian 基线'],
          },
          shoulders: {
            title: '肩颈数据',
            metrics: [
              { label: '体态限制', value: '右侧肩胛下回旋' },
              { label: '疼痛触发', value: '卧推/飞鸟' },
            ],
            notes: ['右肩颈紧绷'],
          },
        },
        skinLayer: {
          title: '全身皮肤外观层',
          concerns: ['痘印', '黑头', '补水'],
          notes: ['不只管理脸部，后续扩展到全身皮肤区域'],
        },
      },
    })

    expect(wrapper.text()).toContain('Body3D')
    expect(wrapper.text()).toContain('身体数字孪生')
    expect(wrapper.text()).toContain('全身扫描')
    expect(wrapper.text()).toContain('专业解剖模型')
    expect(wrapper.text()).toContain('胸部')
    expect(wrapper.text()).toContain('6 STL')
    expect(wrapper.text()).toContain('Bench Press')
    expect(wrapper.find('[data-test="professional-anatomy-viewer"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="anatomy-model-canvas"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="digital-twin-human"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="twin-region-chest"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="twin-vital-strip"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="selected-region"]').text()).toContain('高优先级')
    expect(wrapper.find('[data-test="selected-region-data"]').text()).toContain('胸围')
    expect(wrapper.find('[data-test="selected-region-data"]').text()).toContain('102.5 cm')
    expect(wrapper.find('[data-test="selected-region-data"]').text()).toContain('体脂率')
    expect(wrapper.find('[data-test="skin-appearance-layer"]').text()).toContain('全身皮肤外观层')
    expect(wrapper.find('[data-test="skin-appearance-layer"]').text()).toContain('黑头')

    await wrapper.find('[data-test="body-region-shoulders"]').trigger('click')

    expect(wrapper.emitted('update:selectedRegion')?.[0]).toEqual(['shoulders'])
    expect(wrapper.emitted('select-region')?.[0]).toEqual(['shoulders'])
    expect(wrapper.text()).toContain('肩部')
    expect(wrapper.text()).toContain('右侧肩胛下回旋')
    expect(wrapper.find('[data-test="selected-region-data"]').text()).toContain('疼痛触发')
    expect(wrapper.find('[data-test="selected-region-data"]').text()).toContain('卧推/飞鸟')
    expect(wrapper.text()).toContain('FMA34680.stl')
  })
})
