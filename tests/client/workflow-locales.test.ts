import { describe, expect, it } from 'vitest'
import en from '../../packages/client/src/i18n/locales/en'
import zh from '../../packages/client/src/i18n/locales/zh'
import zhTW from '../../packages/client/src/i18n/locales/zh-TW'
import ru from '../../packages/client/src/i18n/locales/ru'
import ja from '../../packages/client/src/i18n/locales/ja'
import ko from '../../packages/client/src/i18n/locales/ko'
import fr from '../../packages/client/src/i18n/locales/fr'
import es from '../../packages/client/src/i18n/locales/es'
import de from '../../packages/client/src/i18n/locales/de'
import pt from '../../packages/client/src/i18n/locales/pt'
import { createI18n } from 'vue-i18n'

const localeMessages: Record<string, Record<string, unknown>> = {
  en, zh, 'zh-TW': zhTW, ru, ja, ko, fr, es, de, pt,
}
const operatorKeys = ['equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists']
const requiredPaths = [
  'workflow.canvasAriaLabel',
  'workflow.budget.runTitle',
  'workflow.budget.rerunTitle',
  'workflow.budget.totalLabel',
  'workflow.budget.customMinutes',
  'workflow.budget.invalidCustom',
  'workflow.budget.help',
  'workflow.budget.options.unlimited',
  'workflow.budget.options.30',
  'workflow.budget.options.60',
  'workflow.budget.options.90',
  'workflow.budget.options.custom',
  'workflow.budget.unlimitedSummary',
  'workflow.budget.unlimitedHelp',
  'workflow.budget.summary',
  'workflow.budget.deadline',
  'workflow.budget.nodeStartRemaining',
  'workflow.edgeEditor.historyNode',
  'workflow.edgeEditor.historyNodePlaceholder',
  'workflow.edgeEditor.conditionSemantics',
  'workflow.edgeEditor.canvasLabel.withValue',
  'workflow.edgeEditor.canvasLabel.withoutValue',
  'workflow.edgeEditor.canvasLabel.join',
  'workflow.evidence.resizeConclusion',
  'workflow.runs.snapshotIndicator',
  ...operatorKeys.flatMap(operator => [
    `workflow.edgeEditor.rawTextOperatorHelp.${operator}`,
    `workflow.edgeEditor.jsonFieldOperatorHelp.${operator}`,
  ]),
]

function getPath(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  ), messages)
}

function collectLeafPaths(value: unknown, prefix: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => collectLeafPaths(child, `${prefix}.${key}`))
    .sort()
}

describe('Workflow locale coverage', () => {
  it('defines every Workflow key directly in every locale without fallback', () => {
    const englishPaths = collectLeafPaths(en.workflow, 'workflow')
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(collectLeafPaths(messages.workflow, 'workflow'), `${locale} Workflow keys`).toEqual(englishPaths)
    }
  })

  it('compiles every Workflow message in every locale', () => {
    const paths = collectLeafPaths(en.workflow, 'workflow')
    const values = {
      count: 2, failed: 1, node: 'Node', nodes: 'Node A, Node B', gate: 'quality',
      source: 'Source', target: 'Target', decision: 'blocked', reason: 'quality',
      expected: 'ready', actual: 'blocked', path: 'outputJson.status', value: 'ready',
      operator: 'equals', route: 'success', subject: 'status', id: 'loop-1',
    }
    for (const [locale, messages] of Object.entries(localeMessages)) {
      const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })
      for (const path of paths) {
        expect(() => i18n.global.t(path, values), `${locale} failed to compile ${path}`).not.toThrow()
        expect(i18n.global.t(path, values), `${locale} missing ${path}`).not.toBe(path)
      }
    }
  })

  it('defines every new nested Workflow key at the correct path in every locale', () => {
    for (const [locale, messages] of Object.entries(localeMessages)) {
      for (const path of requiredPaths) {
        expect(getPath(messages, path), `${locale} missing ${path}`).toEqual(expect.any(String))
      }
    }
  })

  it('compiles and interpolates every new operator explanation in every locale', () => {
    for (const [locale, messages] of Object.entries(localeMessages)) {
      const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })
      for (const operator of operatorKeys) {
        for (const mode of ['rawTextOperatorHelp', 'jsonFieldOperatorHelp']) {
          const key = `workflow.edgeEditor.${mode}.${operator}`
          const rendered = i18n.global.t(key, { path: 'outputJson.failed_gate', value: 'quality' })
          expect(rendered, `${locale} failed to compile ${key}`).not.toBe(key)
          expect(rendered.length).toBeGreaterThan(10)
        }
      }
    }
  })
})
