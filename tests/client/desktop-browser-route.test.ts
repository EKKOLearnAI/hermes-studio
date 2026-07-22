// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
  vi.resetModules()
})

describe('desktop browser route gate', () => {
  function browserBridge() {
    const methods = [
      'getState', 'setViewport', 'createTab', 'closeTab', 'activateTab', 'navigate',
      'navigationAction', 'createProfile', 'renameProfile', 'profileSwitchImpact',
      'switchProfile', 'updateProfile', 'deleteProfile', 'clearProfileData',
      'chooseDirectory', 'takeOver', 'annotate', 'cancelAnnotation', 'onStateChange',
    ]
    return Object.fromEntries(methods.map(method => [method, vi.fn()]))
  }

  it('does not register the browser route in an ordinary Web UI', async () => {
    const router = (await import('../../packages/client/src/router')).default
    expect(router.hasRoute('hermes.browser')).toBe(false)
  })

  it('registers the browser route only with the trusted desktop bridge', async () => {
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true, browser: browserBridge() }
    const router = (await import('../../packages/client/src/router')).default
    expect(router.hasRoute('hermes.browser')).toBe(true)
  })

  it('does not register from an incomplete browser bridge', async () => {
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true, browser: { getState: vi.fn() } }
    const router = (await import('../../packages/client/src/router')).default
    expect(router.hasRoute('hermes.browser')).toBe(false)
  })

  it('does not register from the desktop marker without the browser bridge', async () => {
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true }
    const router = (await import('../../packages/client/src/router')).default
    expect(router.hasRoute('hermes.browser')).toBe(false)
  })
})
