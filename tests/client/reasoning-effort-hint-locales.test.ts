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
  ar, de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW,
}

function getPath(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  ), messages)
}

/**
 * The slider shows only its two end labels, so users read it as a two-option
 * control. The hint says how many levels it really has — a hint that renders
 * as a raw key, or without its count, defeats the point.
 */
describe('reasoning effort slider hint', () => {
  it('is translated in every locale', () => {
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(getPath(messages, 'chat.reasoningEffort.dragHint'), `${locale} missing the hint`)
        .toEqual(expect.any(String))
    }
  })

  it('carries the level count in every locale', () => {
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(String(getPath(messages, 'chat.reasoningEffort.dragHint')), `${locale} hint drops {count}`)
        .toContain('{count}')
    }
  })
})
