import { createI18n } from 'vue-i18n'
import { messages } from './messages'

const saved = localStorage.getItem('hermes_locale')

const supportedLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt'] as const
type SupportedLocale = (typeof supportedLocales)[number]

function resolveLocale(saved: string | null): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }

  // Normalize a single BCP-47 tag to a supported locale key.
  // Covers zh-Hant-TW, zh-TW, zh-HK, zh-MO, zh-Hant → zh-TW
  //        zh-Hans-*, zh-CN, zh-SG, zh            → zh
  function normalize(tag: string): SupportedLocale | null {
    const lower = tag.toLowerCase()
    if (lower.startsWith('zh')) {
      const isTraditional =
        lower.includes('hant') ||
        lower.includes('-tw') ||
        lower.includes('-hk') ||
        lower.includes('-mo')
      return isTraditional ? 'zh-TW' : 'zh'
    }
    const short = tag.slice(0, 2)
    if ((supportedLocales as readonly string[]).includes(tag)) return tag as SupportedLocale
    if ((supportedLocales as readonly string[]).includes(short)) return short as SupportedLocale
    return null
  }

  for (const lang of navigator.languages) {
    const resolved = normalize(lang)
    if (resolved) return resolved
  }

  return 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(saved),
  fallbackLocale: 'en',
  messages,
})
