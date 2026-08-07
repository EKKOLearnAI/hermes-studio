import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  createNotification: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  deleteNotification: vi.fn(),
  reconcileCronNotifications: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/notification-store', () => store)
vi.mock('../../packages/server/src/services/notification-service', () => ({
  notificationService: { publish: store.createNotification },
  reconcileCronNotifications: store.reconcileCronNotifications,
}))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
}))

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: { user: { id: 7 }, profile: { name: 'research' } },
    query: {},
    params: {},
    request: { body: {} },
    status: 200,
    body: undefined,
    ...overrides,
  } as any
}

describe('notification controller', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists only the authenticated owner in the resolved profile', async () => {
    store.listNotifications.mockReturnValue({ notifications: [], unreadCount: 0 })
    const { list } = await import('../../packages/server/src/controllers/hermes/notifications')
    const ctx = context({ query: { limit: '25', unread: 'true' } })

    await list(ctx)

    expect(store.listNotifications).toHaveBeenCalledWith({
      ownerId: 7,
      profile: 'research',
      limit: 25,
      unreadOnly: true,
    })
    expect(ctx.body).toEqual({ notifications: [], unreadCount: 0 })
  })

  it('requires authenticated owner and a resolved profile', async () => {
    const { list } = await import('../../packages/server/src/controllers/hermes/notifications')
    const missingUser = context({ state: { profile: { name: 'research' } } })
    const missingProfile = context({ state: { user: { id: 7 } } })

    await list(missingUser)
    await list(missingProfile)

    expect(missingUser.status).toBe(401)
    expect(missingProfile.status).toBe(400)
    expect(store.listNotifications).not.toHaveBeenCalled()
  })

  it('marks and deletes only records owned by the caller', async () => {
    store.markNotificationRead.mockReturnValue(null)
    store.deleteNotification.mockReturnValue(false)
    const { markRead, remove } = await import('../../packages/server/src/controllers/hermes/notifications')
    const markCtx = context({ params: { id: 'foreign' } })
    const deleteCtx = context({ params: { id: 'foreign' } })

    await markRead(markCtx)
    await remove(deleteCtx)

    expect(markCtx.status).toBe(404)
    expect(deleteCtx.status).toBe(404)
    expect(store.markNotificationRead).toHaveBeenCalledWith({ ownerId: 7, profile: 'research', id: 'foreign' })
    expect(store.deleteNotification).toHaveBeenCalledWith({ ownerId: 7, profile: 'research', id: 'foreign' })
  })

  it('creates an idempotent event notification in the authenticated scope', async () => {
    store.createNotification.mockReturnValue({
      created: true,
      notification: { id: 'notice-1', unread: true },
    })
    const { create } = await import('../../packages/server/src/controllers/hermes/notifications')
    const ctx = context({ request: { body: {
      dedupeKey: 'chat:session-1:run-1:completed',
      type: 'chat.completed',
      severity: 'success',
      title: 'Done',
      body: 'Ready',
      source: { kind: 'session', id: 'session-1' },
      ownerId: 999,
      profile: 'forbidden',
    } } })

    await create(ctx)

    expect(store.createNotification).toHaveBeenCalledWith({
      ownerId: 7,
      profile: 'research',
      dedupeKey: 'chat:session-1:run-1:completed',
      type: 'chat.completed',
      severity: 'success',
      title: 'Done',
      body: 'Ready',
      source: { kind: 'session', id: 'session-1' },
    })
    expect(ctx.status).toBe(201)
  })

  it('rejects invalid notification event payloads', async () => {
    const { create } = await import('../../packages/server/src/controllers/hermes/notifications')
    const ctx = context({ request: { body: { type: 'unknown', title: '' } } })

    await create(ctx)

    expect(ctx.status).toBe(400)
    expect(store.createNotification).not.toHaveBeenCalled()
  })

  it('marks all notifications read in the current profile', async () => {
    store.markAllNotificationsRead.mockReturnValue(3)
    const { markAllRead } = await import('../../packages/server/src/controllers/hermes/notifications')
    const ctx = context()

    await markAllRead(ctx)

    expect(store.markAllNotificationsRead).toHaveBeenCalledWith({ ownerId: 7, profile: 'research' })
    expect(ctx.body).toEqual({ updated: 3 })
  })
})
