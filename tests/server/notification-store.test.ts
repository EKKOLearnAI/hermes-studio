import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  getStoragePath: () => ':memory:',
}))

describe('notification store', () => {
  beforeEach(async () => {
    vi.resetModules()
    state.db = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    vi.resetModules()
  })

  it('deduplicates source events and isolates owner plus profile', async () => {
    const { createNotification, listNotifications } = await import('../../packages/server/src/db/hermes/notification-store')

    const first = createNotification({
      ownerId: 7,
      profile: 'default',
      dedupeKey: 'chat:session-1:run-1:completed',
      type: 'chat.completed',
      severity: 'success',
      title: 'Research finished',
      body: 'The answer is ready.',
      source: { kind: 'session', id: 'session-1', route: { name: 'hermes.session', params: { sessionId: 'session-1' } } },
    })
    const duplicate = createNotification({
      ownerId: 7,
      profile: 'default',
      dedupeKey: 'chat:session-1:run-1:completed',
      type: 'chat.completed',
      severity: 'success',
      title: 'Duplicate',
      body: 'Must not create another row.',
      source: { kind: 'session', id: 'session-1' },
    })
    createNotification({
      ownerId: 8,
      profile: 'default',
      dedupeKey: 'chat:session-1:run-1:completed',
      type: 'chat.completed',
      severity: 'success',
      title: 'Other owner',
      body: '',
      source: { kind: 'session', id: 'session-1' },
    })
    createNotification({
      ownerId: 7,
      profile: 'research',
      dedupeKey: 'chat:session-1:run-1:completed',
      type: 'chat.completed',
      severity: 'success',
      title: 'Other profile',
      body: '',
      source: { kind: 'session', id: 'session-1' },
    })

    expect(duplicate.created).toBe(false)
    expect(duplicate.notification.id).toBe(first.notification.id)
    expect(listNotifications({ ownerId: 7, profile: 'default' }).notifications).toEqual([
      expect.objectContaining({ title: 'Research finished', unread: true }),
    ])
  })

  it('persists mark one, mark all, unread count, and owner-safe deletion', async () => {
    const {
      createNotification,
      deleteNotification,
      listNotifications,
      markAllNotificationsRead,
      markNotificationRead,
    } = await import('../../packages/server/src/db/hermes/notification-store')

    const one = createNotification({ ownerId: 7, profile: 'default', dedupeKey: 'one', type: 'workflow.failed', severity: 'error', title: 'One', body: '', source: { kind: 'workflow', id: 'wf-1' } }).notification
    const two = createNotification({ ownerId: 7, profile: 'default', dedupeKey: 'two', type: 'approval.requested', severity: 'warning', title: 'Two', body: '', source: { kind: 'session', id: 's-1' } }).notification

    expect(markNotificationRead({ ownerId: 8, profile: 'default', id: one.id })).toBeNull()
    expect(markNotificationRead({ ownerId: 7, profile: 'default', id: one.id })?.unread).toBe(false)
    expect(listNotifications({ ownerId: 7, profile: 'default' }).unreadCount).toBe(1)
    expect(markAllNotificationsRead({ ownerId: 7, profile: 'default' })).toBe(1)
    expect(listNotifications({ ownerId: 7, profile: 'default' }).unreadCount).toBe(0)
    expect(deleteNotification({ ownerId: 8, profile: 'default', id: two.id })).toBe(false)
    expect(deleteNotification({ ownerId: 7, profile: 'default', id: two.id })).toBe(true)
  })
})
