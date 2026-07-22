export type WorkflowRunPagerPage = 'history' | 'details'

export interface WorkflowRunPageSwipe {
  page: WorkflowRunPagerPage
  dx: number
  dy: number
  hasSelectedRun: boolean
  modalOpen: boolean
}

export function resolveWorkflowRunPageSwipe({
  page,
  dx,
  dy,
  hasSelectedRun,
  modalOpen,
}: WorkflowRunPageSwipe): WorkflowRunPagerPage | null {
  if (modalOpen || Math.abs(dx) < 48 || Math.abs(dx) <= 1.5 * Math.abs(dy)) return null
  if (page === 'history' && dx < 0 && hasSelectedRun) return 'details'
  if (page === 'details' && dx > 0) return 'history'
  return null
}
