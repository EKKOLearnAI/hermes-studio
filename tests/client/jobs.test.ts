// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.jobs' } },
    replace: vi.fn(),
  },
}))

import {
  buildJobUpdateRequest,
  scheduleToDisplayText,
  scheduleToEditableInput,
  updateJob,
} from '../../packages/client/src/api/hermes/jobs'
import type { Job } from '../../packages/client/src/api/hermes/jobs'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    id: 'job-1',
    name: 'artifact cleanup',
    prompt: 'short prompt',
    skills: [],
    skill: null,
    model: null,
    provider: null,
    base_url: null,
    script: null,
    schedule: { kind: 'interval', minutes: 7200, display: 'every 7200m' },
    schedule_display: 'every 7200m',
    repeat: { times: null, completed: 0 },
    enabled: true,
    state: 'scheduled',
    paused_at: null,
    paused_reason: null,
    created_at: '2026-04-30T00:00:00Z',
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    deliver: 'origin',
    origin: null,
    last_delivery_error: null,
    ...overrides,
  }
}

describe('Hermes jobs edit payloads', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('uses display text for interval schedules without manufacturing expr', () => {
    const schedule = { kind: 'interval' as const, minutes: 7200, display: 'every 7200m' }

    expect(scheduleToEditableInput(schedule, '')).toBe('every 7200m')
    expect(scheduleToDisplayText(schedule, '—')).toBe('every 7200m')
  })

  it('keeps cron expr as the editable schedule string', () => {
    const schedule = { kind: 'cron' as const, expr: '0 9 * * 1', display: '0 9 * * 1' }

    expect(scheduleToEditableInput(schedule, '')).toBe('0 9 * * 1')
    expect(scheduleToDisplayText(schedule, '—')).toBe('0 9 * * 1')
  })

  it('omits unchanged long prompts from name-only updates', () => {
    const prompt = 'x'.repeat(9484)
    const original = makeJob({ prompt })

    const payload = buildJobUpdateRequest(original, {
      name: 'artifact cleanup renamed',
      schedule: 'every 7200m',
      prompt,
      deliver: 'origin',
      repeat_times: null,
    })

    expect(payload).toEqual({ name: 'artifact cleanup renamed' })
    expect(payload).not.toHaveProperty('prompt')
    expect(payload).not.toHaveProperty('schedule')
  })

  it('sends changed interval schedules as raw strings', () => {
    const original = makeJob()

    const payload = buildJobUpdateRequest(original, {
      name: original.name,
      schedule: 'every 14400m',
      prompt: original.prompt,
      deliver: 'origin',
      repeat_times: null,
    })

    expect(payload).toEqual({ schedule: 'every 14400m' })
  })

  it('does not send a PATCH body with structured schedule objects', async () => {
    const returnedJob = makeJob({ name: 'artifact cleanup renamed' })
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job: returnedJob }),
    })

    await updateJob('job-1', { name: 'artifact cleanup renamed', schedule: 'every 14400m' })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [, options] = mockFetch.mock.calls[0]
    expect(JSON.parse(options.body as string)).toEqual({
      name: 'artifact cleanup renamed',
      schedule: 'every 14400m',
    })
  })
})
