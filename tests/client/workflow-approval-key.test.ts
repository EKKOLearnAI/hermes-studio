import { describe, expect, it } from 'vitest'
import { workflowApprovalKey } from '@/utils/workflow-approval-key'

describe('workflowApprovalKey', () => {
  it('builds the authoritative workflow pending locator including execution identity', () => {
    expect(workflowApprovalKey('workflow-a', 'run-a', 'node-a', 'exec-a'))
      .toBe('workflow-approval:workflow-a:run-a:node-a:exec-a')
    expect(workflowApprovalKey('workflow-a', 'run-a', 'node-a'))
      .toBe('workflow-approval:workflow-a:run-a:node-a:')
  })
})
