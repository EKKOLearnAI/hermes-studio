import { beforeEach, describe, expect, it, vi } from 'vitest'

const listUserProfiles = vi.fn()

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles,
}))

vi.mock('../../packages/server/src/services/hermes/personal-autopilot', () => ({
  getPersonalAutopilotOverview: vi.fn(() => ({ profile: 'default', mode: 'nudge' })),
  createPersonalAutopilotQuickLog: vi.fn(() => ({ id: 'quick-log-1', kind: 'skin' })),
}))

describe('personal autopilot controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listUserProfiles.mockReset()
  })

  it('rejects a profile that is not available to the current user', async () => {
    listUserProfiles.mockReturnValue([{ profile_name: 'work' }])
    const { overview } = await import('../../packages/server/src/controllers/hermes/personal-autopilot')
    const ctx: any = {
      query: { profile: 'private' },
      state: { user: { id: 'user-1', role: 'user' } },
      body: null,
    }

    await overview(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Profile "private" is not available for this user' })
  })

  it('returns the autopilot overview for the requested profile', async () => {
    const service = await import('../../packages/server/src/services/hermes/personal-autopilot')
    const { overview } = await import('../../packages/server/src/controllers/hermes/personal-autopilot')
    const ctx: any = {
      query: { profile: 'default' },
      state: { user: { id: 'admin', role: 'super_admin' } },
      body: null,
    }

    await overview(ctx)

    expect(service.getPersonalAutopilotOverview).toHaveBeenCalledWith({ profile: 'default' })
    expect(ctx.body).toEqual({ overview: { profile: 'default', mode: 'nudge' } })
  })

  it('creates a quick log through the service', async () => {
    const service = await import('../../packages/server/src/services/hermes/personal-autopilot')
    const { quickLog } = await import('../../packages/server/src/controllers/hermes/personal-autopilot')
    const ctx: any = {
      query: { profile: 'default' },
      request: { body: { text: '脸出油', kind: 'skin' } },
      state: { user: { id: 'admin', role: 'super_admin', username: 'admin' } },
      body: null,
    }

    await quickLog(ctx)

    expect(service.createPersonalAutopilotQuickLog).toHaveBeenCalledWith(
      { text: '脸出油', kind: 'skin' },
      'admin',
      'default',
    )
    expect(ctx.body).toEqual({ log: { id: 'quick-log-1', kind: 'skin' } })
  })
})
