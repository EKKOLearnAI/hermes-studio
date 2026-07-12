import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  profileDir: '',
  execFile: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: () => testState.profileDir || '/fake/home/.hermes',
}))

vi.mock('../../packages/server/src/services/hermes/hermes-path', () => ({
  getHermesBin: () => '/fake/bin/hermes',
}))

vi.mock('child_process', () => ({
  execFile: testState.execFile,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { create, pause, remove, resume, run as runJob, update } from '../../packages/server/src/controllers/hermes/jobs'

function createMockCtx(overrides: Record<string, any> = {}) {
  const ctx: any = {
    req: { method: 'PATCH' },
    request: { body: { name: 'renamed' } },
    params: { id: 'abc123abc123' },
    query: {},
    search: '',
    headers: {},
    status: 200,
    set: vi.fn(),
    body: null,
    ...overrides,
  }
  ctx.get = (name: string) => {
    const match = Object.entries(ctx.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
    const value = match?.[1]
    return Array.isArray(value) ? value[0] : value || ''
  }
  return ctx
}

function writeExistingJob(tempDir: string) {
  const cronDir = join(tempDir, 'cron')
  mkdirSync(cronDir, { recursive: true })
  writeFileSync(join(cronDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      job_id: 'abc123abc123',
      id: 'abc123abc123',
      name: 'daily',
      schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
      schedule_display: '0 9 * * *',
      prompt: 'run daily',
      repeat: { times: 3, completed: 1 },
    }],
  }))
}

describe('Hermes jobs controller', () => {
  let tempDir = ''

  beforeEach(() => {
    vi.clearAllMocks()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-jobs-test-'))
    testState.profileDir = tempDir
    testState.execFile.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' })
    })
  })

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
    testState.profileDir = ''
  })

  it('returns 404 before editing when the local cron job does not exist', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ error: 'Prompt must be ≤ 5000 characters' }),
    })

    const ctx = createMockCtx()
    await update(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: { message: 'Job not found' } })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('does not call the removed gateway proxy path for missing jobs', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const ctx = createMockCtx()
    await update(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: { message: 'Job not found' } })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('clears repeat by passing repeat 0 to Hermes CLI', async () => {
    writeExistingJob(tempDir)

    const ctx = createMockCtx({
      request: { body: { repeat: null } },
    })
    await update(ctx)

    expect(ctx.status).toBe(200)
    expect(testState.execFile).toHaveBeenCalledWith(
      '/fake/bin/hermes',
      ['cron', 'edit', '--profile', 'default', 'abc123abc123', '--repeat', '0'],
      expect.objectContaining({
        env: expect.objectContaining({ HERMES_HOME: tempDir }),
        windowsHide: true,
      }),
      expect.any(Function),
    )
  })

  it('passes the selected profile to every Hermes cron command', async () => {
    const profileState = { profile: { name: 'research' } }

    const createCtx = createMockCtx({
      state: profileState,
      request: { body: { schedule: '0 9 * * *', prompt: 'daily summary' } },
    })
    await create(createCtx)
    expect(testState.execFile).toHaveBeenLastCalledWith(
      '/fake/bin/hermes',
      ['cron', 'create', '--profile', 'research', '0 9 * * *', 'daily summary'],
      expect.any(Object),
      expect.any(Function),
    )

    const commands = [
      {
        handler: update,
        body: { name: 'renamed' },
        args: ['cron', 'edit', '--profile', 'research', 'abc123abc123', '--name', 'renamed'],
      },
      {
        handler: remove,
        body: {},
        args: ['cron', 'remove', '--profile', 'research', 'abc123abc123'],
      },
      {
        handler: pause,
        body: {},
        args: ['cron', 'pause', '--profile', 'research', 'abc123abc123'],
      },
      {
        handler: resume,
        body: {},
        args: ['cron', 'resume', '--profile', 'research', 'abc123abc123'],
      },
      {
        handler: runJob,
        body: {},
        args: ['cron', 'run', '--profile', 'research', 'abc123abc123'],
      },
    ]

    for (const command of commands) {
      writeExistingJob(tempDir)
      const ctx = createMockCtx({
        state: profileState,
        request: { body: command.body },
      })

      await command.handler(ctx)

      expect(testState.execFile).toHaveBeenLastCalledWith(
        '/fake/bin/hermes',
        command.args,
        expect.any(Object),
        expect.any(Function),
      )
    }
  })

  it('persists selected provider and model after creating a job without unsupported CLI flags', async () => {
    testState.execFile.mockImplementation((_bin, args, _opts, cb) => {
      expect(args).not.toContain('--model')
      expect(args).not.toContain('--provider')
      const cronDir = join(tempDir, 'cron')
      mkdirSync(cronDir, { recursive: true })
      writeFileSync(join(cronDir, 'jobs.json'), JSON.stringify({
        jobs: [{
          id: 'created123456',
          job_id: 'created123456',
          name: 'daily',
          schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
          schedule_display: '0 9 * * *',
          prompt: 'daily summary',
          repeat: { times: null, completed: 0 },
        }],
      }))
      cb(null, { stdout: '', stderr: '' })
    })

    const ctx = createMockCtx({
      request: { body: { name: 'daily', schedule: '0 9 * * *', prompt: 'daily summary', provider: 'openai', model: 'gpt-4.1-mini' } },
    })
    await create(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.job.provider).toBe('openai')
    expect(ctx.body.job.model).toBe('gpt-4.1-mini')
    const persisted = JSON.parse(readFileSync(join(tempDir, 'cron', 'jobs.json'), 'utf-8'))
    expect(persisted.jobs[0].provider).toBe('openai')
    expect(persisted.jobs[0].model).toBe('gpt-4.1-mini')
  })

  it('persists selected provider and model after editing a job', async () => {
    writeExistingJob(tempDir)

    const ctx = createMockCtx({
      request: { body: { provider: 'anthropic', model: 'claude-sonnet-4' } },
    })
    await update(ctx)

    expect(ctx.status).toBe(200)
    expect(testState.execFile).not.toHaveBeenCalled()
    expect(ctx.body.job.provider).toBe('anthropic')
    expect(ctx.body.job.model).toBe('claude-sonnet-4')
    const persisted = JSON.parse(readFileSync(join(tempDir, 'cron', 'jobs.json'), 'utf-8'))
    expect(persisted.jobs[0].provider).toBe('anthropic')
    expect(persisted.jobs[0].model).toBe('claude-sonnet-4')
  })

})
