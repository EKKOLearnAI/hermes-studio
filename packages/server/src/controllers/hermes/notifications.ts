import type { Context } from 'koa'
import {
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationReadByDedupeKey,
} from '../../db/hermes/notification-store'
import { notificationService, reconcileCronNotifications } from '../../services/notification-service'

function scope(ctx: Context): { ownerId: number; profile: string } | null {
  const ownerId = ctx.state.user?.id
  if (!ownerId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  const profile = ctx.state.profile?.name
  if (!profile) {
    ctx.status = 400
    ctx.body = { error: 'Profile is required' }
    return null
  }
  return { ownerId, profile }
}

function queryValue(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

export async function create(ctx: Context) {
  const ownerScope = scope(ctx)
  if (!ownerScope) return
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const dedupeKey = typeof body.dedupeKey === 'string' ? body.dedupeKey.trim() : ''
  const type = typeof body.type === 'string' ? body.type.trim() : ''
  const severity = typeof body.severity === 'string' ? body.severity.trim() : ''
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const messageBody = typeof body.body === 'string' ? body.body : ''
  const source = body.source && typeof body.source === 'object' ? body.source as Record<string, unknown> : null
  const allowedTypes = new Set([
    'chat.completed', 'chat.failed', 'group_chat.completed', 'group_chat.failed',
    'workflow.completed', 'workflow.failed',
    'workflow.approval', 'cron.completed', 'cron.failed',
    'approval.requested', 'clarify.requested',
  ])
  if (!dedupeKey || !allowedTypes.has(type) || !['info', 'success', 'warning', 'error'].includes(severity)
    || !title || !source || typeof source.kind !== 'string' || typeof source.id !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'Invalid notification payload' }
    return
  }
  const result = notificationService.publish({
    ...ownerScope,
    dedupeKey,
    type,
    severity: severity as 'info' | 'success' | 'warning' | 'error',
    title,
    body: messageBody,
    source: source as any,
  })
  ctx.status = result.created ? 201 : 200
  ctx.body = result
}

export async function list(ctx: Context) {
  const ownerScope = scope(ctx)
  if (!ownerScope) return
  const parsedLimit = Number(queryValue(ctx.query.limit))
  reconcileCronNotifications(ownerScope.ownerId, ownerScope.profile)
  ctx.body = listNotifications({
    ...ownerScope,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    unreadOnly: queryValue(ctx.query.unread) === 'true',
  })
}

export async function markRead(ctx: Context) {
  const ownerScope = scope(ctx)
  if (!ownerScope) return
  const notification = markNotificationRead({ ...ownerScope, id: ctx.params.id })
  if (!notification) {
    ctx.status = 404
    ctx.body = { error: 'Notification not found' }
    return
  }
  ctx.body = { notification }
}

export async function markReadByDedupeKey(ctx: Context) {
  const ownerScope = scope(ctx)
  if (!ownerScope) return
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const dedupeKey = typeof body.dedupeKey === 'string' ? body.dedupeKey.trim() : ''
  if (!dedupeKey) {
    ctx.status = 400
    ctx.body = { error: 'dedupeKey is required' }
    return
  }
  ctx.body = { updated: markNotificationReadByDedupeKey({ ...ownerScope, dedupeKey }) }
}

export async function markAllRead(ctx: Context) {
  const ownerScope = scope(ctx)
  if (!ownerScope) return
  ctx.body = { updated: markAllNotificationsRead(ownerScope) }
}

export async function remove(ctx: Context) {
  const ownerScope = scope(ctx)
  if (!ownerScope) return
  if (!deleteNotification({ ...ownerScope, id: ctx.params.id })) {
    ctx.status = 404
    ctx.body = { error: 'Notification not found' }
    return
  }
  ctx.body = { deleted: true }
}
