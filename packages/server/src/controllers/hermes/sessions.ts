import * as hermesCli from '../../services/hermes/hermes-cli'
import { listSessionSummaries, getUsageStatsFromDb, getSessionDetailFromDb, getSessionDetailFromDbWithProfile, getExactSessionDetailFromDbWithProfile } from '../../db/hermes/sessions-db'
import {
  listSessions as localListSessions,
  searchSessions as localSearchSessions,
  getSession as localGetSession,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
} from '../../db/hermes/session-store'
import { ExportCompressor } from '../../lib/context-compressor/export-compressor'
import { deleteUsage, getUsage, getUsageBatch } from '../../db/hermes/usage-store'
import type { UsageStatsModelRow, UsageStatsDailyRow } from '../../db/hermes/usage-store'
import { getModelContextLength } from '../../services/hermes/model-context'
import { getActiveProfileName, listProfileNamesFromDisk } from '../../services/hermes/hermes-profile'
import { isPathWithin } from '../../services/hermes/hermes-path'
import { getGroupChatServer } from '../../routes/hermes/group-chat'
import { logger } from '../../services/logger'
import type { ConversationSummary } from '../../services/hermes/conversations'
import { listUserProfiles } from '../../db/hermes/users-store'

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

function requestedProfile(ctx: any): string | undefined {
  const value = ctx.state?.profile?.name || (typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : '')
  return value || undefined
}

function explicitProfileFilter(ctx: any): string | undefined {
  const value = typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : ''
  return value || undefined
}

function allowedProfileSet(ctx: any): Set<string> | null {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return null
  return new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
}

function canAccessProfile(ctx: any, profile: string | null | undefined): boolean {
  const allowed = allowedProfileSet(ctx)
  return !allowed || allowed.has(profile || 'default')
}

function filterByAllowedProfiles<T>(ctx: any, items: T[]): T[] {
  const allowed = allowedProfileSet(ctx)
  if (!allowed) return items
  return items.filter(item => allowed.has(((item as any).profile as string | null | undefined) || 'default'))
}

function denySessionAccess(ctx: any, session: any | null | undefined): boolean {
  if (!session || canAccessProfile(ctx, session.profile)) return false
  ctx.status = 403
  ctx.body = { error: `Profile "${session.profile || 'default'}" is not available for this user` }
  return true
}

interface HermesDeleteResult {
  attempted: boolean
  deleted: boolean
  profile?: string
  error?: string
}

function hasProfileOnDisk(profile: string): boolean {
  return listProfileNamesFromDisk().includes(profile || 'default')
}

async function deleteHermesSessionIfPresent(sessionId: string, profile?: string | null): Promise<HermesDeleteResult> {
  const targetProfile = profile || 'default'
  if (!hasProfileOnDisk(targetProfile)) {
    return { attempted: false, deleted: false, profile: targetProfile }
  }

  try {
    const hermesSession = await getExactSessionDetailFromDbWithProfile(sessionId, targetProfile)
    if (!hermesSession) {
      return { attempted: false, deleted: false, profile: targetProfile }
    }

    const deleted = await hermesCli.deleteSessionForProfile(sessionId, targetProfile)
    return {
      attempted: true,
      deleted,
      profile: targetProfile,
      error: deleted ? undefined : 'Failed to delete Hermes session',
    }
  } catch (err: any) {
    const message = err?.message || 'Failed to inspect Hermes session'
    logger.warn({ err, sessionId, profile: targetProfile }, 'Hermes Session: profile delete skipped')
    return { attempted: true, deleted: false, profile: targetProfile, error: message }
  }
}

