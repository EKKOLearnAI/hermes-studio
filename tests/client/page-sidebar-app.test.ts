// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

const push = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({ openSessionSearch: vi.fn() }),
}))
vi.mock('naive-ui', () => ({
  NTooltip: defineComponent({
    template: '<div><slot name="trigger" /><slot /></div>',
  }),
}))

import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'

describe('PageSidebarNav APP entry', () => {
  beforeEach(() => push.mockReset())

  it('renders APP directly below API Relay and opens the APP page', async () => {
    const wrapper = mount(PageSidebarNav, { props: { active: 'chat' } })
    const labels = wrapper.findAll('.page-sidebar-tab').map(button => button.text())

    expect(labels).toEqual([
      'chat.newChat',
      'sidebar.search',
      'sidebar.history',
      'sidebar.apiRelay',
      'sidebar.app',
    ])

    await wrapper.findAll('.page-sidebar-tab')[4].trigger('click')
    expect(push).toHaveBeenCalledWith({ name: 'hermes.appRelay' })
  })
})
