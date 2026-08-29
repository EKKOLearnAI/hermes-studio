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

const locales = { ar, de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }

function leafPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' && !Array.isArray(child)
      ? leafPaths(child as Record<string, unknown>, path)
      : [path]
  })
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()
}

describe('Agent Manager locale coverage', () => {
  it('defines the complete Agent Manager messages in every supported locale', () => {
    const englishPaths = leafPaths(en.agentManager).sort()

    for (const [locale, messages] of Object.entries(locales)) {
      expect(messages.sidebar.agentManager, `${locale} sidebar.agentManager`).toEqual(expect.any(String))
      expect(leafPaths(messages.agentManager).sort(), `${locale} agentManager keys`).toEqual(englishPaths)

      for (const path of englishPaths) {
        const key = path as keyof typeof en.agentManager
        expect(placeholders(String(messages.agentManager[key])), `${locale} agentManager.${path} placeholders`)
          .toEqual(placeholders(String(en.agentManager[key])))
      }

      for (const key of ['aiHelpGeneralPrompt', 'aiHelpPrompt'] as const) {
        const prompt = String(messages.agentManager[key])
        expect(prompt, `${locale} agentManager.${key} Skill routing`).toContain('hermes-studio-installation')
        expect(prompt, `${locale} agentManager.${key} reference routing`).not.toContain('references/coding-agents.md')
      }
    }
  })
})
