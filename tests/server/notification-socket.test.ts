import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(),
}))
vi.mock('../../packages/server/src/db/hermes/users-store', () => ({ userCanAccessProfile: vi.fn() }))
vi.mock('../../packages/server/src/services/notification-service', () => ({
  notificationService: { onCreated: vi.fn(() => vi.fn()) },
}))

describe('notification socket isolation', () => {
  it('uses owner and profile as independent room dimensions', async () => {
    const { notificationRoom } = await import('../../packages/server/src/services/notification-socket')
    expect(notificationRoom(7, 'default')).toBe('notification:7:default')
    expect(notificationRoom(8, 'default')).not.toBe(notificationRoom(7, 'default'))
    expect(notificationRoom(7, 'research')).not.toBe(notificationRoom(7, 'default'))
  })
})
