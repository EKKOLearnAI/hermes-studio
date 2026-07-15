// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('i18n lazy loading', () => {
  afterEach(() => {
    localStorage.removeItem('hermes_locale')
    vi.resetModules()
  })

  it('loads only the initial locale and adds another locale on demand', async () => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()

    const { i18nReady, switchLocale } = await import('@/i18n')
    const i18n = await i18nReady

    expect(i18n.global.availableLocales).toEqual(['en'])

    await switchLocale('zh')

    expect(i18n.global.availableLocales).toEqual(['en', 'zh'])
    expect(i18n.global.locale.value).toBe('zh')
    expect(document.documentElement.lang).toBe('zh')
    expect(localStorage.getItem('hermes_locale')).toBe('zh')
    expect(i18n.global.t('common.cancel')).not.toBe('common.cancel')
  })
})
