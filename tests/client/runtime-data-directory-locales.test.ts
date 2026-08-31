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
  'runtimeVersions.dataDirectoryEnvDescription',
  'runtimeVersions.dataDirectoryEnvInstructions',
  'runtimeVersions.dataDirectoryEnvWindows',
  'runtimeVersions.dataDirectoryEnvMacos',
  'runtimeVersions.dataDirectoryEnvLinux',
  'runtimeVersions.dataDirectoryEnvDocker',
  'runtimeVersions.dataDirectoryEnvRestart',
]

function getPath(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  ), messages)
}

describe('Runtime data directory locale coverage', () => {
  it('defines the environment setup help directly in every supported locale', () => {
    for (const [locale, messages] of Object.entries(localeMessages)) {
      for (const path of requiredPaths) {
        expect(getPath(messages, path), `${locale} missing ${path}`).toEqual(expect.any(String))
      }
    }
  })
})
