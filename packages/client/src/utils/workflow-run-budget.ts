export type WorkflowRunBudgetChoice = 'unlimited' | '30' | '60' | '90' | 'custom'

export const WORKFLOW_RUN_BUDGET_PRESETS: Array<{ value: WorkflowRunBudgetChoice; minutes: number | null }> = [
  { value: 'unlimited', minutes: null },
  { value: '30', minutes: 30 },
  { value: '60', minutes: 60 },
  { value: '90', minutes: 90 },
  { value: 'custom', minutes: null },
]

export interface WorkflowRunBudgetRecord {
  requested_timeout_ms?: number | null
  deadline_at?: number | null
  started_at: number | null
  finished_at: number | null
}

export interface WorkflowRunBudgetSnapshot {
  totalMs: number | null
  elapsedMs: number
  remainingMs: number | null
  deadlineAt: number | null
}

export function isWorkflowRunBudgetValid(
  choice: WorkflowRunBudgetChoice,
  customMinutes: number | null,
): boolean {
  if (choice !== 'custom') return true
  return typeof customMinutes === 'number'
    && Number.isFinite(customMinutes)
    && customMinutes >= 0.1
    && customMinutes <= 1440
}

export function resolveWorkflowRunTimeoutMs(
  choice: WorkflowRunBudgetChoice,
  customMinutes: number | null,
): number | undefined {
  if (choice === 'unlimited') return undefined
  const preset = WORKFLOW_RUN_BUDGET_PRESETS.find(option => option.value === choice)?.minutes
  const minutes = choice === 'custom' ? customMinutes : preset
  if (!isWorkflowRunBudgetValid(choice, minutes ?? null)) {
    throw new Error('custom workflow run budget must be from 0.1 to 1440 minutes')
  }
  return Math.round((minutes as number) * 60_000)
}

export function workflowRunBudgetRequest(timeoutMs: number | undefined): { timeout_ms?: number } {
  return timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }
}

export function workflowRunBudgetSnapshot(
  run: WorkflowRunBudgetRecord,
  now = Date.now(),
): WorkflowRunBudgetSnapshot | null {
  if (run.started_at == null) return null
  const observedAt = run.finished_at ?? now
  const elapsedMs = Math.max(0, observedAt - run.started_at)
  if (run.requested_timeout_ms == null || run.deadline_at == null) {
    return { totalMs: null, elapsedMs, remainingMs: null, deadlineAt: null }
  }
  return {
    totalMs: Math.max(0, run.requested_timeout_ms),
    elapsedMs,
    remainingMs: Math.max(0, run.deadline_at - observedAt),
    deadlineAt: run.deadline_at,
  }
}
