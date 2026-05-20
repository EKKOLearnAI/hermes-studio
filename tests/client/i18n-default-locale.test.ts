// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('i18n default locale', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('keeps an explicitly saved English locale', async () => {
    localStorage.setItem('hermes_locale', 'en')
    Object.defineProperty(window.navigator, 'languages', {
      value: ['zh-CN'],
      configurable: true,
    })
    Object.defineProperty(window.navigator, 'language', {
      value: 'zh-CN',
      configurable: true,
    })

    const { i18n } = await import('@/i18n')

    expect(i18n.global.locale.value).toBe('en')
    expect(localStorage.getItem('hermes_locale')).toBe('en')
  })

  it('uses Chinese when the browser language is Chinese and no locale is saved', async () => {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['zh-CN', 'en-US'],
      configurable: true,
    })
    Object.defineProperty(window.navigator, 'language', {
      value: 'zh-CN',
      configurable: true,
    })

    const { i18n } = await import('@/i18n')

    expect(i18n.global.locale.value).toBe('zh')
  })
})
