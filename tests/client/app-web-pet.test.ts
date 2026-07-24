// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeMock = vi.hoisted(() => ({
  name: 'hermes.chat' as string,
  meta: {} as Record<string, unknown>,
}))
const appStoreMock = vi.hoisted(() => ({
  nodeVersion: '23.0.0',
  sidebarOpen: true,
  sidebarCollapsed: false,
  pageSidebarExpanded: true,
  toggleSidebar: vi.fn(),
  closeSidebar: vi.fn(),
  loadModels: vi.fn(),
  startHealthPolling: vi.fn(),
  stopHealthPolling: vi.fn(),
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => routeMock,
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params?.version ? `${key}:${params.version}` : key,
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false, isComic: false }),
}))

vi.mock('@/composables/useKeyboard', () => ({
  useKeyboard: vi.fn(),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/styles/theme', () => ({
  getThemeOverrides: () => ({}),
}))

vi.mock('@/components/hermes/pets/WebPet.vue', () => ({
  default: { name: 'WebPet', template: '<div class="web-pet-test" />' },
}))

vi.mock('@/components/auth/AuthEventListener.vue', () => ({
  default: { name: 'AuthEventListener', template: '<div />' },
}))

vi.mock('@/components/auth/DefaultCredentialPrompt.vue', () => ({
  default: { name: 'DefaultCredentialPrompt', template: '<div />' },
}))

vi.mock('@/components/hermes/models/ProviderConfigurationPrompt.vue', () => ({
  default: { name: 'ProviderConfigurationPrompt', template: '<div />' },
}))

vi.mock('@/components/hermes/chat/SessionSearchModal.vue', () => ({
  default: { name: 'SessionSearchModal', template: '<div />' },
}))

vi.mock('@/components/layout/AppSidebar.vue', () => ({
  default: { name: 'AppSidebar', template: '<aside />' },
}))

vi.mock('@/components/layout/DesktopTitleBar.vue', () => ({
  default: {
    name: 'DesktopTitleBar',
    props: ['standalone', 'leftOffset'],
    template: '<div />',
  },
}))

import App from '@/App.vue'

type WindowWithDesktop = typeof window & {
  hermesDesktop?: {
    isDesktop?: boolean
    platform?: string
    windowKind?: 'main' | 'pet' | 'chat'
    getWindowState?: () => Promise<{ isMaximized: boolean }>
    onWindowStateChange?: (callback: (state: { isMaximized: boolean }) => void) => () => void
  }
}

function mountApp() {
  return mount(App, {
    global: {
      stubs: {
        NConfigProvider: { template: '<div><slot /></div>' },
        NMessageProvider: { template: '<div><slot /></div>' },
        NDialogProvider: { template: '<div><slot /></div>' },
        NNotificationProvider: { template: '<div><slot /></div>' },
        AuthEventListener: true,
        AppSidebar: true,
        SessionSearchModal: true,
        DefaultCredentialPrompt: true,
        RouterView: { template: '<div class="router-view-test" />' },
      },
    },
  })
}

describe('App web pet mounting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeMock.name = 'hermes.chat'
    routeMock.meta = {}
    appStoreMock.sidebarCollapsed = false
    appStoreMock.pageSidebarExpanded = true
    delete (window as WindowWithDesktop).hermesDesktop
  })

  it('mounts the web pet in the browser web app', async () => {
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(true)
  })

  it('uses native macOS traffic lights without mounting custom window controls', () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'darwin' },
    })

    const wrapper = mountApp()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
    expect(wrapper.find('.app-shell').classes()).toContain('desktop-platform-darwin')
    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).exists()).toBe(false)
  })

  it('mounts the standalone Windows control bar above main content', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'win32' },
    })

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.find('.app-shell').classes()).toContain('desktop-platform-win32')
    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).exists()).toBe(true)
  })

  it('expands the Windows control bar when a page-owned sidebar is collapsed', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'win32' },
    })
    appStoreMock.pageSidebarExpanded = false

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).props('leftOffset')).toBe(10)
  })

  it('marks Windows desktop shell as maximized when the native window state changes', async () => {
    let listener: ((state: { isMaximized: boolean }) => void) | undefined
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: 'win32',
        getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
        onWindowStateChange: vi.fn((callback) => {
          listener = callback
          return vi.fn()
        }),
      },
    })

    const wrapper = mountApp()
    await flushPromises()
    expect(wrapper.find('.app-shell').classes()).not.toContain('desktop-window-maximized')

    listener?.({ isMaximized: true })
    await flushPromises()

    expect(wrapper.find('.app-shell').classes()).toContain('desktop-window-maximized')
  })

  it('does not duplicate the web pet on the dedicated desktop pet route', () => {
    routeMock.name = 'desktop.pet'

    const wrapper = mountApp()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
  })

  it('leaves chat window controls to native chrome without mounting the application sidebar', async () => {
    routeMock.name = 'desktop.chat'
    routeMock.meta = { standaloneChat: true }
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'darwin', windowKind: 'chat' },
    })

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.find('.app-shell').classes()).toContain('desktop-chat-window')
    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'AppSidebar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
  })
})
