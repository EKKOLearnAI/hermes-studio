import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')
const view = () => read('packages/client/src/views/hermes/WorkflowView.vue')

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-TW', 'zh']

describe('Workflow run explainer horizontal pages', () => {
  it('renders history and selected-run details as two discrete full-width pages', () => {
    const source = view()
    const history = source.indexOf('data-testid="workflow-runs-history-page"')
    const details = source.indexOf('data-testid="workflow-run-details-page"')

    expect(history).toBeGreaterThanOrEqual(0)
    expect(details).toBeGreaterThan(history)
    expect(source).toContain('data-testid="workflow-runs-pages"')
    expect(source).toContain("workflowRunPage === 'details'")
    expect(source).toMatch(/\.workflow-runs-pages\s*\{[^}]*width:\s*200%/s)
    expect(source).toMatch(/\.workflow-runs-page\s*\{[^}]*width:\s*50%[^}]*flex:\s*0 0 50%/s)
    expect(source).toMatch(/\.workflow-runs-pages\.show-details\s*\{[^}]*transform:\s*translateX\(-50%\)/s)
  })

  it('removes the old vertical conclusion resize and keeps one vertical scroller per page', () => {
    const source = view()

    for (const obsolete of [
      'workflowEvidenceHeight',
      'workflowEvidenceResizeStart',
      'startWorkflowEvidenceResize',
      'workflow-evidence-resize-handle',
      'resizeConclusion',
    ]) expect(source).not.toContain(obsolete)
    expect(source).toMatch(/\.workflow-runs-page-scroll\s*\{[^}]*overflow-y:\s*auto/s)
    expect(source).toMatch(/\.workflow-evidence-list\s*\{[^}]*overflow:\s*visible/s)
  })

  it('provides explicit back navigation, constrained pointer paging, focus, live announcements, and reduced motion', () => {
    const source = view()

    expect(source).toContain('data-testid="workflow-run-back"')
    expect(source).toContain('ref="workflowRunsPanelRef"')
    expect(source).toContain('@click="showWorkflowRunHistory"')
    expect(source).toContain('@pointerdown="startWorkflowRunPageSwipe"')
    expect(source).toContain('@pointerup="finishWorkflowRunPageSwipe"')
    expect(source).toContain('setPointerCapture(event.pointerId)')
    expect(source).toContain('releasePointerCapture(event.pointerId)')
    expect(source).toContain('resolveWorkflowRunPageSwipe')
    expect(source).toContain('workflowRunPagerModalOpen')
    expect(source).toContain('workflowRunPageScrollTops')
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain('tabindex="-1"')
    expect(source).toMatch(/\.workflow-runs-pages\s*\{[^}]*transition:\s*transform 220ms/s)
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    expect(source).toMatch(/prefers-reduced-motion:[\s\S]*transition-duration:\s*0\.01ms/s)
  })
})

describe('Workflow run explainer information hierarchy', () => {
  it('keeps result status, duration, and budget above process tabs', () => {
    const source = view()
    const overview = source.indexOf('data-testid="workflow-evidence-overview"')
    const tabs = source.indexOf('data-testid="workflow-evidence-tabs"')
    const detailsTrigger = source.indexOf('data-testid="workflow-run-evidence-details-trigger"')

    expect(overview).toBeGreaterThanOrEqual(0)
    expect(tabs).toBeGreaterThan(overview)
    expect(detailsTrigger).toBeGreaterThan(overview)
    expect(source.slice(overview, tabs)).toContain('data-testid="workflow-run-result-status"')
    expect(source.slice(overview, tabs)).toContain('data-testid="workflow-run-result-duration"')
    expect(source.slice(overview, tabs)).toContain('data-testid="workflow-run-budget-compact"')
    expect(source).toContain('data-testid="workflow-run-evidence-details-modal"')
  })

  it('uses accessible tabs for actual execution, other judgments, and loop events with category counts', () => {
    const source = view()

    expect(source).toContain('role="tablist"')
    expect(source.match(/id="workflow-evidence-tab-(actual|other|loops)"/g)).toHaveLength(3)
    expect(source).toContain("workflowEvidenceTab === 'actual'")
    expect(source).toContain("workflowEvidenceTab === 'other'")
    expect(source).toContain("workflowEvidenceTab === 'loops'")
    expect(source).toContain('workflowEvidenceTabCounts.actual')
    expect(source).toContain('workflowEvidenceTabCounts.other')
    expect(source).toContain('workflowEvidenceTabCounts.loops')
    expect(source).toContain('aria-controls="workflow-evidence-tabpanel"')
    expect(source).toContain('handleWorkflowEvidenceTabKeydown')
  })

  it('keeps compact cards business-only while existing evidence modal retains technical condition fields', () => {
    const source = view()
    const cardsStart = source.indexOf('data-testid="workflow-evidence-tabpanel"')
    const cardsEnd = source.indexOf('</section>', cardsStart)
    const modalStart = source.indexOf('data-testid="workflow-evidence-detail-modal"')
    const modalEnd = source.indexOf('</NModal>', modalStart)
    const cards = source.slice(cardsStart, cardsEnd)
    const modal = source.slice(modalStart, modalEnd)

    expect(cards).toContain('workflowEvidenceTitle(row)')
    expect(cards).toContain('workflowEvidenceStatusLabel(row)')
    expect(cards).toContain('workflowEvidenceRowDescription(row)')
    expect(cards).toContain("t('workflow.evidence.judgmentDetails')")
    for (const technical of ['row.conditionPath', 'workflowEvidenceConditionOperatorLabel(row)', 'row.expectedValue', 'row.conditionActualValue', 'row.technicalId', 'row.sequence', 'row.iterationPath']) {
      expect(cards).not.toContain(technical)
    }
    for (const technical of ['conditionPath', 'workflowEvidenceConditionOperatorLabel', 'expectedValue', 'conditionActualValue', 'iterationPath']) {
      expect(modal).toContain(technical)
    }
    expect(source).toMatch(/\.workflow-evidence-row-title\s*\{[^}]*-webkit-line-clamp:\s*2/s)
  })

  it('localizes the ten run-explainer controls for every supported locale', () => {
    for (const locale of locales) {
      const source = read(`packages/client/src/i18n/locales/${locale}.ts`)
      for (const key of [
        'historyPage:', 'detailsPage:', 'backToRuns:', 'resultStatus:', 'duration:',
        'budgetLabel:', 'actualExecution:', 'otherJudgments:', 'loopEvents:', 'evaluatedNotExecuted:',
      ]) expect(source, `${locale} missing ${key}`).toContain(key)
    }
  })
})
