import { createI18n } from 'vue-i18n'
import { messages } from './messages'

const saved = localStorage.getItem('hermes_locale')

const supportedLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt'] as const
type SupportedLocale = (typeof supportedLocales)[number]

function resolveLocale(saved: string | null): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }
  const full = navigator.language          // e.g. "zh-TW"
  const short = full.slice(0, 2)           // e.g. "zh"
  if ((supportedLocales as readonly string[]).includes(full)) {
    return full as SupportedLocale
  }
  if ((supportedLocales as readonly string[]).includes(short)) {
    return short as SupportedLocale
  }
  return 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(saved),
  fallbackLocale: 'en',
  messages,
})
