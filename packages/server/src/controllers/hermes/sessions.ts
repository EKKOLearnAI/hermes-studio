import * as hermesCli from '../../services/hermes/hermes-cli'
import { listSessionSummaries, getUsageStatsFromDb, getSessionDetailFromDb, getSessionDetailFromDbWithProfile, getSessionDetailPaginatedFromDbWithProfile, getExactSessionDetailFromDbWithProfile } from '../../db/hermes/sessions-db'
import {
  listSessions as localListSessions,
  searchSessions as localSearchSessions,
  getSession as localGetSession,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
  createSession as localCreateSession,
  addMessages as localAddMessages,
  updateSession as localUpdateSession,
  updateSessionStats as localUpdateSessionStats,
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
import { readConfigYamlForProfile } from '../../services/config-helpers'
import { codingAgentRunManager } from '../../services/agent-runner/coding-agent-run-manager'
import { AgentBridgeClient, getAgentBridgeManager } from '../../services/hermes/agent-bridge'
import { ensureHermesRunWorkspace } from '../../services/hermes/run-chat/workspace'

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

function runtimeProvider(provider: string): string {
  return provider === 'claude-oauth' ? 'anthropic' : provider
}

async function notifyBridgeSessionModelChanged(
  sessionId: string,
  model: string,
  provider: string,
  profile?: string,
): Promise<void> {
  try {
    const manager = getAgentBridgeManager()
    const state = manager.getRuntimeState()
    if (!state.ready || !state.running) return
    const bridge = new AgentBridgeClient({
      endpoint: state.endpoint,
      timeoutMs: 5000,
      connectRetryMs: 0,
    })
    await bridge.switchSessionModel(sessionId, model, runtimeProvider(provider), profile)
  } catch (err) {
    logger.warn(err, '[sessions] failed to notify bridge of session model change')
  }
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

function isVisibleWebUiSessionSource(source?: string | null): boolean {
  return source === 'api_server' || source === 'cli' || source === 'coding_agent' || source === 'global_agent'
}

function isRequestedSessionSource(source: string | undefined, sessionSource?: string | null): boolean {
  if (source === 'global_agent') return sessionSource === 'global_agent'
  if (source === 'workflow') return sessionSource === 'workflow'
  return isVisibleWebUiSessionSource(sessionSource)
}

function isHermesHistorySessionSource(source?: string | null): boolean {
  return source !== 'api_server' && source !== 'global_agent' && source !== 'workflow'
}

function isCodingAgentSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null } | null): boolean {
  return session?.source === 'coding_agent' ||
    session?.agent === 'claude' ||
    session?.agent === 'codex' ||
    Boolean(session?.agent_session_id)
}

interface HermesDeleteResult {
  attempted: boolean
  deleted: boolean
  profile?: string
  error?: string
}

interface BatchDeleteTarget {
  id: string
  profile?: string | null
}

interface ProfileDefaultModel {
  model: string
  provider: string
}

