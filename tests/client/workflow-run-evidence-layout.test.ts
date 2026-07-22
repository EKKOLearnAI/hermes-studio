import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('Workflow run conclusion information hierarchy', () => {
  it('keeps the operator path checks ahead of progressive run details', () => {
    const view = read('packages/client/src/views/hermes/WorkflowView.vue')
    const overviewStart = view.indexOf('data-testid="workflow-evidence-overview"')
    const pathChecksStart = view.indexOf('data-testid="workflow-path-checks-toggle"')
    const detailsTriggerStart = view.indexOf('data-testid="workflow-run-evidence-details-trigger"')

    expect(overviewStart).toBeGreaterThanOrEqual(0)
    expect(pathChecksStart).toBeGreaterThan(overviewStart)
    expect(detailsTriggerStart).toBeGreaterThan(pathChecksStart)
    const overview = view.slice(overviewStart, pathChecksStart)
    expect(overview).not.toContain('<ul v-if="selectedWorkflowRunBudgetSessions.length > 0">')
    expect(view).toContain('data-testid="workflow-actual-path-compact"')
    expect(view).toContain('data-testid="workflow-run-budget-compact"')
    expect(view).toContain('data-testid="workflow-run-evidence-details-modal"')
  })

  it('gives path judgments the remaining scrollable height without unbounded overview lists', () => {
    const view = read('packages/client/src/views/hermes/WorkflowView.vue')

    expect(view).toMatch(/\.workflow-evidence-overview\s*\{[^}]*flex:\s*0 0 auto/s)
    expect(view).toMatch(/\.workflow-evidence-actual-path-compact\s*\{[^}]*white-space:\s*nowrap[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s)
    expect(view).toMatch(/\.workflow-run-budget-compact\s*\{[^}]*white-space:\s*nowrap[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s)
    expect(view).toMatch(/\.workflow-evidence-list\s*\{[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto/s)
    expect(view).toMatch(/\.workflow-run-evidence-details-list\s*\{[^}]*max-height:[^;}]+[^}]*overflow-y:\s*auto/s)
  })

  it('localizes the progressive details control for every supported locale', () => {
    for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-TW', 'zh']) {
      const source = read(`packages/client/src/i18n/locales/${locale}.ts`)
      expect(source).toContain('runDetails:')
      expect(source).toContain('actualPathSteps:')
      expect(source).toContain('nodeBudgetDetails:')
    }
  })
})
