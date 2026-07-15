// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeMock = vi.hoisted(() => ({ name: 'hermes.chat' as string }))
const appStoreMock = vi.hoisted(() => ({
  nodeVersion: '23.0.0',
  sidebarOpen: true,
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
  default: { name: 'DesktopTitleBar', template: '<div />' },
}))

import App from '@/App.vue'

type WindowWithDesktop = typeof window & {
  hermesDesktop?: { isDesktop?: boolean; platform?: string }
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
        DesktopTitleBar: true,
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
    delete (window as WindowWithDesktop).hermesDesktop
  })

  it('mounts the web pet in the browser web app', async () => {
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(true)
  })

  it('does not mount the web pet in the Electron desktop shell', () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'darwin' },
    })

    const wrapper = mountApp()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
  })

  it('does not duplicate the web pet on the dedicated desktop pet route', () => {
    routeMock.name = 'desktop.pet'

    const wrapper = mountApp()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
  })
})
