// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import SkillList from '@/components/hermes/skills/SkillList.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/hermes/skills', () => ({
  toggleSkill: vi.fn(),
}))

vi.mock('naive-ui', () => ({
  NSwitch: defineComponent({
    name: 'NSwitch',
    props: ['value', 'loading'],
    emits: ['update:value', 'click'],
    template: '<button type="button" @click="$emit(\'click\')"></button>',
  }),
  useMessage: () => ({ error: vi.fn() }),
}))

describe('SkillList', () => {
  it('supports filtering skills from external sources', () => {
    const wrapper = mount(SkillList, {
      props: {
        categories: [
          {
            name: 'tools',
            description: '',
            skills: [
              { name: 'local-skill', description: 'Local skill', enabled: true, source: 'local' },
              { name: 'external-skill', description: 'External skill', enabled: true, source: 'external' },
            ],
          },
        ],
        archived: [],
        selectedSkill: null,
        searchQuery: '',
        sourceFilter: 'external',
      },
    })

    expect(wrapper.text()).toContain('external-skill')
    expect(wrapper.text()).not.toContain('local-skill')
    expect(wrapper.get('.source-dot').classes()).toContain('dot-external')
    expect(wrapper.get('.source-dot').attributes('title')).toBe('skills.source.external')
  })
})
