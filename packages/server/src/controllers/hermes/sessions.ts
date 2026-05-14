import * as hermesCli from '../../services/hermes/hermes-cli'
import { listSessionSummaries, getUsageStatsFromDb, getSessionDetailFromDb } from '../../db/hermes/sessions-db'
import {
  listSessions as localListSessions,
  searchSessions as localSearchSessions,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
} from '../../db/hermes/session-store'
import { ExportCompressor } from '../../lib/context-compressor/export-compressor'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { deleteUsage, getUsage, getUsageBatch } from '../../db/hermes/usage-store'
import type { UsageStatsModelRow, UsageStatsDailyRow } from '../../db/hermes/usage-store'
import { getModelContextLength } from '../../services/hermes/model-context'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getGroupChatServer } from '../../routes/hermes/group-chat'
import { logger } from '../../services/logger'
import type { ConversationSummary } from '../../services/hermes/conversations'

function getPendingDeletedSessionIds(): Set<string> {
  return getGroupChatServer()?.getStorage().getPendingDeletedSessionIds() || new Set<string>()
}

function filterPendingDeletedSessions<T extends { id: string }>(items: T[]): T[] {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return items
  return items.filter(item => !pendingIds.has(item.id))
}

function filterPendingDeletedConversationSummaries(items: ConversationSummary[]): ConversationSummary[] {
  return filterPendingDeletedSessions(items)
}

export async function listConversations(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  const profile = getActiveProfileName()
  const sessions = localListSessions(profile, source, limit && limit > 0 ? limit : 200)
  const summaries: ConversationSummary[] = sessions.map(s => ({
    id: s.id,
    source: s.source,
    model: s.model,
    title: s.title,
    started_at: s.started_at,
    ended_at: s.ended_at,
    last_active: s.last_active,
    message_count: s.message_count,
    tool_call_count: s.tool_call_count,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    cache_read_tokens: s.cache_read_tokens,
    cache_write_tokens: s.cache_write_tokens,
    reasoning_tokens: s.reasoning_tokens,
    billing_provider: s.billing_provider,
    estimated_cost_usd: s.estimated_cost_usd,
    actual_cost_usd: s.actual_cost_usd,
    cost_status: s.cost_status,
    preview: s.preview,
    workspace: s.workspace || null,
    is_active: s.ended_at == null && (Date.now() / 1000 - s.last_active) <= 300,
    thread_session_count: 1,
  }))
  ctx.body = { sessions: filterPendingDeletedConversationSummaries(summaries) }
}

export async function getConversationMessages(ctx: any) {
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'

  const detail = localGetSessionDetail(ctx.params.id)
  if (!detail) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  const messages = detail.messages
    .filter(m => {
      if (humanOnly && m.role !== 'user' && m.role !== 'assistant') return false
      if (!m.content) return false
      return true
    })
    .map(m => ({
      id: m.id,
      session_id: m.session_id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: m.timestamp,
    }))
  ctx.body = {
    session_id: ctx.params.id,
    messages,
    visible_count: messages.length,
    thread_session_count: 1,
  }
}

export async function list(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = getActiveProfileName()
  const effectiveLimit = limit && limit > 0 ? limit : 2000

  const allSessions = localListSessions(profile, source, effectiveLimit)
  ctx.body = { sessions: filterPendingDeletedSessions(allSessions.filter(s => s.source === 'api_server' || s.source === 'cli')) }
}

/**
 * List Hermes sessions only (exclude api_server source)
 * GET /api/hermes/sessions/hermes?source=&limit=
 */
export async function listHermesSessions(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = getActiveProfileName()
  const effectiveLimit = limit && limit > 0 ? limit : 2000

  const allSessions = await listSessionSummaries(source, effectiveLimit, profile)
  ctx.body = { sessions: filterPendingDeletedSessions(allSessions.filter(s => s.source !== 'api_server')) }
}

export async function search(ctx: any) {
  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = getActiveProfileName()
  const results = localSearchSessions(profile, q, limit && limit > 0 ? limit : 20)
  ctx.body = { results: filterPendingDeletedSessions(results) }
}

