// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request: requestMock }))

import {
  createNotificationEvent,
  deleteNotification,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/api/hermes/notifications'

describe('notification API', () => {
  beforeEach(() => requestMock.mockReset())

  it('uses profile-scoped authenticated endpoints', async () => {
    requestMock.mockResolvedValue({ notifications: [], unreadCount: 0 })
    await fetchNotifications({ limit: 25, unreadOnly: true })
    await markNotificationRead('notice 1')
    await markAllNotificationsRead()
    await deleteNotification('notice 1')

    expect(requestMock.mock.calls).toEqual([
      ['/api/hermes/notifications?limit=25&unread=true'],
      ['/api/hermes/notifications/notice%201/read', { method: 'POST' }],
      ['/api/hermes/notifications/read-all', { method: 'POST' }],
      ['/api/hermes/notifications/notice%201', { method: 'DELETE' }],
    ])
  })

  it('posts only the event contract', async () => {
    requestMock.mockResolvedValue({ created: true, notification: { id: 'n-1' } })
    const event = {
      dedupeKey: 'chat:s-1:r-1:completed',
      type: 'chat.completed' as const,
      severity: 'success' as const,
      title: 'Done',
      body: 'Ready',
      source: { kind: 'session' as const, id: 's-1' },
    }

    await createNotificationEvent(event)

    expect(requestMock).toHaveBeenCalledWith('/api/hermes/notifications', {
      method: 'POST',
      body: JSON.stringify(event),
    })
  })
})
