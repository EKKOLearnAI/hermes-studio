// @vitest-environment jsdom
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProfileCard from '../../packages/client/src/components/hermes/profiles/ProfileCard.vue'

const profilesStoreMocks = {
  fetchProfileDetail: vi.fn(),
  switchHermesProfile: vi.fn(),
  deleteProfile: vi.fn(),
  exportProfile: vi.fn(),
}

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    inheritAttrs: false,
    setup(_, { slots, attrs }) {
      return () => h('button', attrs, slots.default?.())
    },
  }),
  NTag: defineComponent({
    setup(_, { slots }) {
      return () => h('span', slots.default?.())
    },
  }),
  NSpin: defineComponent({
    props: ['show'],
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    },
  }),
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
  useDialog: () => ({
    warning: vi.fn(),
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({ 'common.edit': 'Edit' }[key] || key),
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMocks,
}))

describe('ProfileCard', () => {
  it('emits edit with the current profile when the edit button is clicked', async () => {
    const wrapper = mount(ProfileCard, {
      props: {
        profile: {
          name: 'research',
          active: false,
          model: 'gpt-5',
          alias: '',
        },
      },
    })

    await wrapper.findAll('button').find(button => button.text() === 'Edit')?.trigger('click')

    expect(wrapper.emitted('edit')?.[0]).toEqual([{ name: 'research', active: false, model: 'gpt-5', alias: '' }])
  })
})
