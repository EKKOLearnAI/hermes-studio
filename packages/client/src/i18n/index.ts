import { createI18n } from 'vue-i18n'
import { messages, supportedLocales } from './messages'
import type { SupportedLocale } from './messages'

const saved = localStorage.getItem('hermes_locale')

function resolveLocale(saved: string | null): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }

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

const locale = resolveLocale(saved)

export const i18n = createI18n({
  legacy: false,
  locale,
  fallbackLocale: 'en',
  messages,
})

export function switchLocale(newLocale: string): void {
  ;(i18n.global.locale as any).value = newLocale
}
