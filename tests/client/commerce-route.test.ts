import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { commerceMessages, commerceSystemMessages } from '@/i18n/commerce'

describe('commerce client route', () => {
  it('registers Commerce as a lazy Personal OS command center', () => {
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
    const personalOs = readFileSync('packages/client/src/views/hermes/PersonalOSView.vue', 'utf8')
    expect(router).toContain("path: '/hermes/personal-os/commerce'")
    expect(router).toContain("name: 'hermes.commerce'")
    expect(router).toContain("import('@/views/hermes/CommerceView.vue')")
    expect(personalOs).toContain("{ key: 'commerce', href: '#/hermes/personal-os/commerce' }")
  })

  it('ships complete Commerce and system messages for every supported locale', () => {
    const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru']
    expect(Object.keys(commerceMessages)).toEqual(locales)
    expect(Object.keys(commerceSystemMessages)).toEqual(locales)
    for (const locale of locales) {
      const messages = commerceMessages[locale]!
      expect(messages.title).toBeTruthy()
      expect(messages.confirm.liveWarning).toBeTruthy()
      expect(messages.payment.warning).toBeTruthy()
      expect(messages.transactionState.lookup_required).toBeTruthy()
      expect(commerceSystemMessages[locale as keyof typeof commerceSystemMessages].title).toBeTruthy()
    }
  })
})
