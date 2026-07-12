import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

const localeFiles = [
  'de.ts', 'en.ts', 'es.ts', 'fr.ts', 'ja.ts',
  'ko.ts', 'pt.ts', 'ru.ts', 'zh-TW.ts', 'zh.ts',
]

describe('workflow runtime status contract', () => {
  it('renders skipped nodes as a first-class status in every locale', () => {
    expect(read('packages/client/src/api/hermes/workflow-socket.ts')).toMatch(/WorkflowRuntimeState[^\n]+skipped/)
    expect(read('packages/client/src/components/hermes/workflow/types.ts')).toMatch(/WorkflowNodeStatus[^\n]+skipped/)
    expect(read('packages/client/src/views/hermes/WorkflowView.vue')).toContain("case 'skipped':")
    expect(read('packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue')).toContain('.status-skipped .node-status-dot')
    for (const locale of localeFiles) {
      expect(read(`packages/client/src/i18n/locales/${locale}`), locale).toMatch(/skipped:\s*['"]/)
    }
  })

  it('types persisted edge evaluations on workflow run history records', () => {
    const source = read('packages/client/src/api/hermes/workflows.ts')
    expect(source).toMatch(/edge_evaluations\?: WorkflowRunEdgeEvaluationRecord\[\]/)
    expect(source).toContain("status: 'taken' | 'not_taken' | 'error'")
  })

  it('renders edge evaluation evidence for the selected workflow run in every locale', () => {
    const view = read('packages/client/src/views/hermes/WorkflowView.vue')
    expect(view).toContain('class="workflow-run-edge-evidence"')
    expect(view).toContain("t('workflow.runs.edgeEvidence')")
    expect(view).toContain('selectedWorkflowRunId === run.id')
    for (const locale of localeFiles) {
      expect(read(`packages/client/src/i18n/locales/${locale}`), locale).toMatch(/edgeEvidence:\s*['"]/)
    }
  })
})
