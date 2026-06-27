import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
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

import { createJobRecord } from '../../packages/server/src/services/hermes/cron/job-store'
import { runJobNow } from '../../packages/server/src/services/hermes/cron/run-job'

function outputFiles(dir: string, jobId: string): string[] {
  try {
    return readdirSync(join(dir, 'cron', 'output', jobId)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
}

function ompOutcome(outcome: RunOutcome): RunOutcome {
  return outcome
}

describe('runJobNow (local execution)', () => {
  let tempDir = ''

  beforeEach(() => {
    vi.clearAllMocks()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-runjob-test-'))
    testState.profileDir = tempDir
  })

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
    testState.profileDir = ''
  })

  it('writes a markdown artifact and records success', async () => {
    testState.runOmpPrompt.mockResolvedValue(ompOutcome({ status: 'success', output: '# Result\nhello world', exitCode: 0 }))
    const job = await createJobRecord('default', { schedule: '* * * * *', prompt: 'hi' })

    const updated = await runJobNow('default', job, { countsTowardRepeat: true })

    expect(testState.runOmpPrompt).toHaveBeenCalledTimes(1)
    expect(updated?.last_status).toBe('success')
    expect(updated?.run_count).toBe(1)
    expect(updated?.repeat.completed).toBe(1)

    const files = outputFiles(tempDir, job.job_id)
    expect(files).toHaveLength(1)
    expect(readFileSync(join(tempDir, 'cron', 'output', job.job_id, files[0]), 'utf-8')).toContain('hello world')
  })

  it('disables the job once the repeat budget is exhausted', async () => {
    testState.runOmpPrompt.mockResolvedValue(ompOutcome({ status: 'success', output: 'done', exitCode: 0 }))
    const job = await createJobRecord('default', { schedule: '* * * * *', prompt: 'once', repeat: 1 })

    const updated = await runJobNow('default', job, { countsTowardRepeat: true })

    expect(updated?.repeat).toEqual({ times: 1, completed: 1 })
    expect(updated?.enabled).toBe(false)
    expect(updated?.state).toBe('completed')
    expect(updated?.next_run_at).toBeNull()
  })

  it('records an error and writes no artifact when omp fails', async () => {
    testState.runOmpPrompt.mockResolvedValue(ompOutcome({ status: 'error', output: '', error: 'boom', exitCode: 1 }))
    const job = await createJobRecord('default', { schedule: '* * * * *', prompt: 'fail' })

    const updated = await runJobNow('default', job, { countsTowardRepeat: true })

    expect(updated?.last_status).toBe('error')
    expect(updated?.last_error).toBe('boom')
    expect(outputFiles(tempDir, job.job_id)).toHaveLength(0)
  })

  it('does not consume repeat budget for manual runs', async () => {
    testState.runOmpPrompt.mockResolvedValue(ompOutcome({ status: 'success', output: 'manual', exitCode: 0 }))
    const job = await createJobRecord('default', { schedule: '* * * * *', prompt: 'manual', repeat: 2 })

    const updated = await runJobNow('default', job, { countsTowardRepeat: false })

    expect(updated?.run_count).toBe(1)
    expect(updated?.repeat.completed).toBe(0)
    expect(updated?.enabled).toBe(true)
  })

  it('runs script/no-agent jobs via the script runner', async () => {
    testState.runScript.mockResolvedValue(ompOutcome({ status: 'success', output: 'script out', exitCode: 0 }))
    const job = await createJobRecord('default', { schedule: '* * * * *', prompt: '', script: 'echo hi', no_agent: true })

    const updated = await runJobNow('default', job, { countsTowardRepeat: true })

    expect(testState.runScript).toHaveBeenCalledTimes(1)
    expect(testState.runOmpPrompt).not.toHaveBeenCalled()
    expect(updated?.last_status).toBe('success')
  })
})
