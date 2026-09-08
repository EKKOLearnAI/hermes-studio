import { describe, expect, it } from 'vitest'
import ar from '../../packages/client/src/i18n/locales/ar'
import de from '../../packages/client/src/i18n/locales/de'
import en from '../../packages/client/src/i18n/locales/en'
import es from '../../packages/client/src/i18n/locales/es'
import fr from '../../packages/client/src/i18n/locales/fr'
import ja from '../../packages/client/src/i18n/locales/ja'
import ko from '../../packages/client/src/i18n/locales/ko'
import pt from '../../packages/client/src/i18n/locales/pt'
import ru from '../../packages/client/src/i18n/locales/ru'
import zhTW from '../../packages/client/src/i18n/locales/zh-TW'
import zh from '../../packages/client/src/i18n/locales/zh'

const localeMessages: Record<string, Record<string, unknown>> = {
  ar,
  de,
  en,
  es,
  fr,
  ja,
  ko,
  pt,
  ru,
  'zh-TW': zhTW,
  zh,
}

function getPath(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  ), messages)
}

describe('desktop link-opening preference translations', () => {
  it('provides the setting label, hint, and both targets in every locale', () => {
    const keys = [
      'settings.display.linkOpenTarget',
      'settings.display.linkOpenTargetHint',
      'settings.display.linkOpenTargetHermesStudio',
      'settings.display.linkOpenTargetDefaultBrowser',
    ]

    for (const [locale, messages] of Object.entries(localeMessages)) {
      for (const key of keys) {
        const value = getPath(messages, key)
        expect(value, `${locale} missing ${key}`).toEqual(expect.any(String))
        expect(String(value).trim(), `${locale} has an empty ${key}`).not.toBe('')
      }
      expect(
        getPath(messages, 'settings.display.linkOpenTargetHermesStudio'),
        `${locale} link targets must remain distinct`,
      ).not.toBe(getPath(messages, 'settings.display.linkOpenTargetDefaultBrowser'))
    }
  })
})
