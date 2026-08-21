// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('scheduled task explicit Cron UI', () => {
  it('keeps Jobs on explicit Cron input without quick preset controls', () => {
    const source = readFileSync('packages/client/src/components/hermes/jobs/JobFormModal.vue', 'utf8')

    expect(source).not.toContain('schedulePresets')
    expect(source).not.toContain("t('jobs.quickPresets')")
    expect(source).not.toContain("t('jobs.selectPreset')")
  })

  it('keeps Workflow Schedule on explicit Cron input and starts new schedules blank', () => {
    const source = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

    expect(source).toContain("const workflowScheduleCron = ref('')")
    expect(source).toContain("workflowScheduleCron.value = schedule?.schedule || ''")
    expect(source).not.toContain('workflowSchedulePresetOptions')
    expect(source).not.toContain('workflow-schedule-presets')
  })
})
