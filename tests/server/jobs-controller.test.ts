import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

import { update } from '../../packages/server/src/controllers/hermes/jobs'

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

    const ctx = createMockCtx({
      request: { body: { repeat: null } },
    })
    await update(ctx)

    expect(ctx.status).toBe(200)
    expect(testState.execFile).toHaveBeenCalledWith(
      '/fake/bin/hermes',
      ['cron', 'edit', 'abc123abc123', '--repeat', '0'],
      expect.objectContaining({
        env: expect.objectContaining({ HERMES_HOME: tempDir }),
        windowsHide: true,
      }),
      expect.any(Function),
    )
  })
})