interface LocalImportMessage {
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
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

async function getProfileDefaultModel(profile: string): Promise<ProfileDefaultModel> {
  try {
    const config = await readConfigYamlForProfile(profile)
    const modelSection = config?.model
    if (modelSection && typeof modelSection === 'object' && !Array.isArray(modelSection)) {
      return {
        model: String(modelSection.default || '').trim(),
        provider: String(modelSection.provider || '').trim(),
      }
    }
    if (typeof modelSection === 'string') {
      return { model: modelSection.trim(), provider: '' }
    }
  } catch (err) {
    logger.warn({ err, profile }, 'Hermes Session: failed to read profile default model for import')
  }
  return { model: '', provider: '' }
}

function normalizeImportText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeImportNullableText(value: unknown): string | null {
  const text = normalizeImportText(value)
  return text ? text : null
}

function normalizeImportToolCalls(value: unknown): any[] | null {
  if (!Array.isArray(value)) return null
  const calls = value
    .map((call: any) => {
      const id = String(call?.id || '').trim()
      const fn = call?.function && typeof call.function === 'object' ? call.function : {}
      const name = String(fn.name || call?.name || '').trim()
      if (!id || !name) return null
      const rawArgs = fn.arguments ?? call?.arguments ?? {}
      const args = typeof rawArgs === 'string' ? rawArgs : normalizeImportText(rawArgs || {})
      return {
        id,
        type: String(call?.type || 'function'),
        function: { name, arguments: args || '{}' },
      }
    })
    .filter((call): call is { id: string; type: string; function: { name: string; arguments: string } } => Boolean(call))
  return calls.length > 0 ? calls : null
}

function buildImportMessages(sessionId: string, messages: any[]): LocalImportMessage[] {
  const result: LocalImportMessage[] = []
  const knownToolCallIds = new Set<string>()

  for (const message of messages) {
    const role = String(message?.role || '').trim()
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue

    const toolCalls = role === 'assistant' ? normalizeImportToolCalls(message.tool_calls) : null
    if (toolCalls) {
      for (const call of toolCalls) knownToolCallIds.add(call.id)
    }

    if (role === 'tool') {
      const callId = String(message?.tool_call_id || '').trim()
      if (!callId || !knownToolCallIds.has(callId)) continue
      result.push({
        session_id: sessionId,
        role,
        content: normalizeImportText(message?.content),
        tool_call_id: callId,
        tool_calls: null,
        tool_name: normalizeImportNullableText(message?.tool_name),
        timestamp: Number(message?.timestamp || 0),
        token_count: message?.token_count == null ? null : Number(message.token_count),
        finish_reason: normalizeImportNullableText(message?.finish_reason),
        reasoning: null,
        reasoning_details: null,
        reasoning_content: null,
      })
      continue
    }

    const content = normalizeImportText(message?.content)
    if (role === 'assistant' && !content.trim() && !toolCalls) continue

    result.push({
      session_id: sessionId,
      role,
      content,
      tool_call_id: null,
      tool_calls: toolCalls,
      tool_name: null,
      timestamp: Number(message?.timestamp || 0),
      token_count: message?.token_count == null ? null : Number(message.token_count),
      finish_reason: normalizeImportNullableText(message?.finish_reason),
      reasoning: role === 'assistant' ? normalizeImportNullableText(message?.reasoning) : null,
      reasoning_details: role === 'assistant' ? normalizeImportNullableText(message?.reasoning_details) : null,
      reasoning_content: role === 'assistant' ? normalizeImportNullableText(message?.reasoning_content) : null,
    })
  }

  return result
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
    agent: s.agent,
    agent_mode: s.agent_mode,
    agent_session_id: s.agent_session_id,
    agent_native_session_id: s.agent_native_session_id,
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
  const messages = (detail.messages || [])
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
      isRequestedSessionSource(source, s.source) &&
      (!knownProfiles || knownProfiles.has(s.profile || 'default')),
    )),
  }
}

export async function count(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const profile = explicitProfileFilter(ctx)
  const allSessions = localListSessions(profile, source, 2147483647)
  const knownProfiles = profile ? null : new Set(listProfileNamesFromDisk())
  const sessions = filterPendingDeletedSessions(filterByAllowedProfiles(ctx, allSessions).filter(s =>
    isRequestedSessionSource(source, s.source) &&
    (!knownProfiles || knownProfiles.has(s.profile || 'default')),
  ))
  ctx.body = { count: sessions.length }
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

  const importedIds = new Set(localListSessions(profile, undefined, effectiveLimit).map(session => session.id))
  const allSessions = (await listSessionSummaries(source, effectiveLimit, profile))
    .map(session => ({
      ...(profile ? { ...session, profile } : session),
      webui_imported: importedIds.has(session.id),
    }))
  ctx.body = { sessions: filterPendingDeletedSessions(filterByAllowedProfiles(ctx, allSessions).filter(s => isHermesHistorySessionSource(s.source))) }
}

