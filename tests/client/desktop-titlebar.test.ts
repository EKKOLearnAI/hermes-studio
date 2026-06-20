// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DesktopTitleBar from '@/components/layout/DesktopTitleBar.vue'

type DesktopBridge = {
  platform?: string
  getWindowState?: () => Promise<{ isMaximized: boolean }>
  windowControl?: (action: 'minimize' | 'toggle-maximize' | 'close') => Promise<{ isMaximized: boolean }>
}

function setDesktopBridge(bridge: DesktopBridge) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: bridge,
  })
}

describe('DesktopTitleBar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as typeof window & { hermesDesktop?: DesktopBridge }).hermesDesktop
  })

  it('does not render a custom title bar on Linux so native window controls remain visible', () => {
    setDesktopBridge({ platform: 'linux' })

    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(false)
  })

  it('renders custom window controls on Windows frameless windows', () => {
    setDesktopBridge({
      platform: 'win32',
      getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
      windowControl: vi.fn().mockResolvedValue({ isMaximized: false }),
    })

    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(true)
    expect(wrapper.findAll('.desktop-window-btn')).toHaveLength(3)
  })
})
