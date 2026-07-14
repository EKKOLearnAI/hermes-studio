import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listProfileNamesFromDisk = vi.hoisted(() => vi.fn())
const getReminderSettings = vi.hoisted(() => vi.fn())
const enqueueAutopilotReminder = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  listProfileNamesFromDisk,
  getProfileDir: (name: string) => name,
}))

vi.mock('../../packages/server/src/services/hermes/autopilot-reminders', async (importOriginal) => ({
  ...await importOriginal<any>(),
  getReminderSettings,
  enqueueAutopilotReminder,
}))

describe('autopilot reminder scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('HERMES_AUTOPILOT_REMINDERS_DISABLED', '')
    vi.stubEnv('HERMES_AUTOPILOT_REMINDER_INTERVAL_MS', '1000')
    listProfileNamesFromDisk.mockReturnValue(['default', 'research'])
    getReminderSettings.mockImplementation((profile: string) => ({ profile, enabled: profile === 'research' }))
    enqueueAutopilotReminder.mockResolvedValue({ status: 'sent' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('does not start when disabled by env flag', async () => {
    vi.stubEnv('HERMES_AUTOPILOT_REMINDERS_DISABLED', '1')
    const { startAutopilotReminderScheduler } = await import('../../packages/server/src/services/hermes/autopilot-reminder-scheduler')

    const scheduler = startAutopilotReminderScheduler()
    await vi.advanceTimersByTimeAsync(2000)

    expect(scheduler.stop).toEqual(expect.any(Function))
    expect(enqueueAutopilotReminder).not.toHaveBeenCalled()
  })

  it('dispatches enabled profiles on interval', async () => {
    const { startAutopilotReminderScheduler } = await import('../../packages/server/src/services/hermes/autopilot-reminder-scheduler')

    const scheduler = startAutopilotReminderScheduler()
    await vi.advanceTimersByTimeAsync(1000)
    scheduler.stop()

    expect(getReminderSettings).toHaveBeenCalledWith('default')
    expect(getReminderSettings).toHaveBeenCalledWith('research')
    expect(enqueueAutopilotReminder).toHaveBeenCalledWith({ profile: 'research' })
    expect(enqueueAutopilotReminder).not.toHaveBeenCalledWith({ profile: 'default' })
  })

  it('can be stopped cleanly', async () => {
    const { startAutopilotReminderScheduler } = await import('../../packages/server/src/services/hermes/autopilot-reminder-scheduler')
    const scheduler = startAutopilotReminderScheduler()

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(2000)

    expect(enqueueAutopilotReminder).not.toHaveBeenCalled()
  })
})
