import { request } from '../client'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'
export type NotificationType =
  | 'chat.completed' | 'chat.failed'
  | 'group_chat.completed' | 'group_chat.failed'
  | 'workflow.completed' | 'workflow.failed' | 'workflow.approval'
  | 'cron.completed' | 'cron.failed'
  | 'approval.requested' | 'clarify.requested'

export interface NotificationSource {
  kind: 'session' | 'room' | 'workflow' | 'cron' | 'system'
  id: string
  runId?: string
  route?: { name: string; params?: Record<string, string>; query?: Record<string, string> }
}

export interface NotificationRecord {
  id: string
  ownerId: number
  profile: string
  dedupeKey: string
  type: NotificationType
  severity: NotificationSeverity
  title: string
  body: string
  source: NotificationSource
  unread: boolean
  readAt: number | null
  createdAt: number
  updatedAt: number
}

export interface NotificationEvent {
  dedupeKey: string
  type: NotificationType
  severity: NotificationSeverity
  title: string
  body: string
  source: NotificationSource
}

export function fetchNotifications(options: { limit?: number; unreadOnly?: boolean } = {}) {
  const params = new URLSearchParams()
  if (options.limit) params.set('limit', String(options.limit))
  if (options.unreadOnly) params.set('unread', 'true')
  const query = params.toString()
  return request<{ notifications: NotificationRecord[]; unreadCount: number }>(
    `/api/hermes/notifications${query ? `?${query}` : ''}`,
  )
}

export async function createNotificationEvent(event: NotificationEvent) {
  const result = await request<{ created: boolean; notification: NotificationRecord }>('/api/hermes/notifications', {
    method: 'POST',
    body: JSON.stringify(event),
  })
  if (result.created && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('hermes:notification-created', { detail: result.notification }))
  }
  return result
}

export function markNotificationRead(id: string) {
  return request<{ notification: NotificationRecord }>(`/api/hermes/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
}

export function markNotificationReadByDedupeKey(dedupeKey: string) {
  return request<{ updated: boolean }>('/api/hermes/notifications/read-by-key', {
    method: 'POST',
    body: JSON.stringify({ dedupeKey }),
  })
}

export function markAllNotificationsRead() {
  return request<{ updated: number }>('/api/hermes/notifications/read-all', { method: 'POST' })
}

export function deleteNotification(id: string) {
  return request<{ deleted: boolean }>(`/api/hermes/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
