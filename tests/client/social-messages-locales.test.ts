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

const locales = { ar, de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') result.set(path, child)
    else for (const [childPath, text] of flatten(child, path)) result.set(childPath, text)
  }
  return result
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort()
}

describe('Social Messages locale coverage', () => {
  const english = flatten(en.socialMessages)

  it('defines the complete message structure and matching placeholders in every locale', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      const localized = flatten(messages.socialMessages)
      expect([...localized.keys()].sort(), `${locale} Social Messages keys`).toEqual([...english.keys()].sort())
      for (const [path, englishText] of english) {
        expect(placeholders(localized.get(path) || ''), `${locale} ${path} placeholders`)
          .toEqual(placeholders(englishText))
      }
    }
  })

  it('uses localized copy instead of the English object in every non-English locale', () => {
    const customerFacingPaths = [
      'title',
      'description',
      'composerTitle',
      'recipientType',
      'contentPlaceholder',
      'send',
      'sendFailed',
      'configureFirst',
      'standaloneAccountHint',
      'feishuQrScan',
      'weixinQrScan',
      'weixinPushAwaitingFirstMessage',
      'telegramPushAwaitingFirstMessage',
      'feishuPushAwaitingFirstMessage',
      'deliveryStatus',
      'noDelivery',
    ]
    for (const [locale, messages] of Object.entries(locales)) {
      if (locale === 'en') continue
      const localized = flatten(messages.socialMessages)
      for (const path of customerFacingPaths) {
        expect(localized.get(path), `${locale} still uses English for ${path}`).not.toBe(english.get(path))
      }
    }
  })

  it('translates the chat push switch in every supported locale', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      expect(messages.chat.pushEnabled, `${locale} missing chat.pushEnabled`).toEqual(expect.any(String))
      expect(messages.chat.pushEnabled.trim(), `${locale} has an empty chat.pushEnabled`).not.toBe('')
      if (locale !== 'en') expect(messages.chat.pushEnabled).not.toBe(en.chat.pushEnabled)
    }
  })
})
