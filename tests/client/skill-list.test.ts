// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import SkillList from '@/components/hermes/skills/SkillList.vue'
import { toggleSkill } from '@/api/hermes/skills'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/hermes/skills', () => ({
  toggleSkill: vi.fn(),
  deleteSkillApi: vi.fn(),
}))

vi.mock('naive-ui', () => ({
  NSwitch: defineComponent({
    name: 'NSwitch',
    props: ['value', 'loading'],
    emits: ['update:value', 'click'],
    template: '<button type="button" @click="$emit(\'click\')"></button>',
  }),
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

describe('SkillList', () => {
  describe.each([null, 'external'] as const)('toggle controls with source filter %s', sourceFilter => {
    function mountList(options: { readonly?: boolean; toggleable?: boolean } = {}) {
      return mount(SkillList, {
        props: {
          categories: [{
            name: 'tools',
            description: '',
            skills: [{
              name: 'test-skill',
              description: '',
              enabled: true,
              source: 'external',
              sourcePath: '~/shared/skills',
            }],
          }],
          archived: [],
          selectedSkill: null,
          searchQuery: '',
          sourceFilter,
          ...options,
        },
      })
    }

    it('shows the switch by default and disables the skill', async () => {
      vi.mocked(toggleSkill).mockClear().mockResolvedValue(undefined)
      const wrapper = mountList()
      const toggle = wrapper.getComponent({ name: 'NSwitch' })

      expect(toggle.props('value')).toBe(true)
      toggle.vm.$emit('update:value', false)
      await vi.waitFor(() => {
        expect(toggleSkill).toHaveBeenCalledWith('test-skill', false)
        expect(toggle.props('value')).toBe(false)
      })
    })

    it('hides the switch when toggling is explicitly disabled', () => {
      expect(mountList({ toggleable: false }).findComponent({ name: 'NSwitch' }).exists()).toBe(false)
    })

    it('hides the switch for readonly skills even when toggling is requested', () => {
      expect(mountList({ readonly: true, toggleable: true }).findComponent({ name: 'NSwitch' }).exists()).toBe(false)
    })
  })

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

  it('groups external skills by source path then category when external filter is active', () => {
    const wrapper = mount(SkillList, {
      props: {
        categories: [
          {
            name: 'tools',
            description: '',
            skills: [
              {
                name: 'a-skill',
                description: '',
                enabled: true,
                source: 'external',
                sourcePath: '~/path-a/skills',
              },
              {
                name: 'b-skill',
                description: '',
                enabled: true,
                source: 'external',
                sourcePath: '~/path-b/skills',
              },
            ],
          },
          {
            name: 'misc',
            description: '',
            skills: [
              {
                name: 'c-skill',
                description: '',
                enabled: true,
                source: 'external',
                sourcePath: '~/path-a/skills',
              },
            ],
          },
        ],
        archived: [],
        selectedSkill: null,
        searchQuery: '',
        sourceFilter: 'external',
      },
    })

    // Outer headers are the path groups
    const pathHeaders = wrapper.findAll('.path-header-text').map(el => el.text())
    expect(pathHeaders).toEqual(['~/path-a/skills', '~/path-b/skills'])

    // Inner headers are the categories under each path
    const groups = wrapper.findAll('.skill-path-group')
    expect(groups).toHaveLength(2)
    const aGroupCats = groups[0].findAll('.category-header.sub .category-name').map(el => el.text())
    expect(aGroupCats).toEqual(['tools', 'misc'])
    const bGroupCats = groups[1].findAll('.category-header.sub .category-name').map(el => el.text())
    expect(bGroupCats).toEqual(['tools'])

    // a-skill and c-skill belong to path-a group; b-skill belongs to path-b
    expect(groups[0].text()).toContain('a-skill')
    expect(groups[0].text()).toContain('c-skill')
    expect(groups[0].text()).not.toContain('b-skill')
    expect(groups[1].text()).toContain('b-skill')
  })

  it('falls back to flat category list for non-external filters', () => {
    const wrapper = mount(SkillList, {
      props: {
        categories: [
          {
            name: 'tools',
            description: '',
            skills: [
              { name: 'local-skill', description: '', enabled: true, source: 'local' },
            ],
          },
        ],
        archived: [],
        selectedSkill: null,
        searchQuery: '',
        sourceFilter: null,
      },
    })

    expect(wrapper.find('.path-header-text').exists()).toBe(false)
    expect(wrapper.text()).toContain('tools')
    expect(wrapper.text()).toContain('local-skill')
  })
})
