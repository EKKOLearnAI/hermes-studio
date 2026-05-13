import { describe, expect, it, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import { changelog } from '@/data/changelog'
import { loadLocale, supportedLocales } from '@/i18n/messages'
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

function hasPath(messages: Record<string, unknown>, key: string): boolean {
  let current: unknown = messages
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return false
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current !== 'undefined'
}

describe('i18n locale coverage', () => {
  const ALLOWED_MISSING_KEYS = new Set([
    'changelog.new_0_5_4_7',
    'chat.sessionNotFound',
  ])

  beforeAll(async () => {
    const results = await Promise.all(
      supportedLocales.filter(l => l !== 'en').map(async l => {
        const msgs = await loadLocale(l)
        if (msgs) allMessages[l] = msgs
      }),
    )
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

  it('keeps the coverage scanner rooted in client source files', () => {
    expect(relative(process.cwd(), SOURCE_ROOT)).toBe(join('packages', 'client', 'src'))
  })
})