export async function search(ctx: any) {
  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const profile = explicitProfileFilter(ctx)
  const results = localSearchSessions(profile, q, limit && limit > 0 ? limit : 20)
  const knownProfiles = profile ? null : new Set(listProfileNamesFromDisk())
  ctx.body = {
    results: filterPendingDeletedSessions(filterByAllowedProfiles(ctx, results).filter(s =>
      isRequestedSessionSource(source, s.source) &&
      (!knownProfiles || knownProfiles.has(s.profile || 'default')),
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

function cleanSessionContextMessages(messages: any[]): Array<{
  id: number
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  reasoning?: string | null
  reasoning_content?: string | null
}> {
  return messages
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .map(message => {
      const content = typeof message.content === 'string'
        ? message.content
        : message.content == null ? '' : String(message.content)
      return {
        id: Number(message.id || 0),
        role: message.role,
        content,
        timestamp: Number(message.timestamp || 0),
        ...(message.reasoning != null ? { reasoning: message.reasoning } : {}),
        ...(message.reasoning_content != null ? { reasoning_content: message.reasoning_content } : {}),
      }
    })
    .filter(message => {
      if (message.role === 'user') return true
      return message.content.trim() || message.reasoning || message.reasoning_content
    })
}

export async function getContext(ctx: any) {
  const session = localGetSessionDetail(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return

  const messages = cleanSessionContextMessages(session.messages || [])
  ctx.body = {
    session_id: session.id,
    profile: session.profile || null,
    source: session.source,
    title: session.title || null,
    messages,
    message_count: messages.length,
  }
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
  if (localSession && isHermesHistorySessionSource(localSession.source) && (!profile || localSessionProfile === profile)) {
    if (denySessionAccess(ctx, localSession)) return
    ctx.body = { session: localSession }
    return
  }

  // Try Hermes state.db next (consistent with listHermesSessions)
  try {
    const session = profile
      ? await getSessionDetailFromDbWithProfile(ctx.params.id, profile)
      : await getSessionDetailFromDb(ctx.params.id)
    if (session && isHermesHistorySessionSource(session.source)) {
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
  // Filter out Web UI-only session sources.
  if (!isHermesHistorySessionSource(session.source)) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (denySessionAccess(ctx, session)) return
  ctx.body = { session }
}

export async function importHermesSession(ctx: any) {
  const sessionId = ctx.params.id
  const profile = requestedProfile(ctx) || getActiveProfileName()
  if (!canAccessProfile(ctx, profile)) {
    ctx.status = 403
    ctx.body = { error: `Profile "${profile || 'default'}" is not available for this user` }
    return
  }

  const existing = localGetSessionDetail(sessionId)
  if (existing) {
    ctx.body = { ok: true, imported: false, session: existing }
    return
  }

  let detail
  try {
    detail = await getSessionDetailFromDbWithProfile(sessionId, profile)
  } catch (err) {
    logger.warn({ err, sessionId, profile }, 'Hermes Session: import query failed')
    ctx.status = 500
    ctx.body = { error: 'Failed to read Hermes session' }
    return
  }

  if (!detail || detail.source === 'api_server') {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  const profileDefault = await getProfileDefaultModel(profile)
  const importTimestamp = Math.floor(Date.now() / 1000)

  localCreateSession({
    id: detail.id,
    profile,
    source: 'cli',
    model: profileDefault.model,
    provider: profileDefault.provider,
    title: detail.title || undefined,
  })

  localUpdateSession(detail.id, {
    source: 'cli',
    user_id: detail.user_id,
    model: profileDefault.model,
    provider: profileDefault.provider,
    title: detail.title,
    started_at: detail.started_at,
    ended_at: detail.ended_at,
    end_reason: detail.end_reason,
    message_count: detail.message_count,
    tool_call_count: detail.tool_call_count,
    input_tokens: detail.input_tokens,
    output_tokens: detail.output_tokens,
    cache_read_tokens: detail.cache_read_tokens,
    cache_write_tokens: detail.cache_write_tokens,
    reasoning_tokens: detail.reasoning_tokens,
    billing_provider: detail.billing_provider,
    estimated_cost_usd: detail.estimated_cost_usd,
    actual_cost_usd: detail.actual_cost_usd,
    cost_status: detail.cost_status,
    preview: detail.preview,
    last_active: importTimestamp,
  })

  const importMessages = buildImportMessages(detail.id, Array.isArray(detail.messages) ? detail.messages : [])
  localAddMessages(importMessages)
  localUpdateSessionStats(detail.id)
  localUpdateSession(detail.id, {
    tool_call_count: detail.tool_call_count,
    input_tokens: detail.input_tokens,
    output_tokens: detail.output_tokens,
    cache_read_tokens: detail.cache_read_tokens,
    cache_write_tokens: detail.cache_write_tokens,
    reasoning_tokens: detail.reasoning_tokens,
    billing_provider: detail.billing_provider,
    estimated_cost_usd: detail.estimated_cost_usd,
    actual_cost_usd: detail.actual_cost_usd,
    cost_status: detail.cost_status,
    last_active: importTimestamp,
    ended_at: detail.ended_at,
  })

  ctx.body = { ok: true, imported: true, session: localGetSessionDetail(detail.id) }
}

export async function remove(ctx: any) {
  const sessionId = ctx.params.id
  const existing = localGetSession(sessionId)
  if (denySessionAccess(ctx, existing)) return
  const hermesProfile = requestedProfile(ctx) || existing?.profile || getActiveProfileName()
  const codingAgentSession = isCodingAgentSession(existing)
  if (codingAgentSession) codingAgentRunManager.stop(sessionId, { reportClosed: false })
  const hermes = codingAgentSession
    ? { attempted: false, deleted: false, profile: hermesProfile }
    : await deleteHermesSessionIfPresent(sessionId, hermesProfile)
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
  const { ids, sessions } = ctx.request.body as { ids?: string[]; sessions?: BatchDeleteTarget[] }
  const rawTargets = Array.isArray(sessions) && sessions.length > 0 ? sessions : ids
  if (!rawTargets || !Array.isArray(rawTargets) || rawTargets.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'ids is required and must be a non-empty array' }
    return
  }

  const targets = rawTargets
    .map((target): BatchDeleteTarget | null => {
      if (typeof target === 'string') {
        const id = target.trim()
        return id ? { id } : null
      }
      if (!target || typeof target.id !== 'string') return null
      const id = target.id.trim()
      if (!id) return null
      const profile = typeof target.profile === 'string' && target.profile.trim()
        ? target.profile.trim()
        : undefined
      return { id, profile }
    })
    .filter((target): target is BatchDeleteTarget => Boolean(target))

  if (targets.length === 0) {
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

  for (const target of targets) {
    const { id } = target
    const existing = localGetSession(id)
    const targetProfile = target.profile || existing?.profile
    if (targetProfile && !canAccessProfile(ctx, targetProfile)) {
      results.failed++
      results.errors.push({ id, error: `Profile "${targetProfile || 'default'}" is not available for this user` })
      continue
    }
    if (!targetProfile && existing && !canAccessProfile(ctx, existing.profile)) {
      results.failed++
      results.errors.push({ id, error: `Profile "${existing.profile || 'default'}" is not available for this user` })
      continue
    }

    const codingAgentSession = isCodingAgentSession(existing)
    if (codingAgentSession) codingAgentRunManager.stop(id, { reportClosed: false })
    const hermes = codingAgentSession
      ? { attempted: false, deleted: false, profile: targetProfile || 'default' }
      : await deleteHermesSessionIfPresent(id, targetProfile)
    if (hermes.deleted) {
      results.hermesDeleted++
    } else if (hermes.attempted && hermes.error) {
      results.hermesFailed++
      results.hermesErrors.push({ id, profile: hermes.profile, error: hermes.error })
    }

    const shouldDeleteLocal = Boolean(existing && (!targetProfile || existing.profile === targetProfile))
    if (shouldDeleteLocal) {
      const ok = localDeleteSession(id)
      if (ok) {
        deleteUsage(id)
        results.deleted++
      } else {
        results.failed++
        results.errors.push({ id, error: 'Failed to delete session' })
      }
    } else if (hermes.deleted) {
      results.deleted++
    } else {
      results.failed++
      results.errors.push({ id, error: 'Session not found' })
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
  const profile = existing?.profile || requestedProfile(ctx) || 'default'
  const cleanModel = model.trim()
  const cleanProvider = (provider || '').trim()
  const codingAgentSession = isCodingAgentSession(existing)
  const workspace = !codingAgentSession
    ? await ensureHermesRunWorkspace(profile, existing?.workspace)
    : undefined
  if (!existing) {
    createSession({ id, profile, title: '', model: cleanModel, provider: cleanProvider, workspace })
  }
  const updates: Record<string, string> = { model: cleanModel, provider: cleanProvider }
  if (!codingAgentSession && existing && !existing.workspace && workspace) updates.workspace = workspace
  if (
    codingAgentSession &&
    existing &&
    (existing.model !== cleanModel || existing.provider !== cleanProvider)
  ) {
    updates.agent_native_session_id = ''
  }
  updateSession(id, updates as any)
  if (!codingAgentSession) {
    await notifyBridgeSessionModelChanged(id, cleanModel, cleanProvider, profile)
  }
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
 * Base: current user's home directory (overridable via WORKSPACE_BASE env)
 */
export async function listWorkspaceFolders(ctx: any) {
  const { resolve, join } = await import('path')
  const { readdir } = await import('fs/promises')
  const { existsSync } = await import('fs')
  const { homedir } = await import('os')

  const WORKSPACE_BASE = process.env.WORKSPACE_BASE?.trim() || homedir()
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

function invalidWorkspaceFolderName(name: string): boolean {
  return !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
}

async function resolveWorkspaceFolderPath(ctx: any, inputPath: string) {
  const { resolve, join } = await import('path')
  const { homedir } = await import('os')
  const WORKSPACE_BASE = process.env.WORKSPACE_BASE?.trim() || homedir()
  const fullPath = resolve(join(WORKSPACE_BASE, inputPath || ''))
  if (!isPathWithin(fullPath, WORKSPACE_BASE)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return null
  }
  return { base: WORKSPACE_BASE, fullPath }
}

export async function createWorkspaceFolder(ctx: any) {
  const { join } = await import('path')
  const { mkdir } = await import('fs/promises')
  const { parentPath, name } = ctx.request.body as { parentPath?: string; name?: string }
  const folderName = String(name || '').trim()
  if (invalidWorkspaceFolderName(folderName)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid folder name' }
    return
  }

  const resolvedParent = await resolveWorkspaceFolderPath(ctx, String(parentPath || ''))
  if (!resolvedParent) return
  const targetPath = join(resolvedParent.fullPath, folderName)
  if (!isPathWithin(targetPath, resolvedParent.base)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  try {
    await mkdir(targetPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = err?.code === 'EEXIST' ? 409 : 500
    ctx.body = { error: err.message || 'Failed to create folder' }
  }
}

export async function renameWorkspaceFolder(ctx: any) {
  const { dirname, join } = await import('path')
  const { rename, stat } = await import('fs/promises')
  const { path, name } = ctx.request.body as { path?: string; name?: string }
  const folderName = String(name || '').trim()
  const currentPath = String(path || '').trim()
  if (!currentPath) {
    ctx.status = 400
    ctx.body = { error: 'Path is required' }
    return
  }
  if (invalidWorkspaceFolderName(folderName)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid folder name' }
    return
  }

  const resolvedCurrent = await resolveWorkspaceFolderPath(ctx, currentPath)
  if (!resolvedCurrent) return
  const parentPath = dirname(resolvedCurrent.fullPath)
  const targetPath = join(parentPath, folderName)
  if (!isPathWithin(targetPath, resolvedCurrent.base)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  try {
    const info = await stat(resolvedCurrent.fullPath)
    if (!info.isDirectory()) {
      ctx.status = 400
      ctx.body = { error: 'Path is not a directory' }
      return
    }
    await rename(resolvedCurrent.fullPath, targetPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = err?.code === 'EEXIST' ? 409 : err?.code === 'ENOENT' ? 404 : 500
    ctx.body = { error: err.message || 'Failed to rename folder' }
  }
}

export async function deleteWorkspaceFolder(ctx: any) {
  const { rm, stat } = await import('fs/promises')
  const { path } = ctx.request.body as { path?: string }
  const currentPath = String(path || '').trim()
  if (!currentPath) {
    ctx.status = 400
    ctx.body = { error: 'Path is required' }
    return
  }

  const resolvedCurrent = await resolveWorkspaceFolderPath(ctx, currentPath)
  if (!resolvedCurrent) return
  if (resolvedCurrent.fullPath === resolvedCurrent.base) {
    ctx.status = 400
    ctx.body = { error: 'Cannot delete workspace root' }
    return
  }

  try {
    const info = await stat(resolvedCurrent.fullPath)
    if (!info.isDirectory()) {
      ctx.status = 400
      ctx.body = { error: 'Path is not a directory' }
      return
    }
    await rm(resolvedCurrent.fullPath, { recursive: true })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = err?.code === 'ENOENT' ? 404 : 500
    ctx.body = { error: err.message || 'Failed to delete folder' }
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
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : 150
  const profile = requestedProfile(ctx)

  const { getSessionDetailPaginated } = await import('../../db/hermes/session-store')
  const localResult = getSessionDetailPaginated(ctx.params.id, offset, limit)
  const result = localResult && (!profile || localResult.session.profile === profile)
    ? localResult
    : await getSessionDetailPaginatedFromDbWithProfile(ctx.params.id, profile || 'default', offset, limit)

  if (!result) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  const session = { ...result.session, profile: (result.session as any).profile || profile || 'default' }
  if (denySessionAccess(ctx, session)) return

  ctx.body = {
    session: {
      id: session.id,
      profile: session.profile,
      source: session.source,
      model: session.model,
      title: session.title,
      parent_session_id: (session as any).parent_session_id,
      fork_point_message_id: (session as any).fork_point_message_id,
      parent_title: (session as any).parent_title,
      parent_last_message: (session as any).parent_last_message,
      parent_last_message_role: (session as any).parent_last_message_role,
      started_at: session.started_at,
      ended_at: session.ended_at,
      last_active: session.last_active,
      message_count: session.message_count,
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
    },
    messages: result.messages,
    total: result.total,
    offset: result.offset,
    limit: result.limit,
    hasMore: result.hasMore,
  }
}
