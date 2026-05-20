// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useProfilesStore } from '@/stores/hermes/profiles'

const openSessionSearchMock = vi.hoisted(() => vi.fn())
const replaceMock = vi.hoisted(() => vi.fn())
const getAuthModeMock = vi.hoisted(() => vi.fn(() => 'token'))
const getWebPlaneMock = vi.hoisted(() => vi.fn(() => 'both'))
const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const setRuntimeModeMock = vi.hoisted(() => vi.fn())
const fetchCurrentUserMock = vi.hoisted(() => vi.fn())
const fetchFeishuUatStatusMock = vi.hoisted(() => vi.fn())
const startFeishuUatAuthMock = vi.hoisted(() => vi.fn())
const pollFeishuUatAuthMock = vi.hoisted(() => vi.fn())
const authWindowMock = vi.hoisted(() => ({
  location: { href: '' },
  opener: {},
  close: vi.fn(),
}))
const windowOpenMock = vi.hoisted(() => vi.fn(() => authWindowMock))
const appStoreMock = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: 'test',
  toggleSidebar: vi.fn(),
  closeSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  checkConnection: vi.fn(),
}))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('open', windowOpenMock)

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useRoute: () => ({ name: 'hermes.chat' }),
    useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('@/api/client', () => ({
  getAuthMode: getAuthModeMock,
  getWebPlane: getWebPlaneMock,
  isUserMode: isUserModeMock,
  setRuntimeMode: setRuntimeModeMock,
}))

vi.mock('@/api/auth', () => ({
  fetchCurrentUser: fetchCurrentUserMock,
  fetchFeishuUatStatus: fetchFeishuUatStatusMock,
  startFeishuUatAuth: startFeishuUatAuthMock,
  pollFeishuUatAuth: pollFeishuUatAuthMock,
}))

vi.mock('/logo.png', () => ({
  default: 'logo.png',
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
      template: '<button><slot /></button>',
    },
    NSelect: {
      template: '<div />',
    },
  }
})

import AppSidebar from '@/components/layout/AppSidebar.vue'