export async function listConversations(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  const profile = explicitProfileFilter(ctx)
  const sessions = localListSessions(profile, source, limit && limit > 0 ? limit : 200)
  const summaries: ConversationSummary[] = sessions.map(s => ({
    id: s.id,
    profile: s.profile || null,
    source: s.source,
    model: s.model,
    provider: s.provider,
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
  ctx.body = { sessions: filterPendingDeletedConversationSummaries(filterByAllowedProfiles(ctx, summaries)) }
}

export async function getConversationMessages(ctx: any) {
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'

  const detail = localGetSessionDetail(ctx.params.id)
  if (!detail) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  if (denySessionAccess(ctx, detail)) return
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
  const profile = explicitProfileFilter(ctx)
  const effectiveLimit = limit && limit > 0 ? limit : 2000

  const allSessions = localListSessions(profile, source, effectiveLimit)
  const knownProfiles = profile ? null : new Set(listProfileNamesFromDisk())
  ctx.body = {
    sessions: filterPendingDeletedSessions(filterByAllowedProfiles(ctx, allSessions).filter(s =>
      (s.source === 'api_server' || s.source === 'cli') &&
      (!knownProfiles || knownProfiles.has(s.profile || 'default')),
    )),
  }
}

/**
 * List Hermes sessions only (exclude api_server source)
 * GET /api/hermes/sessions/hermes?source=&limit=
 */
export async function listHermesSessions(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = requestedProfile(ctx)
  const effectiveLimit = limit && limit > 0 ? limit : 2000

  const allSessions = (await listSessionSummaries(source, effectiveLimit, profile))
    .map(session => profile ? { ...session, profile } : session)
  ctx.body = { sessions: filterPendingDeletedSessions(filterByAllowedProfiles(ctx, allSessions).filter(s => s.source !== 'api_server')) }
}

export async function search(ctx: any) {
  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = explicitProfileFilter(ctx)
  const results = localSearchSessions(profile, q, limit && limit > 0 ? limit : 20)
  const knownProfiles = profile ? null : new Set(listProfileNamesFromDisk())
  ctx.body = {
    results: filterPendingDeletedSessions(filterByAllowedProfiles(ctx, results).filter(s =>
      !knownProfiles || knownProfiles.has(s.profile || 'default'),
    )),
  }
}

export async function get(ctx: any) {
  const session = localGetSessionDetail(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return
  ctx.body = { session }
}

/**
 * Get Hermes session detail only (exclude api_server source)
 * GET /api/hermes/sessions/hermes/:id
 */
export async function getHermesSession(ctx: any) {
  const profile = requestedProfile(ctx)

  // Prefer the Web UI local session store. Hermes state.db can lag behind or
  // miss messages for Bridge-backed runs, while the local store is the source
  // used by chat rendering and compression.
  const localSession = localGetSessionDetail(ctx.params.id)
  const localSessionProfile = (localSession?.profile || 'default') as string
  if (localSession && localSession.source !== 'api_server' && (!profile || localSessionProfile === profile)) {
    if (denySessionAccess(ctx, localSession)) return
    ctx.body = { session: localSession }
    return
  }

  // Try Hermes state.db next (consistent with listHermesSessions)
  try {
    const session = profile
      ? await getSessionDetailFromDbWithProfile(ctx.params.id, profile)
      : await getSessionDetailFromDb(ctx.params.id)
    if (session && session.source !== 'api_server') {
      const sessionWithProfile = profile ? { ...session, profile } : session
      if (denySessionAccess(ctx, sessionWithProfile)) return
      ctx.body = { session: sessionWithProfile }
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
  if (denySessionAccess(ctx, session)) return
  ctx.body = { session }
}

export async function remove(ctx: any) {
  const sessionId = ctx.params.id
  const existing = localGetSession(sessionId)
  if (denySessionAccess(ctx, existing)) return
  const hermesProfile = requestedProfile(ctx) || existing?.profile || getActiveProfileName()
  const hermes = await deleteHermesSessionIfPresent(sessionId, hermesProfile)
  const localDeleted = existing ? localDeleteSession(sessionId) : true
  if (!localDeleted) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  deleteUsage(sessionId)
  ctx.body = { ok: true, deleted: Boolean(existing), hermes }
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
    hermesDeleted: 0,
    hermesFailed: 0,
    errors: [] as Array<{ id: string; error: string }>,
    hermesErrors: [] as Array<{ id: string; profile?: string; error: string }>
  }

  for (const id of validIds) {
    const existing = localGetSession(id)
    if (existing && !canAccessProfile(ctx, existing.profile)) {
      results.failed++
      results.errors.push({ id, error: `Profile "${existing.profile || 'default'}" is not available for this user` })
      continue
    }
    const hermes = await deleteHermesSessionIfPresent(id, existing?.profile)
    if (hermes.deleted) {
      results.hermesDeleted++
    } else if (hermes.attempted && hermes.error) {
      results.hermesFailed++
      results.hermesErrors.push({ id, profile: hermes.profile, error: hermes.error })
    }

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
  const session = localGetSession(ctx.params.id)
  if (denySessionAccess(ctx, session)) return
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
  const existing = localGetSession(ctx.params.id)
  if (denySessionAccess(ctx, existing)) return
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
  const id = ctx.params.id
  const existing = getSession(id)
  if (denySessionAccess(ctx, existing)) return
  if (!existing) {
    createSession({ id, profile: requestedProfile(ctx) || 'default', title: '' })
  }
  updateSession(id, { workspace: workspace || null } as any)
  ctx.body = { ok: true }
}

export async function setModel(ctx: any) {
  const { model, provider } = ctx.request.body as { model?: string; provider?: string }
  if (!model || typeof model !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'model is required' }
    return
  }
  if (provider !== undefined && provider !== null && typeof provider !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'provider must be a string' }
    return
  }
  const { updateSession, getSession, createSession } = await import('../../db/hermes/session-store')
  const id = ctx.params.id
  const existing = getSession(id)
  if (denySessionAccess(ctx, existing)) return
  if (!existing) {
    createSession({ id, profile: requestedProfile(ctx) || 'default', title: '' })
  }
  updateSession(id, { model: model.trim(), provider: (provider || '').trim() } as any)
  ctx.body = { ok: true }
}

export async function contextLength(ctx: any) {
  const profile = requestedProfile(ctx)
  const model = typeof ctx.query.model === 'string' ? ctx.query.model : undefined
  const provider = typeof ctx.query.provider === 'string' ? ctx.query.provider : undefined
  ctx.body = { context_length: getModelContextLength({ profile, model, provider }) }
}

export async function usageStats(ctx: any) {
  const rawDays = parseInt(String(ctx.query?.days ?? '30'), 10)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30
  const profile = requestedProfile(ctx)

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
    hermes = profile ? await getUsageStatsFromDb(days, undefined, profile) : await getUsageStatsFromDb(days)
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
  if (!isPathWithin(fullPath, WORKSPACE_BASE)) {
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
  if (denySessionAccess(ctx, session)) return

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
  const profile = session.profile || getActiveProfileName()
  const upstream = ''
  const apiKey = undefined
  const messages = (session.messages || []).map((m: any) => ({
    role: m.role,
    content: m.content || '',
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.tool_name,
    reasoning_content: m.reasoning,
  }))

  return exportCompressor.compress(messages, upstream, apiKey, session.id, {
    profile,
    model: session.model,
    provider: session.provider,
  })
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
  if (denySessionAccess(ctx, result.session)) return

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