export async function get(ctx: any) {
  const session = localGetSessionDetail(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
}

/**
 * Get Hermes session detail only (exclude api_server source)
 * GET /api/hermes/sessions/hermes/:id
 */
export async function getHermesSession(ctx: any) {
  // Try database first (consistent with listHermesSessions)
  try {
    const session = await getSessionDetailFromDb(ctx.params.id)
    if (session && session.source !== 'api_server') {
      ctx.body = { session }
      return
    }
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: detail query failed, falling back to CLI')
  }

  // Fallback to CLI
  const session = await hermesCli.getSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  // Filter out api_server sessions
  if (session.source === 'api_server') {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
}

export async function remove(ctx: any) {
  const sessionId = ctx.params.id
  const ok = localDeleteSession(sessionId)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  deleteUsage(sessionId)
  ctx.body = { ok: true }
}

export async function batchRemove(ctx: any) {
  const { ids } = ctx.request.body as { ids?: string[] }
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'ids is required and must be a non-empty array' }
    return
  }

  const validIds = ids.filter(id => typeof id === 'string' && id.trim() !== '')
  if (validIds.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'No valid session ids provided' }
    return
  }

  const results = {
    deleted: 0,
    failed: 0,
    errors: [] as Array<{ id: string; error: string }>
  }

  for (const id of validIds) {
    const ok = localDeleteSession(id)
    if (ok) {
      deleteUsage(id)
      results.deleted++
    } else {
      results.failed++
      results.errors.push({ id, error: 'Failed to delete session' })
    }
  }

  ctx.body = { ...results, ok: true }
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
  const ok = localRenameSession(ctx.params.id, title.trim())
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to rename session' }
    return
  }
  ctx.body = { ok: true }
}

export async function setWorkspace(ctx: any) {
  const { workspace } = ctx.request.body as { workspace?: string }
  if (workspace !== undefined && workspace !== null && typeof workspace !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'workspace must be a string or null' }
    return
  }
  const { updateSession, getSession, createSession } = await import('../../db/hermes/session-store')
  const { getActiveProfileName } = await import('../../services/hermes/hermes-profile')
  const id = ctx.params.id
  if (!getSession(id)) {
    createSession({ id, profile: getActiveProfileName(), title: '' })
  }
  updateSession(id, { workspace: workspace || null } as any)
  ctx.body = { ok: true }
}

export async function contextLength(ctx: any) {
  const profile = (ctx.query.profile as string) || undefined
  ctx.body = { context_length: getModelContextLength(profile) }
}

export async function usageStats(ctx: any) {
  const rawDays = parseInt(String(ctx.query?.days ?? '30'), 10)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30

  let hermes = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    sessions: 0,
    by_model: [] as UsageStatsModelRow[],
    by_day: [] as UsageStatsDailyRow[],
    cost: 0,
    total_api_calls: 0,
  }

  try {
    hermes = await getUsageStatsFromDb(days)
  } catch (err) {
    logger.warn(err, 'usageStats: failed to load Hermes usage analytics from state.db')
  }

  const dayMap = new Map<string, UsageStatsDailyRow>()
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    dayMap.set(key, { date: key, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, errors: 0, cost: 0 })
  }
  for (const d of hermes.by_day) {
    const existing = dayMap.get(d.date)
    if (existing) {
      existing.input_tokens += d.input_tokens; existing.output_tokens += d.output_tokens
      existing.cache_read_tokens += d.cache_read_tokens; existing.cache_write_tokens += d.cache_write_tokens
      existing.sessions += d.sessions; existing.errors += d.errors; existing.cost += d.cost
    }
  }

  ctx.body = {
    total_input_tokens: hermes.input_tokens,
    total_output_tokens: hermes.output_tokens,
    total_cache_read_tokens: hermes.cache_read_tokens,
    total_cache_write_tokens: hermes.cache_write_tokens,
    total_reasoning_tokens: hermes.reasoning_tokens,
    total_sessions: hermes.sessions,
    total_cost: hermes.cost,
    total_api_calls: hermes.total_api_calls,
    period_days: days,
    model_usage: hermes.by_model.sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
    daily_usage: [...dayMap.values()],
  }
}

