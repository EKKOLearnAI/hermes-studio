// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import BundleCreateModal from '@/components/hermes/chat/BundleCreateModal.vue'

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const createSkillBundleApiMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NModal: { template: '<div><slot /></div>' },
  NForm: { template: '<form><slot /></form>' },
  NFormItem: { template: '<label><slot /></label>' },
  NInput: defineComponent({
    props: ['value', 'type'],
    emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NSelect: defineComponent({
    props: ['value', 'options'],
    emits: ['update:value'],
    template: `
      <select
        class="n-select-stub"
        multiple
        @change="$emit('update:value', Array.from($event.target.selectedOptions).map(option => option.value))"
      >
        <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    `,
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
  }),
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/skill-bundles', () => ({
  createSkillBundleApi: createSkillBundleApiMock,
  skillBundleCommandName: (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-'),
}))

describe('BundleCreateModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSkillsMock.mockResolvedValue({
      categories: [
        {
          name: 'review',
          skills: [
            { name: 'github-review', enabled: true },
            { name: 'security-review', enabled: true },
            { name: 'disabled-review', enabled: false },
          ],
        },
      ],
      archived: [],
    })
    createSkillBundleApiMock.mockResolvedValue({
      name: 'Review Team',
      commandName: 'review-team',
      description: '',
      skills: ['github-review', 'security-review'],
    })
  })

  it('loads enabled skills from the selected profile and creates a multi-skill bundle', async () => {
    const wrapper = mount(BundleCreateModal, { props: { profile: 'work' } })
    await flushPromises()

    expect(fetchSkillsMock).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('github-review')
    expect(wrapper.text()).toContain('security-review')
    expect(wrapper.text()).not.toContain('disabled-review')

    await wrapper.get('.n-input-stub').setValue('Review Team')
    await wrapper.get('.n-select-stub').setValue(['github-review', 'security-review'])
    const buttons = wrapper.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    await flushPromises()

    expect(createSkillBundleApiMock).toHaveBeenCalledWith('work', {
      name: 'Review Team',
      description: '',
      skills: ['github-review', 'security-review'],
    })
    expect(wrapper.emitted('created')?.[0]?.[0]).toEqual(expect.objectContaining({
      commandName: 'review-team',
    }))
  })
})
