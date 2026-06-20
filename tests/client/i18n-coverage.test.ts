import { describe, expect, it, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import { changelog } from '@/data/changelog'
import { messages, supportedLocales } from '@/i18n/messages'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import fr from '@/i18n/locales/fr'
import es from '@/i18n/locales/es'
import de from '@/i18n/locales/de'
import pt from '@/i18n/locales/pt'
import ru from '@/i18n/locales/ru'
import { createI18n } from 'vue-i18n'

const SOURCE_ROOT = join(process.cwd(), 'packages/client/src')

const allMessages: Record<string, Record<string, unknown>> = { en }

const rawMessages: Record<string, Record<string, unknown>> = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  ko,
  fr,
  es,
  de,
  pt,
  ru,
}

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

const APPROVAL_AND_WRITE_GATE_LOCALIZED_KEYS = [
  'chat.approvalAgree',
  'skills.writeApprovalTitle',
  'skills.writeApprovalDescription',
  'skills.writeApprovalEmpty',
  'skills.writeApprovalViewDiff',
  'skills.writeApprovalNoDiff',
  'skills.writeApprovalApprove',
  'skills.writeApprovalReject',
  'skills.writeApprovalPendingMemoryWrite',
  'skills.writeApprovalCurrentFile',
  'skills.writeApprovalPatchOldStringMissing',
  'settings.session.requireAuth',
  'settings.session.memoryWriteApproval',
  'settings.session.skillsWriteApproval',
]

const PLATFORM_SETTINGS_LOCALE_SPECIFIC_LOCALIZED_KEYS: Record<string, string[]> = {
  de: ['platform.qqAppId', 'platform.qqAppSecret'],
  ja: ['platform.homeserver', 'platform.accountId'],
  ko: ['platform.botToken', 'platform.accessToken', 'platform.homeserver', 'platform.weixinToken', 'platform.accountId'],
  ru: ['platform.weixinToken'],
}

const PLATFORM_SETTINGS_LOCALIZED_KEYS = [
  'platform.requireMention',
  'platform.requireMentionGroup',
  'platform.requireMentionChannel',
  'platform.requireMentionRoom',
  'platform.reactions',
  'platform.reactionsHint',
  'platform.freeResponseChats',
  'platform.freeResponseChatsHint',
  'platform.freeResponseChannels',
  'platform.freeResponseChannelsHint',
  'platform.freeResponseRooms',
  'platform.freeResponseRoomsHint',
  'platform.mentionPatterns',
  'platform.mentionPatternsHint',
  'platform.autoThread',
  'platform.autoThreadHint',
  'platform.autoThreadHintRoom',
  'platform.dmMentionThreads',
  'platform.dmMentionThreadsHint',
  'platform.allowBots',
  'platform.allowBotsHint',
  'platform.allowedChannels',
  'platform.allowedChannelsHint',
  'platform.ignoredChannels',
  'platform.ignoredChannelsHint',
  'platform.noThreadChannels',
  'platform.noThreadChannelsHint',
  'platform.exclusiveTokenWarning',
  'platform.botTokenHint',
  'platform.accessTokenHint',
  'platform.homeserverHint',
  'platform.appIdHint',
  'platform.appSecretHint',
  'platform.encryptKey',
  'platform.encryptKeyHint',
  'platform.verificationToken',
  'platform.verificationTokenHint',
  'platform.clientIdHint',
  'platform.clientSecretHint',
  'platform.cardTemplateId',
  'platform.cardTemplateIdHint',
  'platform.botIdHint',
  'platform.wecomSecretHint',
  'platform.waEnabled',
  'platform.waEnabledHint',
  'platform.weixinTokenHint',
  'platform.accountIdHint',
  'platform.qrLogin',
  'platform.qrRelogin',
  'platform.qrFetching',
  'platform.qrScanHint',
  'platform.qrScanedHint',
  'platform.qqAppIdHint',
  'platform.qqAppSecretHint',
  'platform.qqMarkdown',
  'platform.qqMarkdownHint',
  'platform.qqSandbox',
  'platform.qqSandboxHint',
  'platform.qqQrScanHint',
  'platform.allowedUsers',
  'platform.allowedUsersHint',
  'platform.allowAllUsers',
  'platform.allowAllUsersHint',
]

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

  it('localizes approval and write-gate copy in every non-English locale instead of falling back to English', () => {
    const englishMessages = messages.en
    const untranslated = Object.entries(messages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return APPROVAL_AND_WRITE_GATE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(englishMessages, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('localizes platform settings copy in every raw non-English locale instead of falling back to English', () => {
    const untranslated = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      const localeKeys = [
        ...PLATFORM_SETTINGS_LOCALIZED_KEYS,
        ...(PLATFORM_SETTINGS_LOCALE_SPECIFIC_LOCALIZED_KEYS[locale] || []),
      ]

      return localeKeys.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(en, key) ? [`${locale}: ${key}`] : []
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
