import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { androidCompanionMessages, androidSystemMessages } from '@/i18n/android-companion'

describe('Android companion client route', () => {
  it('registers the Personal OS command center lazily', () => {
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
    expect(router).toContain("path: '/hermes/personal-os/android-companion'")
    expect(router).toContain("name: 'hermes.androidCompanion'")
    expect(router).toContain("import('@/views/hermes/AndroidCompanionView.vue')")
  })

  it('ships Android Companion messages for every supported locale', () => {
    const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru']
    expect(Object.keys(androidCompanionMessages)).toEqual(locales)
    expect(Object.keys(androidSystemMessages)).toEqual(locales)
    for (const locale of locales) expect((androidCompanionMessages as any)[locale].pairing.issue).toBeTruthy()
  })
})
