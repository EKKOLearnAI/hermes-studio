import { describe, expect, it } from 'vitest'
import { resolveWorkflowRunPageSwipe } from '../../packages/client/src/utils/workflow-run-pager'

describe('workflow run horizontal pager', () => {
  it('changes pages only after the constrained horizontal threshold', () => {
    expect(resolveWorkflowRunPageSwipe({ page: 'history', dx: -48, dy: 0, hasSelectedRun: true, modalOpen: false })).toBe('details')
    expect(resolveWorkflowRunPageSwipe({ page: 'details', dx: 48, dy: 0, hasSelectedRun: true, modalOpen: false })).toBe('history')
    expect(resolveWorkflowRunPageSwipe({ page: 'history', dx: -47, dy: 0, hasSelectedRun: true, modalOpen: false })).toBeNull()
    expect(resolveWorkflowRunPageSwipe({ page: 'details', dx: 47, dy: 0, hasSelectedRun: true, modalOpen: false })).toBeNull()
    expect(resolveWorkflowRunPageSwipe({ page: 'history', dx: -60, dy: 40, hasSelectedRun: true, modalOpen: false })).toBeNull()
    expect(resolveWorkflowRunPageSwipe({ page: 'details', dx: 60, dy: 40, hasSelectedRun: true, modalOpen: false })).toBeNull()
  })

  it('rejects the wrong direction, history without a selected run, and every swipe while a modal is open', () => {
    expect(resolveWorkflowRunPageSwipe({ page: 'history', dx: 80, dy: 0, hasSelectedRun: true, modalOpen: false })).toBeNull()
    expect(resolveWorkflowRunPageSwipe({ page: 'details', dx: -80, dy: 0, hasSelectedRun: true, modalOpen: false })).toBeNull()
    expect(resolveWorkflowRunPageSwipe({ page: 'history', dx: -80, dy: 0, hasSelectedRun: false, modalOpen: false })).toBeNull()
    expect(resolveWorkflowRunPageSwipe({ page: 'history', dx: -80, dy: 0, hasSelectedRun: true, modalOpen: true })).toBeNull()
    expect(resolveWorkflowRunPageSwipe({ page: 'details', dx: 80, dy: 0, hasSelectedRun: true, modalOpen: true })).toBeNull()
  })
})
