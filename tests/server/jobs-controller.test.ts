import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  profileDir: '',
  execFile: vi.fn(),
  spawn: vi.fn(),
  resolvedProfiles: [] as string[],
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: (profile: string) => {
    testState.resolvedProfiles.push(profile)
    return testState.profileDir || '/fake/home/.hermes'
  },
}))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/path', () => ({
  getHermesBin: () => '/fake/bin/hermes',
}))

vi.mock('child_process', () => ({
  execFile: testState.execFile,
  spawn: testState.spawn,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { create, deliveryTargets, pause, remove, resume, run as runJob, update } from '../../packages/server/src/modules/hermes/controllers/jobs'

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
    testState.resolvedProfiles = []
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-jobs-test-'))
    testState.profileDir = tempDir
    testState.execFile.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '', '')
    })
    testState.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        unref: ReturnType<typeof vi.fn>
      }
      child.pid = 12345
      child.unref = vi.fn()
      queueMicrotask(() => child.emit('spawn'))
      return child
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
      request: { body: { name: 'daily', schedule: '0 9 * * *', prompt: 'daily summary' } },
    })
    await create(createCtx)
    expect(testState.execFile).toHaveBeenLastCalledWith(
      '/fake/bin/hermes',
      ['cron', 'create', '--profile', 'research', '--name', 'daily', '0 9 * * *', 'daily summary'],
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

    writeExistingJob(tempDir)
    const runCtx = createMockCtx({
      state: profileState,
      request: { body: {} },
    })
    await runJob(runCtx)

    expect(testState.spawn).toHaveBeenLastCalledWith(
      '/fake/bin/hermes',
      ['cron', 'run', '--profile', 'research', 'abc123abc123'],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ HERMES_HOME: tempDir }),
        stdio: 'ignore',
        windowsHide: true,
      }),
    )
    expect(testState.spawn.mock.results.at(-1)?.value.unref).toHaveBeenCalled()
    expect(runCtx.status).toBe(202)
  })

  it('returns as soon as a background cron run starts without buffering its output', async () => {
    writeExistingJob(tempDir)
    const ctx = createMockCtx()

    await runJob(ctx)

    expect(testState.execFile).not.toHaveBeenCalled()
    expect(testState.spawn).toHaveBeenCalledWith(
      '/fake/bin/hermes',
      ['cron', 'run', '--profile', 'default', 'abc123abc123'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }),
    )
    expect(ctx.status).toBe(202)
    expect(ctx.body.job).toEqual(expect.objectContaining({
      id: 'abc123abc123',
      job_id: 'abc123abc123',
    }))
  })

  it('returns an API error when the background cron process cannot start', async () => {
    writeExistingJob(tempDir)
    testState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        unref: ReturnType<typeof vi.fn>
      }
      child.pid = 0
      child.unref = vi.fn()
      queueMicrotask(() => child.emit('error', new Error('spawn failed')))
      return child
    })
    const ctx = createMockCtx()

    await runJob(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({ error: { message: 'spawn failed' } })
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
      cb(null, '', '')
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

  it.each([
    {
      body: { schedule: '0 9 * * *', prompt: 'daily summary' },
      message: 'Name is required',
    },
    {
      body: { name: 'daily', prompt: 'daily summary' },
      message: 'Schedule is required',
    },
    {
      body: { name: 'daily', schedule: '0 9 * * *' },
      message: 'Prompt, skill, or script is required',
    },
  ])('rejects an invalid create request before invoking Hermes', async ({ body, message }) => {
    const ctx = createMockCtx({ request: { body } })

    await create(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: { message } })
    expect(testState.execFile).not.toHaveBeenCalled()
  })

  it('returns an error when Hermes exits successfully without creating a new job', async () => {
    writeExistingJob(tempDir)
    const ctx = createMockCtx({
      request: {
        body: {
          name: 'daily duplicate',
          schedule: '0 9 * * *',
          prompt: 'daily summary',
        },
      },
    })

    await create(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({
      error: { message: 'Hermes cron command completed without creating a job' },
    })
    expect(ctx.body.job).toBeUndefined()
  })

  it('returns the Hermes validation message when create exits zero without creating a job', async () => {
    testState.execFile.mockImplementationOnce((_bin, _args, _opts, cb) => {
      cb(
        null,
        [
          "Failed to create job: Invalid schedule 'bad schedule'. Use:",
          "  - Cron: '0 9 * * *' (cron expression)",
        ].join('\n'),
        '',
      )
    })
    const ctx = createMockCtx({
      request: {
        body: {
          name: 'invalid schedule',
          schedule: 'bad schedule',
          prompt: 'daily summary',
        },
      },
    })

    await create(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.error.message).toContain("Invalid schedule 'bad schedule'")
    expect(ctx.body.job).toBeUndefined()
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

  it('returns explicit delivery targets from the selected profile channel directory', () => {
    writeFileSync(join(tempDir, 'channel_directory.json'), JSON.stringify({
      updated_at: '2026-07-17T09:15:00+08:00',
      platforms: {
        weixin: [
          { id: 'wx-user@im.wechat', name: '微信私聊', type: 'dm', thread_id: null },
          { id: 'wx-user@im.wechat', name: '重复项', type: 'dm', thread_id: null },
        ],
        feishu: [
          { id: 'oc_example', name: '研发群', type: 'group' },
          { id: '', name: 'invalid' },
        ],
      },
    }))
    const ctx = createMockCtx({ state: { profile: { name: 'research' } } })

    deliveryTargets(ctx)

    expect(testState.resolvedProfiles).toContain('research')
    expect(ctx.body).toEqual({
      updated_at: '2026-07-17T09:15:00+08:00',
      targets: [
        {
          platform: 'feishu',
          id: 'oc_example',
          name: '研发群',
          type: 'group',
          thread_id: null,
          value: 'feishu:oc_example',
        },
        {
          platform: 'weixin',
          id: 'wx-user@im.wechat',
          name: '微信私聊',
          type: 'dm',
          thread_id: null,
          value: 'weixin:wx-user@im.wechat',
        },
      ],
    })
  })

  it('returns an empty delivery target list when the profile directory is unavailable', () => {
    const ctx = createMockCtx()

    deliveryTargets(ctx)

    expect(ctx.body).toEqual({ updated_at: null, targets: [] })
  })

})
