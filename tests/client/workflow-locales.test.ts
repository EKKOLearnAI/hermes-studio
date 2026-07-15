import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const locales = ['en', 'zh', 'zh-TW', 'ru', 'ja', 'ko', 'fr', 'es', 'de', 'pt']
const required = [
  'importWorkflow', 'exportWorkflow', 'importFailed', 'exportFailed',
  'conditionValuePlaceholder', 'invalidConditionValue', 'loopIdPlaceholder',
  'loadFailed',
]

describe('Workflow locale coverage', () => {
  it('defines all new portability, typed-condition, loop, and evidence keys in every locale', () => {
    for (const locale of locales) {
      const source = readFileSync(`packages/client/src/i18n/locales/${locale}.ts`, 'utf8')
      const workflow = source.slice(source.lastIndexOf('  workflow: {'))
      for (const key of required) expect(workflow, `${locale} missing ${key}`).toContain(`${key}:`)
    }
  })
})
