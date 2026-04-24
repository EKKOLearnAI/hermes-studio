import { createI18n } from 'vue-i18n'
import { messages } from './messages'

const saved = localStorage.getItem('hermes_locale')
const detected = navigator.language.slice(0, 2)

const supportedLocales = ['en', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'pt'] as const
type SupportedLocale = (typeof supportedLocales)[number]

function resolveLocale(saved: string | null, detected: string): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }
  if ((supportedLocales as readonly string[]).includes(detected)) {
    return detected as SupportedLocale
  }
  return 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(saved, detected),
  fallbackLocale: 'en',
  messages,
})
