import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOutcome } from '../../packages/server/src/services/hermes/cron/omp-runner'

const testState = vi.hoisted(() => ({
  profileDir: '',
  runOmpPrompt: vi.fn(),
  runScript: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: () => testState.profileDir || '/fake/home/.hermes',
  listProfileNamesFromDisk: () => ['default'],
}))

vi.mock('../../packages/server/src/services/hermes/cron/omp-runner', () => ({
  runOmpPrompt: testState.runOmpPrompt,
  runScript: testState.runScript,
}))

// Avoid real fs mkdir inside the fire path so fake-timer advancement is deterministic.
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: (_profile: string, workspace?: string | null) => Promise.resolve(workspace || '/tmp/ws'),
}))

import { createJobRecord, findJobRecord, setJobPaused } from '../../packages/server/src/services/hermes/cron/job-store'
import { CronScheduler, getCronScheduler, isCronSchedulerEnabled } from '../../packages/server/src/services/hermes/cron/scheduler'

function success(output: string): RunOutcome {
  return { status: 'success', output, exitCode: 0 }
}

describe('CronScheduler', () => {
  let tempDir = ''

  beforeEach(() => {
    vi.clearAllMocks()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-sched-test-'))
    testState.profileDir = tempDir
    testState.runOmpPrompt.mockResolvedValue(success('scheduled output'))
  })

  afterEach(() => {
    vi.useRealTimers()
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
    testState.profileDir = ''
  })

  it('exposes a singleton and an env gate', () => {
    expect(getCronScheduler()).toBe(getCronScheduler())
    expect(isCronSchedulerEnabled()).toBe(true)
  })

  it('reload before start is a no-op (does not throw)', () => {
    const scheduler = new CronScheduler()
    expect(() => scheduler.reload('default', 'nope')).not.toThrow()
  })

  it('fires a due job through the runner and records the run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 26, 10, 30, 15))

    const job = await createJobRecord('default', { schedule: '* * * * *', prompt: 'tick' })

    const scheduler = new CronScheduler()
    scheduler.start()

    // Advance past the next minute boundary (10:31:00) so the timer fires.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(testState.runOmpPrompt).toHaveBeenCalled()
    const refreshed = findJobRecord('default', job.job_id)
    expect(refreshed?.last_status).toBe('success')
    expect(refreshed?.run_count).toBeGreaterThanOrEqual(1)

    scheduler.stop()
  })

  it('does not fire a paused job', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 26, 10, 30, 15))

    const job = await createJobRecord('default', { schedule: '* * * * *', prompt: 'tick' })
    await setJobPaused('default', job.job_id, true)

    const scheduler = new CronScheduler()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(testState.runOmpPrompt).not.toHaveBeenCalled()
    scheduler.stop()
  })
})
