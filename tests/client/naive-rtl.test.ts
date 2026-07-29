import { describe, expect, it } from 'vitest'
import { NAIVE_RTL_STYLES, naiveRtlFor } from '@/constants/naiveRtl'

describe('NAIVE_RTL_STYLES', () => {
  it('collects Naive UI RTL style modules', () => {
    expect(NAIVE_RTL_STYLES.length).toBeGreaterThan(30)
  })

  it('exposes a named style module for every entry', () => {
    for (const item of NAIVE_RTL_STYLES) {
      expect(typeof item.name, JSON.stringify(item)).toBe('string')
      expect(item.name.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate component entries', () => {
    const names = NAIVE_RTL_STYLES.map(item => item.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('covers the components the app relies on most', () => {
    const names = new Set(NAIVE_RTL_STYLES.map(item => item.name))
    for (const expected of ['Button', 'Input', 'Select', 'Card', 'Drawer', 'Dialog', 'DataTable']) {
      expect(names.has(expected), expected).toBe(true)
    }
  })
})

describe('naiveRtlFor', () => {
  it('returns the style list for right-to-left locales', () => {
    expect(naiveRtlFor('ar')).toBe(NAIVE_RTL_STYLES)
    expect(naiveRtlFor('ar-SA')).toBe(NAIVE_RTL_STYLES)
  })

  it('returns undefined for left-to-right locales so rendering is untouched', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru']) {
      expect(naiveRtlFor(locale), locale).toBeUndefined()
    }
  })
})
