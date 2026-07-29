/**
 * Writing direction for a locale tag.
 *
 * Kept independent of `supportedLocales` so the document direction is correct
 * for any locale tag the app is switched to, including regional forms such as
 * `ar-SA`.
 */

const RTL_LANGUAGES = new Set([
  'ar', // Arabic
  'fa', // Persian
  'he', // Hebrew
  'iw', // Hebrew (legacy tag)
  'ur', // Urdu
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'yi', // Yiddish
])

export type WritingDirection = 'rtl' | 'ltr'

export function isRtlLocale(locale: string): boolean {
  const primary = locale.split(/[-_]/)[0]?.toLowerCase() ?? ''
  return RTL_LANGUAGES.has(primary)
}

export function localeDirection(locale: string): WritingDirection {
  return isRtlLocale(locale) ? 'rtl' : 'ltr'
}

/** Mirrors the document for RTL locales so native bidi layout applies. */
export function applyDocumentDirection(locale: string): void {
  document.documentElement.dir = localeDirection(locale)
}
