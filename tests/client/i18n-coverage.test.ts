import { describe, expect, it, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import { changelog } from '@/data/changelog'
import { messages, supportedLocales } from '@/i18n/messages'
import en from '@/i18n/locales/en'
import { createI18n } from 'vue-i18n'

const SOURCE_ROOT = join(process.cwd(), 'packages/client/src')

const allMessages: Record<string, Record<string, unknown>> = { en }

function walkFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(path, files)
    } else if (/\.(ts|vue)$/.test(entry.name) && !path.replace(/\\/g, '/').includes('/i18n/locales/')) {
      files.push(path)
    }
  }
  return files
}

function collectLiteralTranslationKeys(): string[] {
  const keys = new Set<string>()
  const translationCall = /(?:\b|\$)t\(\s*['"]([^'"]+)['"]/g

  for (const file of walkFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(translationCall)) {
      keys.add(match[1])
    }
  }

  for (const entry of changelog) {
    for (const change of entry.changes) {
      keys.add(change)
    }
  }

  return [...keys].sort()
}

function getPath(messages: Record<string, unknown>, key: string): unknown {
  let current: unknown = messages
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function hasPath(messages: Record<string, unknown>, key: string): boolean {
  return typeof getPath(messages, key) !== 'undefined'
}

const SKILLS_USAGE_LOCALIZED_KEYS = [
  'sidebar.skillsUsage',
  'skillsUsage.title',
  'skillsUsage.subtitle',
  'skillsUsage.refresh',
  'skillsUsage.periodSelector',
  'skillsUsage.periodLabel',
  'skillsUsage.summary',
  'skillsUsage.totalActions',
  'skillsUsage.loads',
  'skillsUsage.edits',
  'skillsUsage.distinctSkills',
  'skillsUsage.topSkills',
  'skillsUsage.dailyTrend',
  'skillsUsage.periodSummary',
  'skillsUsage.skill',
  'skillsUsage.share',
  'skillsUsage.lastUsed',
  'skillsUsage.noData',
  'skillsUsage.loadFailed',
  'skillsUsage.otherSkills',
]

const SKILLS_USAGE_COMPACT_LABEL_LIMITS: Record<string, number> = {
  'skillsUsage.totalActions': 12,
  'skillsUsage.loads': 10,
  'skillsUsage.edits': 10,
  'skillsUsage.distinctSkills': 12,
  'skillsUsage.topSkills': 16,
  'skillsUsage.dailyTrend': 16,
  'skillsUsage.skill': 10,
  'skillsUsage.share': 10,
  'skillsUsage.lastUsed': 12,
  'skillsUsage.otherSkills': 16,
}

function labelLength(value: unknown): number {
  return typeof value === 'string' ? Array.from(value.replace(/\{[^}]+\}/g, '')).length : Infinity
}

describe('i18n locale coverage', () => {
  const ALLOWED_MISSING_KEYS = new Set([
    'changelog.new_0_5_4_7',
    'chat.sessionNotFound',
  ])

  beforeAll(() => {
    for (const l of supportedLocales) {
      if (l !== 'en' && messages[l]) {
        allMessages[l] = messages[l]
      }
    }
  })

  it('defines every statically referenced translation key in the English source locale', () => {
    const missing = collectLiteralTranslationKeys()
      .filter((key) => !hasPath(en, key))
      .filter((key) => !ALLOWED_MISSING_KEYS.has(key))

    expect(missing).toEqual([])
  })

  it('defines every statically referenced translation key in effective runtime messages', () => {
    const requiredKeys = collectLiteralTranslationKeys()
    const missing = Object.entries(allMessages).flatMap(([locale, localeMessages]) =>
      requiredKeys
        .filter((key) => !hasPath(localeMessages, key))
        .filter((key) => !ALLOWED_MISSING_KEYS.has(key))
        .map((key) => `${locale}: ${key}`),
    )

    expect(missing).toEqual([])
  })

  it('localizes Skills Usage page copy in every non-English locale instead of falling back to English', () => {
    const englishMessages = messages.en
    const untranslated = Object.entries(messages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return SKILLS_USAGE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(englishMessages, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })


  it('keeps Skills Usage summary and table labels compact across locales', () => {
    const oversized = Object.entries(messages).flatMap(([locale, localeMessages]) =>
      Object.entries(SKILLS_USAGE_COMPACT_LABEL_LIMITS).flatMap(([key, maxLength]) => {
        const localeValue = getPath(localeMessages, key)
        return labelLength(localeValue) > maxLength
          ? [`${locale}: ${key} (${labelLength(localeValue)} > ${maxLength})`]
          : []
      }),
    )

    expect(oversized).toEqual([])
  })

  it('keeps the coverage scanner rooted in client source files', () => {
    expect(relative(process.cwd(), SOURCE_ROOT)).toBe(join('packages', 'client', 'src'))
  })
})
