import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hermes-workflow-schedule-'))
process.env.HERMES_WEB_UI_TEST_DB_DIR = join(root, 'db')
process.env.HERMES_WEB_UI_HOME = join(root, 'home')
process.env.HERMES_WEBUI_STATE_DIR = join(root, 'home')

afterAll(async () => {
  const { closeDb } = await import('../../packages/server/src/db/index')
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('workflow schedules', () => {
  it('persists a unique trigger identity before dispatching and never dispatches it twice', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowSchedule, getWorkflowSchedule, listWorkflowScheduleEvents } = await import('../../packages/server/src/db/hermes/workflow-schedule-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/services/workflow-schedule-service')
    initAllStores()
    const workflow = createWorkflow({ id: 'schedule-workflow', name: 'Scheduled', nodes: [], edges: [] })
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', schedule: '*/5 * * * *', timezone: 'UTC', enabled: true, next_run_at: Date.UTC(2026, 7, 8, 12, 0, 0) })
    const scheduledAt = Date.UTC(2026, 7, 8, 12, 0, 0)
    const runNow = vi.fn().mockResolvedValue({ run: { id: 'run-1' } })
    const service = new WorkflowScheduleService({ getWorkflow: () => workflow, runNow })

    await service.tick(scheduledAt)
    await service.tick(scheduledAt)

    expect(runNow).toHaveBeenCalledTimes(1)
    expect(runNow).toHaveBeenCalledWith(workflow.id, expect.objectContaining({
      triggerSource: 'scheduled', scheduledAt,
    }))
    expect(getWorkflowSchedule(schedule.id)?.last_run_id).toBe('run-1')
    expect(listWorkflowScheduleEvents(schedule.id).map(event => event.kind)).toEqual(['triggered'])
  })

  it('skips missed intervals and active workflows with durable audit evidence', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowSchedule, getWorkflowSchedule, listWorkflowScheduleEvents } = await import('../../packages/server/src/db/hermes/workflow-schedule-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/services/workflow-schedule-service')
    initAllStores()
    const workflow = createWorkflow({ id: 'skip-workflow', name: 'Skip', nodes: [], edges: [] })
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', schedule: '* * * * *', timezone: 'UTC', enabled: true, next_run_at: Date.UTC(2026, 7, 8, 11, 0, 0) })
    const service = new WorkflowScheduleService({ getWorkflow: () => workflow, hasActiveRun: () => true, runNow: vi.fn() })

    await service.tick(Date.UTC(2026, 7, 8, 12, 5, 0))

    expect(getWorkflowSchedule(schedule.id)?.last_error).toContain('skipped')
    expect(listWorkflowScheduleEvents(schedule.id).map(event => event.kind)).toContain('skipped')
  })
})
