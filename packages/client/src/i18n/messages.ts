import en from './locales/en'
import zh from './locales/zh'
import zhTW from './locales/zh-TW'
import ja from './locales/ja'
import ko from './locales/ko'
import fr from './locales/fr'
import es from './locales/es'
import de from './locales/de'
import pt from './locales/pt'

export type LocaleMessages = Record<string, any>

export const supportedLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt'] as const
export type SupportedLocale = (typeof supportedLocales)[number]

function isPlainObject(value: unknown): value is LocaleMessages {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function mergeMessagesWithFallback(
  fallback: LocaleMessages,
  locale: LocaleMessages,
): LocaleMessages {
  const merged: LocaleMessages = { ...fallback }

  for (const [key, value] of Object.entries(locale)) {
    const fallbackValue = fallback[key]
    merged[key] = isPlainObject(fallbackValue) && isPlainObject(value)
      ? mergeMessagesWithFallback(fallbackValue, value)
      : value
  }

  return merged
}

const rawMessages: Record<string, LocaleMessages> = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt }

export const messages: Record<string, LocaleMessages> = {}
for (const [locale, msg] of Object.entries(rawMessages)) {
  messages[locale] = locale === 'en' ? msg : mergeMessagesWithFallback(en, msg)
}

export { en }
