import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/notification-store', () => ({
  createNotification: mocks.createNotification,
}))
vi.mock('fs', () => ({ existsSync: mocks.existsSync, readFileSync: mocks.readFileSync }))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => `/profiles/${profile}`,
}))

describe('notification service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.existsSync.mockReturnValue(true)
  })

  it('emits only for the first idempotent creation', async () => {
    const { notificationService } = await import('../../packages/server/src/services/notification-service')
    const listener = vi.fn()
    const remove = notificationService.onCreated(listener)
    const notification = { id: 'n-1' }
    mocks.createNotification
      .mockReturnValueOnce({ created: true, notification })
      .mockReturnValueOnce({ created: false, notification })

    const input = { ownerId: 7, profile: 'research', dedupeKey: 'event-1', type: 'workflow.completed', severity: 'success' as const, title: 'Done', body: '', source: { kind: 'workflow' as const, id: 'wf-1' } }
    notificationService.publish(input)
    notificationService.publish(input)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ ownerId: 7, profile: 'research', notification })
    remove()
  })

  it('reconciles completed and failed cron metadata with stable dedupe keys', async () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({ jobs: [
      { id: 'job-ok', name: 'Backup', last_run_at: '2026-08-07T01:00:00Z', last_status: 'completed' },
      { job_id: 'job-bad', name: 'Import', last_run_at: '2026-08-07T02:00:00Z', last_status: 'failed', last_error: 'network' },
    ] }))
    mocks.createNotification.mockImplementation((input: any) => ({ created: true, notification: input }))
    const { reconcileCronNotifications } = await import('../../packages/server/src/services/notification-service')

    expect(reconcileCronNotifications(7, 'research')).toBe(2)
    expect(mocks.readFileSync).toHaveBeenCalledWith('/profiles/research/cron/jobs.json', 'utf8')
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 7, profile: 'research', dedupeKey: 'cron:job-ok:2026-08-07T01:00:00Z:completed', type: 'cron.completed',
    }))
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 7, profile: 'research', dedupeKey: 'cron:job-bad:2026-08-07T02:00:00Z:failed', type: 'cron.failed', body: 'network',
    }))
  })

  it('fails closed on missing or malformed cron metadata', async () => {
    const { reconcileCronNotifications } = await import('../../packages/server/src/services/notification-service')
    mocks.existsSync.mockReturnValueOnce(false)
    expect(reconcileCronNotifications(7, 'default')).toBe(0)
    mocks.existsSync.mockReturnValueOnce(true)
    mocks.readFileSync.mockReturnValueOnce('{bad json')
    expect(reconcileCronNotifications(7, 'default')).toBe(0)
    expect(mocks.createNotification).not.toHaveBeenCalled()
  })
})
