import en from './locales/en'

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

const localeLoaders: Record<string, () => Promise<{ default: LocaleMessages }>> = {
  'zh': () => import('./locales/zh'),
  'zh-TW': () => import('./locales/zh-TW'),
  'ja': () => import('./locales/ja'),
  'ko': () => import('./locales/ko'),
  'fr': () => import('./locales/fr'),
  'es': () => import('./locales/es'),
  'de': () => import('./locales/de'),
  'pt': () => import('./locales/pt'),
}

export { en }

export async function loadLocale(locale: string): Promise<LocaleMessages | null> {
  if (locale === 'en') return en

  const loader = localeLoaders[locale]
  if (!loader) return null

  const mod = await loader()
  return mergeMessagesWithFallback(en, mod.default)
}
