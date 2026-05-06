import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const profileDirState = vi.hoisted(() => ({ value: '' }))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: () => profileDirState.value,
}))

function createCtx(overrides: Record<string, any> = {}) {
  return {
    query: {},
    params: {},
    status: 200,
    body: null,
    ...overrides,
  } as any
}

function writeJobs(jobs: unknown[]) {
  const cronDir = join(profileDirState.value, 'cron')
  mkdirSync(cronDir, { recursive: true })
  writeFileSync(join(cronDir, 'jobs.json'), JSON.stringify({ jobs }))
}

describe('Hermes cron history controller', () => {
  beforeEach(() => {
    vi.resetModules()
    profileDirState.value = mkdtempSync(join(tmpdir(), 'hwui-cron-history-'))
  })

  afterEach(() => {
    if (profileDirState.value) rmSync(profileDirState.value, { recursive: true, force: true })
  })

  it('surfaces scheduler metadata when a job ran without an output artifact', async () => {
    writeJobs([
      {
        id: 'silent-job',
        name: 'Silent watchdog',
        last_run_at: '2026-05-05T13:01:32.580693+00:00',
        last_status: 'ok',
        run_count: 47,
        script: 'monitor_github_issues.py',
        no_agent: true,
      },
    ])

    const { listRuns, readRun } = await import('../../packages/server/src/controllers/hermes/cron-history')

    const listCtx = createCtx({ query: { jobId: 'silent-job' } })
    await listRuns(listCtx)

    expect(listCtx.body).toEqual({
      runs: [
        expect.objectContaining({
          jobId: 'silent-job',
          fileName: '__scheduler_metadata__.md',
          runTime: '2026-05-05 13:01:32',
          size: 0,
          hasOutput: false,
          synthetic: true,
          runCount: 47,
          status: 'ok',
        }),
      ],
    })

    const readCtx = createCtx({ params: { jobId: 'silent-job', fileName: '__scheduler_metadata__.md' } })
    await readRun(readCtx)

    expect(readCtx.body).toMatchObject({
      jobId: 'silent-job',
      fileName: '__scheduler_metadata__.md',
      runTime: '2026-05-05 13:01:32',
    })
    expect(readCtx.body.content).toContain('Hermes recorded this cron job as having run')
    expect(readCtx.body.content).toContain('Recorded runs:')
    expect(readCtx.body.content).toContain('47')
    expect(readCtx.body.content).toContain('script-only/no-agent')
  })

  it('keeps real output files as history entries and parses ISO-style Hermes filenames', async () => {
    writeJobs([
      {
        id: 'output-job',
        name: 'Output job',
        last_run_at: '2026-05-05T05:00:00.429347+00:00',
        run_count: 1,
      },
    ])
    const outputDir = join(profileDirState.value, 'cron', 'output', 'output-job')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, '2026-05-05T05-00-00.429347+00-00.md'), '# ok\n')

    const { listRuns } = await import('../../packages/server/src/controllers/hermes/cron-history')

    const ctx = createCtx({ query: { jobId: 'output-job' } })
    await listRuns(ctx)

    expect(ctx.body).toEqual({
      runs: [
        expect.objectContaining({
          jobId: 'output-job',
          fileName: '2026-05-05T05-00-00.429347+00-00.md',
          runTime: '2026-05-05 05:00:00',
          hasOutput: true,
        }),
      ],
    })
  })

  it('adds scheduler metadata when the latest recorded run is newer than the newest output file', async () => {
    writeJobs([
      {
        id: 'mixed-job',
        name: 'Mixed job',
        last_run_at: '2026-05-05T06:00:00+00:00',
        run_count: 2,
      },
    ])
    const outputDir = join(profileDirState.value, 'cron', 'output', 'mixed-job')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, '2026-05-05T05-00-00.000000+00-00.md'), '# older output\n')

    const { listRuns } = await import('../../packages/server/src/controllers/hermes/cron-history')

    const ctx = createCtx({ query: { jobId: 'mixed-job' } })
    await listRuns(ctx)

    expect(ctx.body.runs).toHaveLength(2)
    expect(ctx.body.runs[0]).toMatchObject({
      jobId: 'mixed-job',
      fileName: '__scheduler_metadata__.md',
      runTime: '2026-05-05 06:00:00',
      hasOutput: false,
    })
    expect(ctx.body.runs[1]).toMatchObject({
      fileName: '2026-05-05T05-00-00.000000+00-00.md',
      hasOutput: true,
    })
  })

  it('skips malformed scheduler metadata instead of failing the request', async () => {
    writeJobs([
      null,
      {
        id: 'bad-job',
        name: 'Bad job',
        last_run_at: 123,
        last_status: { nested: true },
      },
    ])

    const { listRuns } = await import('../../packages/server/src/controllers/hermes/cron-history')

    const ctx = createCtx({ query: { jobId: 'bad-job' } })
    await listRuns(ctx)

    expect(ctx.body).toEqual({ runs: [] })
  })

  it('renders metadata with many backticks without throwing', async () => {
    const name = Array.from({ length: 2000 }, () => '`x').join('')
    writeJobs([
      {
        id: 'ticks-job',
        name,
        last_run_at: '2026-05-05T07:00:00+00:00',
      },
    ])

    const { readRun } = await import('../../packages/server/src/controllers/hermes/cron-history')

    const ctx = createCtx({ params: { jobId: 'ticks-job', fileName: '__scheduler_metadata__.md' } })
    await readRun(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.content).toContain('Scheduler run recorded')
    expect(ctx.body.content).toContain('`x')
  })
})
