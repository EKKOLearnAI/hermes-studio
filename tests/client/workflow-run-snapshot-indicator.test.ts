import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('Workflow run snapshot indicator', () => {
  it('labels the selected run canvas as an immutable launch-time snapshot', () => {
    const view = read('packages/client/src/views/hermes/WorkflowView.vue')
    const zh = read('packages/client/src/i18n/locales/zh.ts')
    const en = read('packages/client/src/i18n/locales/en.ts')

    expect(view).toContain('v-if="selectedWorkflowRun" class="workflow-run-snapshot-indicator"')
    expect(view).toContain("t('workflow.runs.snapshotIndicator')")
    expect(zh).toContain("snapshotIndicator: '本次运行启动时的冻结快照'")
    expect(en).toContain("snapshotIndicator: 'Immutable snapshot from this run’s launch'")
  })
})
