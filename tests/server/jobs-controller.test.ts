import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'koa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRecord } from '../../packages/server/src/services/hermes/cron/job-store'

const testState = vi.hoisted(() => ({
  profileDir: '',
  runJobNow: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: () => testState.profileDir || '/fake/home/.hermes',
  listProfileNamesFromDisk: () => ['default'],
}))

vi.mock('../../packages/server/src/services/hermes/cron/run-job', () => ({
  runJobNow: testState.runJobNow,
}))

import { create, get, pause, remove, resume, run as runJob, update } from '../../packages/server/src/controllers/hermes/jobs'

interface MockCtx {
  request: { body: unknown }
  params: Record<string, string>
  query: Record<string, unknown>
  state: { profile?: { name?: string } }
  status: number
  body: unknown
}

function createMockCtx(overrides: Partial<MockCtx> = {}): MockCtx {
  return {
    request: { body: {} },
    params: {},
    query: {},
    state: {},
    status: 200,
    body: null,
    ...overrides,
  }
}

// The handlers only touch the Context surface the mock provides; the cast keeps
// the test ergonomic without pulling in the full Koa Context shape.
function asContext(ctx: MockCtx): Context {
  return ctx as unknown as Context
}

function getJob(body: unknown): JobRecord {
  if (body && typeof body === 'object' && 'job' in body) {
    const job = body.job
    if (job && typeof job === 'object') return job as JobRecord
  }
  throw new Error(`expected { job } in body, got ${JSON.stringify(body)}`)
}

function jobsOnDisk(dir: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, 'cron', 'jobs.json'), 'utf-8'))
  if (parsed && typeof parsed === 'object' && 'jobs' in parsed) {
    const jobs = parsed.jobs
    if (Array.isArray(jobs)) return jobs
  }
  return []
}

async function createJob(body: Record<string, unknown>): Promise<JobRecord> {
  const ctx = createMockCtx({ request: { body } })
  await create(asContext(ctx))
  expect(ctx.status).toBe(200)
  return getJob(ctx.body)
}

describe('Hermes jobs controller (web-ui owned store)', () => {
  let tempDir = ''

  beforeEach(() => {
    vi.clearAllMocks()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-jobs-test-'))
    testState.profileDir = tempDir
  })

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
    testState.profileDir = ''
  })

  it('persists a created job to jobs.json without invoking any CLI', async () => {
    const job = await createJob({ name: 'daily', schedule: '0 9 * * *', prompt: 'do it', deliver: 'local', skills: ['x'], repeat: 3 })

    expect(job.job_id).toBeTruthy()
    expect(job.name).toBe('daily')
    expect(job.schedule_display).toBe('0 9 * * *')
    expect(job.deliver).toBe('local')
    expect(job.skills).toEqual(['x'])
    expect(job.repeat).toEqual({ times: 3, completed: 0 })
    expect(job.next_run_at).toBeTruthy()

    const onDisk = jobsOnDisk(tempDir)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].prompt).toBe('do it')
    expect(onDisk[0].job_id).toBe(job.job_id)
  })

  it('rejects an empty schedule with 400', async () => {
    const ctx = createMockCtx({ request: { body: { prompt: 'no schedule' } } })
    await create(asContext(ctx))
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: { message: 'Schedule is required' } })
  })

  it('rejects an invalid cron expression with 400', async () => {
    const ctx = createMockCtx({ request: { body: { schedule: '0 9 * *', prompt: 'bad' } } })
    await create(asContext(ctx))
    expect(ctx.status).toBe(400)
  })

  it('returns 404 when editing a job that does not exist', async () => {
    const ctx = createMockCtx({ params: { id: 'missing' }, request: { body: { name: 'renamed' } } })
    await update(asContext(ctx))
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: { message: 'Job not found' } })
  })

  it('updates fields and clears repeat when repeat is null', async () => {
    const created = await createJob({ name: 'daily', schedule: '0 9 * * *', prompt: 'p', repeat: 5 })

    const ctx = createMockCtx({ params: { id: created.job_id }, request: { body: { name: 'renamed', repeat: null } } })
    await update(asContext(ctx))
    const job = getJob(ctx.body)

    expect(job.name).toBe('renamed')
    expect(job.repeat.times).toBeNull()
    expect(jobsOnDisk(tempDir)[0].name).toBe('renamed')
  })

  it('pauses and resumes a job, toggling state', async () => {
    const created = await createJob({ schedule: '0 9 * * *', prompt: 'p' })

    const pauseCtx = createMockCtx({ params: { id: created.job_id } })
    await pause(asContext(pauseCtx))
    expect(getJob(pauseCtx.body).state).toBe('paused')

    const resumeCtx = createMockCtx({ params: { id: created.job_id } })
    await resume(asContext(resumeCtx))
    expect(getJob(resumeCtx.body).state).toBe('scheduled')
  })

  it('removes a job', async () => {
    const created = await createJob({ schedule: '0 9 * * *', prompt: 'p' })

    const ctx = createMockCtx({ params: { id: created.job_id } })
    await remove(asContext(ctx))
    expect(ctx.body).toEqual({ ok: true })
    expect(jobsOnDisk(tempDir)).toHaveLength(0)

    const getCtx = createMockCtx({ params: { id: created.job_id } })
    await get(asContext(getCtx))
    expect(getCtx.status).toBe(404)
  })

  it('delegates manual run to the runner and returns the updated job', async () => {
    const created = await createJob({ schedule: '0 9 * * *', prompt: 'p' })
    testState.runJobNow.mockResolvedValue({ ...created, last_status: 'success' })

    const ctx = createMockCtx({ params: { id: created.job_id } })
    await runJob(asContext(ctx))

    expect(testState.runJobNow).toHaveBeenCalledTimes(1)
    expect(getJob(ctx.body).last_status).toBe('success')
  })
})