/**
 * List folders under workspace base path for folder picker.
 * GET /api/hermes/workspace/folders?path=<relative_path>
 * Base: /opt/data/workspace (overridable via WORKSPACE_BASE env)
 */
export async function listWorkspaceFolders(ctx: any) {
  const { resolve, join } = await import('path')
  const { readdir } = await import('fs/promises')
  const { existsSync } = await import('fs')

  const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/opt/data/workspace'
  const subPath = (ctx.query.path as string) || ''

  // Security: prevent path traversal
  const fullPath = resolve(join(WORKSPACE_BASE, subPath))
  if (!fullPath.startsWith(resolve(WORKSPACE_BASE))) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  if (!existsSync(fullPath)) {
    ctx.status = 404
    ctx.body = { error: 'Path not found', folders: [] }
    return
  }

  try {
    const entries = await readdir(fullPath, { withFileTypes: true })
    const folders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: subPath ? `${subPath}/${e.name}` : e.name,
        fullPath: join(fullPath, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    ctx.body = { base: WORKSPACE_BASE, current: subPath, folders }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

const exportCompressor = new ExportCompressor()

export async function exportSession(ctx: any) {
  const session = localGetSessionDetail(ctx.params.id)

  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  const mode = (ctx.query.mode as string) || 'full'
  const ext = (ctx.query.ext as string) || (mode === 'compressed' ? 'txt' : 'json')
  const title = session.title || 'session'
  const safeName = title.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').slice(0, 50)
  const filename = `${safeName}_${ctx.params.id.slice(0, 8)}.${ext}`

  if (mode === 'compressed') {
    const result = await compressSession(session)
    if (ext === 'json') {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'application/json')
      ctx.body = JSON.stringify({ id: session.id, title: session.title, ...result.meta, messages: result.messages }, null, 2)
    } else {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'text/plain; charset=utf-8')
      ctx.body = serializeAsText(session.title, result.messages)
    }
  } else {
    if (ext === 'txt') {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'text/plain; charset=utf-8')
      ctx.body = serializeAsText(session.title, session.messages || [])
    } else {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'application/json')
      ctx.body = JSON.stringify(session, null, 2)
    }
  }
}

async function compressSession(session: any) {
  const mgr = getGatewayManagerInstance()
  const profile = getActiveProfileName()
  const upstream = mgr ? mgr.getUpstream(profile).replace(/\/$/, '') : ''
  const apiKey = mgr ? mgr.getApiKey(profile) || undefined : undefined
  const messages = (session.messages || []).map((m: any) => ({
    role: m.role,
    content: m.content || '',
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.tool_name,
    reasoning_content: m.reasoning,
  }))

  return exportCompressor.compress(messages, upstream, apiKey, session.id, profile)
}

function serializeAsText(title: string | null, messages: any[]): string {
  const lines: string[] = [`# ${title || 'Untitled'}`, '']
  for (const msg of messages) {
    const role = msg.role || 'unknown'
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    const ts = msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : ''
    lines.push(`[${role}]${ts ? ' ' + ts : ''}`)
    lines.push(content || '')
    lines.push('')
  }
  return lines.join('\n')
}

export async function getConversationMessagesPaginated(ctx: any) {
  const offset = ctx.query.offset ? parseInt(ctx.query.offset as string, 10) : 0
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : 50

  const { getSessionDetailPaginated } = await import('../../db/hermes/session-store')
  const result = getSessionDetailPaginated(ctx.params.id, offset, limit)

  if (!result) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }

  ctx.body = {
    session: {
      id: result.session.id,
      source: result.session.source,
      model: result.session.model,
      title: result.session.title,
      started_at: result.session.started_at,
      ended_at: result.session.ended_at,
      last_active: result.session.last_active,
      message_count: result.session.message_count,
      input_tokens: result.session.input_tokens,
      output_tokens: result.session.output_tokens,
    },
    messages: result.messages,
    total: result.total,
    offset: result.offset,
    limit: result.limit,
    hasMore: result.hasMore,
  }
}
