// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const shown: Array<{ title: string; options?: NotificationOptions; instance: any }> = []

class MockNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
  onclick: (() => void) | null = null
  close = vi.fn()

  constructor(title: string, options?: NotificationOptions) {
    shown.push({ title, options, instance: this })
  }
}

beforeEach(() => {
  shown.splice(0)
  vi.restoreAllMocks()
  Object.defineProperty(window, 'Notification', { configurable: true, value: MockNotification })
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined })
  localStorage.clear()
  vi.spyOn(window, 'focus').mockImplementation(() => undefined)
})

describe('system notification adapter', () => {
  it('only notifies while the Studio document is hidden or unfocused and invokes the exact click target', async () => {
    const { showSystemNotification } = await import('@/utils/completion-notification')
    const onClick = vi.fn()

    expect(await showSystemNotification({ title: 'Approval required', body: 'Open Studio to review.', tag: 'approval:key-1', onClick })).toBe(true)
    expect(shown).toHaveLength(1)
    shown[0].instance.onclick()
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    expect(await showSystemNotification({ title: 'Approval required', body: 'Open Studio to review.', tag: 'approval:key-2', onClick })).toBe(false)
    expect(shown).toHaveLength(1)
  })

  it('deduplicates a stable tag across repeated delivery and never places sensitive source text in the payload', async () => {
    const { showSystemNotification } = await import('@/utils/completion-notification')
    const payload = {
      title: 'Approval required',
      body: 'Open Studio to review.',
      tag: 'approval:chat-approval:session-a:approval-a',
      onClick: vi.fn(),
    }
    expect(await showSystemNotification(payload)).toBe(true)
    expect(await showSystemNotification(payload)).toBe(false)
    expect(shown).toHaveLength(1)
    expect(JSON.stringify(shown[0])).not.toContain('rm -rf')
    expect(JSON.stringify(shown[0])).not.toContain('/home/agent')
    expect(JSON.stringify(shown[0])).not.toContain('Which environment?')
  })

  it('passes only an internal Hermes target to the service worker notification', async () => {
    const showNotification = vi.fn(async () => undefined)
    const registration = { showNotification }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    } })
    const { showSystemNotification } = await import('@/utils/completion-notification')

    expect(await showSystemNotification({
      title: 'Approval required', body: 'Open Studio to review.', tag: 'approval:sw-safe',
      clickUrl: '/hermes/session/session-a',
    })).toBe(true)
    expect(showNotification).toHaveBeenCalledWith('Approval required', expect.objectContaining({
      data: { clickUrl: '/hermes/session/session-a' },
    }))

    await showSystemNotification({
      title: 'Approval required', body: 'Open Studio to review.', tag: 'approval:sw-unsafe',
      clickUrl: 'https://example.com/steal',
    })
    expect(showNotification).toHaveBeenLastCalledWith('Approval required', expect.not.objectContaining({
      data: { clickUrl: 'https://example.com/steal' },
    }))
  })

  it('uses a cross-tab Web Lock and shared ledger for one delivery per tag', async () => {
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<boolean>) => callback({}))
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const { showSystemNotification } = await import('@/utils/completion-notification')
    expect(await showSystemNotification({ title: 'Approval required', tag: 'approval:cross-tab' })).toBe(true)
    expect(request).toHaveBeenCalledWith(expect.stringContaining('approval:cross-tab'), { ifAvailable: true }, expect.any(Function))
    expect(localStorage.getItem('hermes-system-notification-ledger-v1')).toContain('approval:cross-tab')
  })

  it('suppresses a hidden tab when another Studio tab has a fresh foreground heartbeat', async () => {
    localStorage.setItem('hermes-system-notification-foreground-v1', JSON.stringify({ 'other-tab': Date.now() }))
    const { showSystemNotification } = await import('@/utils/completion-notification')
    expect(await showSystemNotification({ title: 'Approval required', tag: 'approval:foreground-tab' })).toBe(false)
    expect(shown).toHaveLength(0)
  })

  it('does not suppress after this Studio tab leaves the foreground', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    const module = await import('@/utils/completion-notification')
    window.dispatchEvent(new Event('focus'))

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(await module.showSystemNotification({ title: 'Approval required', tag: 'approval-after-tab-switch' })).toBe(true)
    expect(shown).toHaveLength(1)
  })
})
