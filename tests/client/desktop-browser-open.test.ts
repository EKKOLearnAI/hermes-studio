// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

function browserBridge() {
  const createTab = vi.fn().mockResolvedValue({ id: 'web-tab' })
  const createHtmlPreviewTab = vi.fn().mockResolvedValue({ id: 'html-tab' })
  const methods = [
    'getState', 'setViewport', 'closeTab', 'activateTab', 'navigate',
    'navigationAction', 'createProfile', 'chooseProfileRootDirectory', 'renameProfile', 'profileSwitchImpact',
    'switchProfile', 'updateProfile', 'deleteProfile', 'clearProfileData', 'cancelDownload',
    'takeOver', 'annotate', 'cancelAnnotation', 'updateAnnotationNote',
    'captureAnnotations', 'clearAnnotations', 'onAnnotationRequest', 'onStateChange',
  ]
  return {
    ...Object.fromEntries(methods.map(method => [method, vi.fn()])),
    createTab,
    createHtmlPreviewTab,
  }
}

afterEach(() => {
  delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
  vi.resetModules()
})

describe('desktop browser open helpers', () => {
  it('opens web URLs and HTML content through the trusted desktop bridge', async () => {
    const browser = browserBridge()
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
    }
    const listener = vi.fn()
    const { OPEN_DESKTOP_BROWSER_PANEL_EVENT, openHtmlInDesktopBrowser, openUrlInDesktopBrowser } = await import(
      '../../packages/client/src/utils/desktop-browser'
    )
    window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, listener)

    await expect(openUrlInDesktopBrowser('https://example.com')).resolves.toBe(true)
    await expect(openHtmlInDesktopBrowser('<h1>Hello</h1>', 'report.html')).resolves.toBe(true)

    expect(browser.createTab).toHaveBeenCalledWith('https://example.com', true)
    expect(browser.createHtmlPreviewTab).toHaveBeenCalledWith('<h1>Hello</h1>', 'report.html', true)
    expect(listener).toHaveBeenCalledTimes(2)
    window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, listener)
  })

  it('leaves Web UI behavior untouched without the desktop bridge', async () => {
    const { openHtmlInDesktopBrowser, openUrlInDesktopBrowser } = await import(
      '../../packages/client/src/utils/desktop-browser'
    )

    await expect(openUrlInDesktopBrowser('https://example.com')).resolves.toBe(false)
    await expect(openHtmlInDesktopBrowser('<h1>Hello</h1>', 'report.html')).resolves.toBe(false)
  })

  it('keeps URL browsing available with an older desktop bridge and falls back for HTML previews', async () => {
    const browser = browserBridge()
    delete (browser as Partial<typeof browser>).createHtmlPreviewTab
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
    }
    const { openHtmlInDesktopBrowser, openUrlInDesktopBrowser } = await import(
      '../../packages/client/src/utils/desktop-browser'
    )

    await expect(openUrlInDesktopBrowser('https://example.com')).resolves.toBe(true)
    await expect(openHtmlInDesktopBrowser('<h1>Hello</h1>', 'report.html')).resolves.toBe(false)
    expect(browser.createTab).toHaveBeenCalledWith('https://example.com', true)
  })
})