describe('AppSidebar search entry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    openSessionSearchMock.mockClear()
    replaceMock.mockClear()
    getAuthModeMock.mockReturnValue('token')
    getWebPlaneMock.mockReturnValue('both')
    isUserModeMock.mockReturnValue(false)
    appStoreMock.sidebarCollapsed = false
    appStoreMock.connected = true
    appStoreMock.checkConnection.mockClear()
    setRuntimeModeMock.mockClear()
    fetchCurrentUserMock.mockRejectedValue(new Error('not logged in'))
    fetchFeishuUatStatusMock.mockResolvedValue({ status: 'missing' })
    startFeishuUatAuthMock.mockClear()
    startFeishuUatAuthMock.mockResolvedValue({
      status: 'pending',
      session_id: 'sess-1',
      verification_uri: 'https://accounts.feishu.cn/device?user_code=ABCD-1234',
      user_code: 'ABCD-1234',
      interval: 10,
    })
    pollFeishuUatAuthMock.mockClear()
    pollFeishuUatAuthMock.mockResolvedValue({ status: 'pending' })
    windowOpenMock.mockClear()
    authWindowMock.location.href = ''
    authWindowMock.opener = {}
    authWindowMock.close.mockClear()
    fetchMock.mockReset()
  })

  it('opens the session search modal from the sidebar button', async () => {
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    const buttons = wrapper.findAll('button')
    const searchButton = buttons.find(node => node.text().includes('sidebar.search'))
    expect(searchButton).toBeTruthy()

    await searchButton!.trigger('click')
    expect(openSessionSearchMock).toHaveBeenCalledTimes(1)
  })

  it('does not show Web UI version, changelog, or browser update controls', () => {
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('Hermes Web UI')
    expect(wrapper.find('a[href="https://github.com/EKKOLearnAI/hermes-web-ui"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('sidebar.updateVersion')
    expect(wrapper.text()).not.toContain('sidebar.changelog')
  })

  it('hides admin editing surfaces in chat plane user mode', () => {
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).toContain('sidebar.jobs')
    expect(wrapper.text()).toContain('sidebar.skills')
    expect(wrapper.text()).toContain('sidebar.memory')
    expect(wrapper.text()).toContain('sidebar.files')
    expect(wrapper.text()).toContain('sidebar.usage')
    expect(wrapper.text()).toContain('sidebar.settings')
    expect(wrapper.text()).not.toContain('sidebar.channels')
    expect(wrapper.text()).not.toContain('sidebar.models')
    expect(wrapper.text()).not.toContain('sidebar.logs')
    expect(wrapper.text()).not.toContain('sidebar.gateways')
    expect(wrapper.text()).not.toContain('sidebar.profiles')
  })

  it('shows only name and profile in the user identity card', () => {
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    appStoreMock.connected = false
    const pinia = createPinia()
    setActivePinia(pinia)
    const profilesStore = useProfilesStore(pinia)
    profilesStore.setBoundProfile('g41a5b5g', {
      openid: 'ou_cf23e7c262afa4b7a006baa75f863ed5',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
      avatarUrl: 'https://example.com/avatar.png',
    })

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [pinia],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).toContain('陈先生')
    expect(wrapper.text()).not.toContain('飞书 OAuth')
    expect(wrapper.text()).not.toContain('飞书登录')
    expect(wrapper.text()).toContain('g41a5b5g')
    expect(wrapper.text()).not.toContain('已锁定')
    expect(wrapper.text()).not.toContain('ou_cf23e')
    const card = wrapper.find('.sidebar-user')
    expect(card.find('.user-avatar').attributes('src')).toBe('https://example.com/avatar.png')
    expect(card.find('.user-status-dot.standby').exists()).toBe(true)
    expect(card.find('theme-switch-stub').exists()).toBe(false)
    expect(card.find('.card-logout-button').exists()).toBe(true)
    expect(card.find('.card-logout-button').text()).toBe('')
    expect(wrapper.find('.sidebar-footer .logout-item').exists()).toBe(false)
    expect(wrapper.find('.sidebar-footer .status-row').exists()).toBe(false)
    expect(card.find('language-switch-stub').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('sidebar.connected')
    expect(wrapper.text()).not.toContain('sidebar.disconnected')
  })

  it('clears the Feishu OAuth session cookie on logout', async () => {
    getAuthModeMock.mockReturnValue('feishu-oauth-dev')
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    fetchMock.mockResolvedValue({ ok: true })
    localStorage.setItem('hermes_current_user', 'cached')

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    const logoutButton = wrapper.find('.card-logout-button')
    expect(logoutButton.exists()).toBe(true)

    await logoutButton.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/feishu/logout', { method: 'POST' })
    expect(localStorage.getItem('hermes_current_user')).toBeNull()
    expect(setRuntimeModeMock).toHaveBeenCalledWith('feishu-oauth-dev', 'chat')
    expect(replaceMock).toHaveBeenCalledWith({ name: 'login' })
  })

  it('loads the bound Feishu profile without issuing a frontend wake request', async () => {
    getAuthModeMock.mockReturnValue('feishu-oauth-dev')
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    fetchCurrentUserMock.mockResolvedValue({
      openid: 'ou_bound',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
    })
    const pinia = createPinia()

    mount(AppSidebar, {
      global: {
        plugins: [pinia],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    const profilesStore = useProfilesStore(pinia)
    expect(profilesStore.activeProfileName).toBe('g41a5b5g')
  })

  it('shows Feishu UAT connection state and starts one-click authorization from the sidebar', async () => {
    getAuthModeMock.mockReturnValue('feishu-oauth-dev')
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    fetchCurrentUserMock.mockResolvedValue({
      openid: 'ou_bound',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
    })
    fetchFeishuUatStatusMock.mockResolvedValue({ status: 'missing' })
    const pinia = createPinia()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [pinia],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const connector = wrapper.find('.feishu-connector')
    expect(connector.exists()).toBe(true)
    expect(connector.classes()).toContain('missing')
    expect(connector.attributes('title')).toBe('sidebar.feishuNotConnected')

    await connector.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startFeishuUatAuthMock).toHaveBeenCalledOnce()
    expect(windowOpenMock).toHaveBeenCalledWith('about:blank', '_blank')
    expect(authWindowMock.opener).toBeNull()
    expect(authWindowMock.location.href).toBe('https://accounts.feishu.cn/device?user_code=ABCD-1234')
    expect(wrapper.find('.feishu-connector').classes()).toContain('connecting')
  })

  it('treats lark-cli bot fallback as connected instead of starting legacy UAT auth', async () => {
    getAuthModeMock.mockReturnValue('feishu-oauth-dev')
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    fetchCurrentUserMock.mockResolvedValue({
      openid: 'ou_bound',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
    })
    fetchFeishuUatStatusMock.mockResolvedValue({
      status: 'missing',
      lark_cli: {
        available: true,
        default_identity: 'bot',
      },
    })

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const connector = wrapper.find('.feishu-connector')
    expect(connector.classes()).toContain('connected')
    expect(connector.attributes('title')).toBe('sidebar.feishuConnected')

    await connector.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(windowOpenMock).not.toHaveBeenCalled()
    expect(startFeishuUatAuthMock).not.toHaveBeenCalled()
    expect(wrapper.find('.feishu-connector').text()).not.toContain('ABCD-1234')
  })

  it('uses short group labels and keeps group folding active when collapsed', async () => {
    appStoreMock.sidebarCollapsed = true
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
      'sidebar.groupConversationShort',
      'sidebar.groupAgentShort',
      'sidebar.groupMonitoringShort',
      'sidebar.groupSystemShort',
    ])

    const agentGroup = wrapper.findAll('.nav-group')[1]
    expect(agentGroup.find('.nav-group-items').attributes('style')).toBeUndefined()

    await agentGroup.find('.nav-group-label').trigger('click')
    expect(agentGroup.find('.nav-group-items').attributes('style')).toContain('display: none')
  })
})
