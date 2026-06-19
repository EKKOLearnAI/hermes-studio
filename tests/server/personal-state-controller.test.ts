import { beforeEach, describe, expect, it, vi } from 'vitest'

const listUserProfiles = vi.fn()

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles,
}))

vi.mock('../../packages/server/src/services/hermes/personal-state', () => ({
  getPersonalStateOverview: vi.fn(() => ({ profile: 'default' })),
  approvePersonalStateProposal: vi.fn(() => ({ id: 'proposal-1', status: 'approved' })),
  rejectPersonalStateProposal: vi.fn(() => ({ id: 'proposal-1', status: 'rejected' })),
  checkInPersonalStateTask: vi.fn(() => ({ id: 'task-1', status: 'done' })),
}))

describe('personal state controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listUserProfiles.mockReset()
  })

  it('rejects a profile that is not available to the current user', async () => {
    listUserProfiles.mockReturnValue([{ profile_name: 'work' }])
    const { overview } = await import('../../packages/server/src/controllers/hermes/personal-state')
    const ctx: any = {
      query: { profile: 'private' },
      state: { user: { id: 'user-1', role: 'user' } },
      body: null,
    }

    await overview(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Profile "private" is not available for this user' })
  })
})
