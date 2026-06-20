// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const openSessionSearchMock = vi.hoisted(() => vi.fn())
const mockAppStore = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: 'test',
  latestVersion: '',
  updateAvailable: false,
  clientOutdated: false,
  updating: false,
  toggleSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  closeSidebar: vi.fn(),
  doUpdate: vi.fn(),
  reloadClient: vi.fn(),
}))

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useRoute: () => ({ name: 'hermes.chat' }),
    useRouter: () => ({ push: vi.fn(), hasRoute: () => true }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  createI18n: () => ({
    global: { locale: { value: 'en' }, setLocaleMessage: vi.fn() },
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('/logo.png', () => ({
  default: 'logo.png',
}))

vi.mock('@/components/layout/ProfileSelector.vue', () => ({
  default: { name: 'ProfileSelector', template: '<div />' },
}))

vi.mock('@/components/layout/ModelSelector.vue', () => ({
  default: { name: 'ModelSelector', template: '<div />' },
}))

vi.mock('@/components/layout/LanguageSwitch.vue', () => ({
  default: { name: 'LanguageSwitch', template: '<div />' },
}))

vi.mock('@/components/layout/ThemeSwitch.vue', () => ({
  default: { name: 'ThemeSwitch', template: '<div />' },
}))

vi.mock('@/components/common/RouteLinkItem.vue', () => ({
  default: {
    name: 'RouteLinkItem',
    props: ['to', 'active'],
    template: '<a class="route-link-item" :class="{ active }" href="#"><slot /></a>',
  },
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
    NButton: {
      template: '<button v-bind="$attrs"><slot /></button>',
    },
    NSelect: {
      template: '<div />',
    },
  }
})

import AppSidebar from '@/components/layout/AppSidebar.vue'

describe('AppSidebar navigation', () => {
  beforeEach(() => {
    openSessionSearchMock.mockClear()
    mockAppStore.serverVersion = 'test'
    mockAppStore.latestVersion = ''
    mockAppStore.updateAvailable = false
    mockAppStore.clientOutdated = false
    mockAppStore.updating = false
    mockAppStore.sidebarCollapsed = false
    mockAppStore.reloadClient.mockClear()
  })

  it('keeps page-sidebar-only actions out of the app sidebar', () => {
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('sidebar.search')
    expect(wrapper.text()).not.toContain('sidebar.reloadClientVersion')
    expect(wrapper.find('.sidebar-return-tab').exists()).toBe(true)
  })

  it('uses short group labels and keeps group folding active when collapsed', async () => {
    mockAppStore.sidebarCollapsed = true
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.classes()).toContain('collapsed')
    expect(wrapper.findAll('.nav-group-label span').map(node => node.text())).toEqual([
      'sidebar.groupAgentShort',
      'sidebar.groupMonitoringShort',
      'sidebar.groupToolsShort',
      'sidebar.groupSystemShort',
    ])

    const agentGroup = wrapper.findAll('.nav-group')[0]
    expect(agentGroup.find('.nav-group-items').attributes('style')).toBeUndefined()

    await agentGroup.find('.nav-group-label').trigger('click')
    expect(agentGroup.find('.nav-group-items').attributes('style')).toContain('display: none')
  })
})
