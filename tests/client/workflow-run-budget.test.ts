import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_RUN_BUDGET_PRESETS,
  resolveWorkflowRunTimeoutMs,
  workflowRunBudgetRequest,
  workflowRunBudgetSnapshot,
  isWorkflowRunBudgetValid,
} from '../../packages/client/src/utils/workflow-run-budget'

describe('workflow run time budget', () => {
  it('keeps no deadline as the default and resolves preset or custom minutes', () => {
    expect(WORKFLOW_RUN_BUDGET_PRESETS.map(option => option.value)).toEqual(['unlimited', '30', '60', '90', 'custom'])
    expect(resolveWorkflowRunTimeoutMs('unlimited', 45)).toBeUndefined()
    expect(resolveWorkflowRunTimeoutMs('30', null)).toBe(1_800_000)
    expect(resolveWorkflowRunTimeoutMs('60', null)).toBe(3_600_000)
    expect(resolveWorkflowRunTimeoutMs('90', null)).toBe(5_400_000)
    expect(resolveWorkflowRunTimeoutMs('custom', 12.5)).toBe(750_000)
    expect(() => resolveWorkflowRunTimeoutMs('custom', 0)).toThrow('custom workflow run budget must be from 0.1 to 1440 minutes')
    expect(() => resolveWorkflowRunTimeoutMs('custom', 1440.1)).toThrow('custom workflow run budget must be from 0.1 to 1440 minutes')
    expect(isWorkflowRunBudgetValid('custom', null)).toBe(false)
    expect(isWorkflowRunBudgetValid('custom', 0)).toBe(false)
    expect(isWorkflowRunBudgetValid('custom', 45)).toBe(true)
    expect(isWorkflowRunBudgetValid('unlimited', null)).toBe(true)
  })

  it('builds API input only when a deadline was selected', () => {
    expect(workflowRunBudgetRequest(undefined)).toEqual({})
    expect(workflowRunBudgetRequest(3_600_000)).toEqual({ timeout_ms: 3_600_000 })
  })

  it('wires the same visible budget selection into Run, Rerun, and history details', () => {
    const view = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')
    expect(view).toContain('workflow-run-budget-modal')
    expect(view).toContain('resolveWorkflowRunTimeoutMs')
    expect(view).toContain('runWorkflowNow(workflowId, workflowRunBudgetRequest(timeoutMs))')
    expect(view).toContain('...workflowRunBudgetRequest(timeoutMs)')
    expect(view).toContain('workflowRunBudgetSnapshot(run, workflowBudgetNow.value)')
    expect(view).toContain('remaining_timeout_ms_at_start')
  })

  it('derives total, elapsed, and remaining time from persisted Run evidence', () => {
    expect(workflowRunBudgetSnapshot({
      requested_timeout_ms: 3_600_000,
      deadline_at: 4_600_000,
      started_at: 1_000_000,
      finished_at: null,
    }, 1_900_000)).toEqual({
      totalMs: 3_600_000,
      elapsedMs: 900_000,
      remainingMs: 2_700_000,
      deadlineAt: 4_600_000,
    })

    expect(workflowRunBudgetSnapshot({
      requested_timeout_ms: 3_600_000,
      deadline_at: 4_600_000,
      started_at: 1_000_000,
      finished_at: 2_000_000,
    }, 9_000_000)?.remainingMs).toBe(2_600_000)

    expect(workflowRunBudgetSnapshot({
      requested_timeout_ms: null,
      deadline_at: null,
      started_at: 1_000_000,
      finished_at: null,
    }, 1_900_000)).toEqual({
      totalMs: null,
      elapsedMs: 900_000,
      remainingMs: null,
      deadlineAt: null,
    })

    expect(workflowRunBudgetSnapshot({
      requested_timeout_ms: 60_000,
      deadline_at: 1_060_000,
      started_at: 1_000_000,
      finished_at: 1_090_000,
    }, 9_000_000)).toEqual({
      totalMs: 60_000,
      elapsedMs: 90_000,
      remainingMs: 0,
      deadlineAt: 1_060_000,
    })
  })

  it('keeps the budget modal open until an accepted request and exposes accessible validation', () => {
    const view = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')
    const confirm = view.slice(view.indexOf('async function confirmWorkflowRunBudget()'), view.indexOf('async function executeWorkflowWithBudget'))
    expect(confirm.indexOf('const accepted = action.kind')).toBeLessThan(confirm.indexOf('closeWorkflowRunBudgetModal(true)'))
    expect(confirm).toContain('if (accepted) closeWorkflowRunBudgetModal(true)')
    expect(view).toContain('if (workflowRunBudgetSubmitting.value && !force) return')
    expect(view).toContain(':mask-closable="!workflowRunBudgetSubmitting"')
    expect(view).toContain(':close-on-esc="!workflowRunBudgetSubmitting"')
    expect(view).toContain(':disabled="!workflowRunBudgetValid || workflowRunBudgetSubmitting"')
    expect(view).toContain(':aria-invalid="!workflowRunBudgetValid"')
    expect(view).toContain('aria-describedby="workflow-run-budget-error"')
  })
})
