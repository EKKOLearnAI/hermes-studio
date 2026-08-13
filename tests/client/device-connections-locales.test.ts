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
  zh,
  'zh-TW': zhTW,
}

const requiredPaths = [
  'sidebar.connections',
  'connections.title',
  'connections.tabs.app',
  'connections.tabs.mcu',
  'connections.tabs.devices',
  'mcuDevices.subtitle',
  'mcuDevices.refresh',
  'devices.subtitle',
]

function getPath(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  ), messages)
}

describe('Device connections locale coverage', () => {
  it('defines every new device connections message directly in every locale', () => {
    for (const [locale, messages] of Object.entries(localeMessages)) {
      for (const path of requiredPaths) {
        expect(getPath(messages, path), `${locale} missing ${path}`).toEqual(expect.any(String))
      }
    }
  })
})
