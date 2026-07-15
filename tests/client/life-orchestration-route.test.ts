import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lifeMessages, lifeSystemMessages } from '@/i18n/life-orchestration'

describe('life orchestration client route', () => {
  it('registers Life & Leisure as a lazy Personal OS command center', () => {
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
    const personalOs = readFileSync('packages/client/src/views/hermes/PersonalOSView.vue', 'utf8')
    expect(router).toContain("path: '/hermes/personal-os/life'")
    expect(router).toContain("name: 'hermes.lifeOrchestration'")
    expect(router).toContain("import('@/views/hermes/LifeOrchestrationView.vue')")
    expect(personalOs).toContain("{ key: 'life', href: '#/hermes/personal-os/life' }")
  })

  it('ships complete life and system messages for every supported locale', () => {
    const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru']
    expect(Object.keys(lifeMessages)).toEqual(locales)
    expect(Object.keys(lifeSystemMessages)).toEqual(locales)
    for (const locale of locales) {
      const messages = lifeMessages[locale]!
      expect(messages.title).toBeTruthy()
      expect(messages.planner.materialChanged).toBeTruthy()
      expect(messages.planner.holdWarning).toBeTruthy()
      expect(messages.subscriptions.warning).toBeTruthy()
      expect(messages.workflowState.waiting_user).toBeTruthy()
      expect(lifeSystemMessages[locale as keyof typeof lifeSystemMessages].title).toBeTruthy()
    }
  })
})
