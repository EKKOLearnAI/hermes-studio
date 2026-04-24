import * as hermesCli from '../../services/hermes/hermes-cli'
import { getConversationDetail, listConversationSummaries } from '../../services/hermes/conversations'
import {
  getConversationDetailFromDb,
  listConversationSummariesFromDb,
} from '../../db/hermes/conversations-db'
import { listSessionSummaries, searchSessionSummaries } from '../../db/hermes/sessions-db'
import { deleteUsage, getUsage, getUsageBatch } from '../../db/hermes/usage-store'
import { getModelContextLength } from '../../services/hermes/model-context'
import type { ConversationDetail, ConversationSummary } from '../../services/hermes/conversations'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getGroupChatServer } from '../../routes/hermes/group-chat'
import { logger } from '../../services/logger'

function parseHumanOnly(value: unknown): boolean {
  if (typeof value !== 'string') return true
  return value !== 'false' && value !== '0'
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function getPendingDeletedSessionIds(): Set<string> {
  return getGroupChatServer()?.getStorage().getPendingDeletedSessionIds() || new Set<string>()
}

function isPendingDeletedSession(sessionId: string): boolean {
  return getPendingDeletedSessionIds().has(sessionId)
}

function filterPendingDeletedSessions<T extends { id: string }>(items: T[]): T[] {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return items
  return items.filter(item => !pendingIds.has(item.id))
}

function filterPendingDeletedConversationSummaries(items: ConversationSummary[]): ConversationSummary[] {
  return filterPendingDeletedSessions(items)
}

function hasPendingDeletedConversation(detail: ConversationDetail): boolean {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return false
  if (pendingIds.has(detail.session_id)) return true
  return detail.messages.some(message => pendingIds.has(message.session_id))
}

function getGroupChatStorage() {
  return getGroupChatServer()?.getStorage() || null
}

export async function listConversations(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = parseHumanOnly(ctx.query.humanOnly)
  const limit = parseLimit(ctx.query.limit)

  try {
    const sessions = await listConversationSummariesFromDb({ source, humanOnly, limit })
    ctx.body = { sessions: filterPendingDeletedConversationSummaries(sessions) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Conversation DB: summary query failed, falling back to CLI export')
  }

  const sessions = await listConversationSummaries({ source, humanOnly, limit })
  ctx.body = { sessions: filterPendingDeletedConversationSummaries(sessions) }
}

export async function getConversationMessages(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = parseHumanOnly(ctx.query.humanOnly)

  try {
    const detail = await getConversationDetailFromDb(ctx.params.id, { source, humanOnly })
    if (!detail || hasPendingDeletedConversation(detail)) {
      ctx.status = 404
      ctx.body = { error: 'Conversation not found' }
      return
    }
    ctx.body = detail
    return
  } catch (err) {
    logger.warn(err, 'Hermes Conversation DB: detail query failed, falling back to CLI export')
  }

  const detail = await getConversationDetail(ctx.params.id, { source, humanOnly })
  if (!detail || hasPendingDeletedConversation(detail)) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  ctx.body = detail
}

export async function list(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const sessions = await listSessionSummaries(source, limit && limit > 0 ? limit : 2000)
    ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: summary query failed, falling back to CLI')
  }

  const sessions = await hermesCli.listSessions(source, limit)
  ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
}

export async function search(ctx: any) {
  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const source = typeof ctx.query.source === 'string' && ctx.query.source.trim()
    ? ctx.query.source.trim()
    : undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const results = await searchSessionSummaries(q, source, limit && limit > 0 ? limit : 20)
    ctx.body = { results: filterPendingDeletedSessions(results) }
  } catch (err) {
    logger.error(err, 'Hermes Session DB: search failed')
    ctx.status = 500
    ctx.body = { error: 'Failed to search sessions' }
  }
}

export async function get(ctx: any) {
  if (isPendingDeletedSession(ctx.params.id)) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  const session = await hermesCli.getSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
}

export async function remove(ctx: any) {
  const sessionId = ctx.params.id
  const storage = getGroupChatStorage()
  const currentProfile = getActiveProfileName()
  const mapped = storage?.getSessionProfile(sessionId) || null

  logger.info('[remove] sessionId=%s, currentProfile=%s, mapped=%j', sessionId, currentProfile, mapped)

  if (!mapped) {
    logger.info('[remove] no mapping found, deleting directly')
    const ok = await hermesCli.deleteSession(sessionId)
    if (!ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete session' }
      return
    }
    deleteUsage(sessionId)
    ctx.body = { ok: true }
    return
  }

  if (mapped.profile_name === currentProfile) {
    logger.info('[remove] same profile, deleting directly')
    const ok = await hermesCli.deleteSession(sessionId)
    if (!ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete session' }
      return
    }
    storage?.deleteSessionProfile(sessionId)
    deleteUsage(sessionId)
    ctx.body = { ok: true }
    return
  }

  logger.info('[remove] cross-profile detected, enqueued deferred delete for profile=%s', mapped.profile_name)
  storage?.enqueuePendingSessionDelete(sessionId, mapped.profile_name)
  deleteUsage(sessionId)
  ctx.body = { ok: true, deferred: true }
}

export async function usageBatch(ctx: any) {
  const ids = (ctx.query.ids as string)
  if (!ids) {
    ctx.body = {}
    return
  }
  const idList = ids.split(',').filter(Boolean)
  ctx.body = getUsageBatch(idList)
}

export async function usageSingle(ctx: any) {
  const result = getUsage(ctx.params.id)
  if (!result) {
    ctx.body = { input_tokens: 0, output_tokens: 0 }
    return
  }
  ctx.body = result
}

export async function rename(ctx: any) {
  const { title } = ctx.request.body as { title?: string }
  if (!title || typeof title !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'title is required' }
    return
  }
  const ok = await hermesCli.renameSession(ctx.params.id, title.trim())
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to rename session' }
    return
  }
  ctx.body = { ok: true }
}

export async function contextLength(ctx: any) {
  const profile = (ctx.query.profile as string) || undefined
  ctx.body = { context_length: getModelContextLength(profile) }
}
