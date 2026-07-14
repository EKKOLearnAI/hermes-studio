import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { workflowImportConfirmationText } from '../../packages/client/src/utils/workflow-import'

describe('workflow import confirmation', () => {
  it('shows preview identity and size before the explicit confirm request', () => {
    expect(workflowImportConfirmationText({ name: 'Review flow', nodes: 4, edges: 5 })).toBe('Review flow · 4 nodes · 5 edges')
  })

  it('subscribes the imported workflow to realtime status updates', () => {
    const view = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')
    const confirmImport = view.slice(
      view.indexOf('async function confirmPendingWorkflowImport()'),
      view.indexOf('function openCreateWorkflowDrawer()'),
    )
    expect(confirmImport).toContain('subscribeWorkflowStatuses(imported.id)')
    expect(confirmImport).toContain('applyWorkflowRuntimeStatuses')
  })
})
