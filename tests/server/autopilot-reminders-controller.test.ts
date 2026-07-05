import { beforeEach, describe, expect, it, vi } from 'vitest'

const listUserProfiles = vi.fn()

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles,
}))

vi.mock('../../packages/server/src/services/hermes/autopilot-reminders', () => ({
  getReminderSettings: vi.fn(() => ({ profile: 'default', enabled: false })),
  updateReminderSettings: vi.fn(() => ({ profile: 'default', enabled: true })),
  listRecentReminderDeliveries: vi.fn(() => [{ id: 'delivery-1' }]),
  dispatchAutopilotReminder: vi.fn(() => ({ status: 'sent', reason: 'send' })),
}))

describe('autopilot reminder controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listUserProfiles.mockReset()
  })

  it('rejects a profile that is not available to the current user', async () => {
    listUserProfiles.mockReturnValue([{ profile_name: 'work' }])
    const { settings } = await import('../../packages/server/src/controllers/hermes/autopilot-reminders')
    const ctx: any = {
      query: { profile: 'private' },
      state: { user: { id: 'user-1', role: 'user' } },
      body: null,
    }

    await settings(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Profile "private" is not available for this user' })
  })

  it('returns reminder settings for the requested profile', async () => {
    const service = await import('../../packages/server/src/services/hermes/autopilot-reminders')
    const { settings } = await import('../../packages/server/src/controllers/hermes/autopilot-reminders')
    const ctx: any = {
      query: { profile: 'default' },
      state: { user: { id: 'admin', role: 'super_admin' } },
      body: null,
    }

    await settings(ctx)

    expect(service.getReminderSettings).toHaveBeenCalledWith('default')
    expect(ctx.body).toEqual({ settings: { profile: 'default', enabled: false } })
  })

  it('updates reminder settings', async () => {
    const service = await import('../../packages/server/src/services/hermes/autopilot-reminders')
    const { updateSettings } = await import('../../packages/server/src/controllers/hermes/autopilot-reminders')
    const ctx: any = {
      query: { profile: 'default' },
      request: { body: { enabled: true } },
      state: { user: { id: 'admin', role: 'super_admin' } },
      body: null,
    }

    await updateSettings(ctx)

    expect(service.updateReminderSettings).toHaveBeenCalledWith('default', { enabled: true })
    expect(ctx.body).toEqual({ settings: { profile: 'default', enabled: true } })
  })

  it('lists reminder deliveries', async () => {
    const service = await import('../../packages/server/src/services/hermes/autopilot-reminders')
    const { deliveries } = await import('../../packages/server/src/controllers/hermes/autopilot-reminders')
    const ctx: any = {
      query: { profile: 'default', limit: '5' },
      state: { user: { id: 'admin', role: 'super_admin' } },
      body: null,
    }

    await deliveries(ctx)

    expect(service.listRecentReminderDeliveries).toHaveBeenCalledWith('default', 5)
    expect(ctx.body).toEqual({ deliveries: [{ id: 'delivery-1' }] })
  })

  it('dispatches a test reminder', async () => {
    const service = await import('../../packages/server/src/services/hermes/autopilot-reminders')
    const { testReminder } = await import('../../packages/server/src/controllers/hermes/autopilot-reminders')
    const ctx: any = {
      query: { profile: 'default' },
      state: { user: { id: 'admin', role: 'super_admin' } },
      body: null,
    }

    await testReminder(ctx)

    expect(service.dispatchAutopilotReminder).toHaveBeenCalledWith({ profile: 'default', force: true })
    expect(ctx.body).toEqual({ result: { status: 'sent', reason: 'send' } })
  })
})
