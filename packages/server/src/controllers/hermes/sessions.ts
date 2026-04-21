import * as hermesCli from '../../services/hermes/hermes-cli'
import { getConversationDetail, listConversationSummaries } from '../../services/hermes/conversations'
import { listSessionSummaries } from '../../services/hermes/sessions-db'
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

export async function listConversations(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = parseHumanOnly(ctx.query.humanOnly)
  const limit = parseLimit(ctx.query.limit)
  const sessions = await listConversationSummaries({ source, humanOnly, limit })
  ctx.body = { sessions }
}

export async function getConversationMessages(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = parseHumanOnly(ctx.query.humanOnly)
  const detail = await getConversationDetail(ctx.params.id, { source, humanOnly })
  if (!detail) {
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
    ctx.body = { sessions }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: summary query failed, falling back to CLI')
  }

  const sessions = await hermesCli.listSessions(source, limit)
  ctx.body = { sessions }
}

export async function get(ctx: any) {
  const session = await hermesCli.getSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
}

export async function remove(ctx: any) {
  const ok = await hermesCli.deleteSession(ctx.params.id)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  ctx.body = { ok: true }
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
