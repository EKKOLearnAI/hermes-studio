import * as hermesCli from '../../services/hermes/hermes-cli'
import { listConversationSummaries, getConversationDetail } from '../../services/hermes/conversations'
import { listConversationSummariesFromDb, getConversationDetailFromDb } from '../../db/hermes/conversations-db'
import { listSessionSummaries, searchSessionSummaries } from '../../db/hermes/sessions-db'
import {
  listSessions as localListSessions,
  searchSessions as localSearchSessions,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
  useLocalSessionStore,
} from '../../db/hermes/session-store'
import { deleteUsage, getUsage, getUsageBatch, getLocalUsageStats } from '../../db/hermes/usage-store'
import type { LocalUsageStats, UsageStatsModelRow, UsageStatsDailyRow } from '../../db/hermes/usage-store'
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
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  if (useLocalSessionStore()) {
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
      is_active: s.ended_at == null && (Date.now() / 1000 - s.last_active) <= 300,
      thread_session_count: 1,
    }))
    ctx.body = { sessions: filterPendingDeletedConversationSummaries(summaries) }
    return
  }

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
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'

  if (useLocalSessionStore()) {
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
    return
  }

  try {
    const detail = await getConversationDetailFromDb(ctx.params.id, { source, humanOnly })
    if (!detail) {
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
  if (!detail) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  ctx.body = detail
}

export async function list(ctx: any) {
  if (useLocalSessionStore()) {
    const source = (ctx.query.source as string) || undefined
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
    const profile = getActiveProfileName()
    const sessions = localListSessions(profile, source, limit && limit > 0 ? limit : 2000)
    ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
    return
  }

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
  if (useLocalSessionStore()) {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
    const profile = getActiveProfileName()
    const results = localSearchSessions(profile, q, limit && limit > 0 ? limit : 20)
    ctx.body = { results: filterPendingDeletedSessions(results) }
    return
  }

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
  if (useLocalSessionStore()) {
    const session = localGetSessionDetail(ctx.params.id)
    if (!session) {
      ctx.status = 404
      ctx.body = { error: 'Session not found' }
      return
    }
    ctx.body = { session }
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
  if (useLocalSessionStore()) {
    const sessionId = ctx.params.id
    const ok = localDeleteSession(sessionId)
    if (!ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete session' }
      return
    }
    deleteUsage(sessionId)
    ctx.body = { ok: true }
    return
  }

  const sessionId = ctx.params.id
  const ok = await hermesCli.deleteSession(sessionId)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  deleteUsage(sessionId)
  ctx.body = { ok: true }
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
  if (useLocalSessionStore()) {
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
    return
  }

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

export async function usageStats(ctx: any) {
  // Get current active profile
  const currentProfile = getActiveProfileName()

  // 1. Local session_usage (web UI chat runs) - filtered by current profile
  const local = getLocalUsageStats(currentProfile)

  // 2. Hermes state.db sessions (exclude api_server source)
  let hermesSessions: Array<{
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    started_at: number
    estimated_cost_usd: number
    actual_cost_usd: number | null
  }> = []

  try {
    const allSessions = await listSessionSummaries(undefined, 100000)
    // Only include sessions from current profile
    // Note: Hermes sessions don't have profile field, so we include all
    // This could be improved in the future by filtering by some criteria
    hermesSessions = allSessions.filter(s => s.source !== 'api_server')
  } catch (err) {
    logger.warn(err, 'usageStats: failed to load Hermes sessions')
  }

  // Aggregate Hermes sessions
  const hModelMap = new Map<string, UsageStatsModelRow>()
  const hDayMap = new Map<string, UsageStatsDailyRow>()
  let hInput = 0, hOutput = 0, hCacheRead = 0, hCacheWrite = 0, hReasoning = 0, hSessions = 0, hCost = 0

  for (const s of hermesSessions) {
    const iTokens = s.input_tokens || 0
    const oTokens = s.output_tokens || 0
    const crTokens = s.cache_read_tokens || 0
    const cwTokens = s.cache_write_tokens || 0
    const rTokens = s.reasoning_tokens || 0
    const cost = s.actual_cost_usd ?? s.estimated_cost_usd ?? 0
    const model = s.model || ''

    hInput += iTokens; hOutput += oTokens; hCacheRead += crTokens
    hCacheWrite += cwTokens; hReasoning += rTokens; hCost += cost
    hSessions++

    // By model
    const me = hModelMap.get(model) || { model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 0 }
    me.input_tokens += iTokens; me.output_tokens += oTokens; me.cache_read_tokens += crTokens
    me.cache_write_tokens += cwTokens; me.reasoning_tokens += rTokens; me.sessions++
    hModelMap.set(model, me)

    // By day (last 30 days)
    const d = new Date(s.started_at * 1000)
    const key = d.toISOString().slice(0, 10)
    if (d.getTime() > Date.now() - 30 * 24 * 60 * 60 * 1000) {
      const de = hDayMap.get(key) || { date: key, tokens: 0, cache: 0, sessions: 0, cost: 0 }
      de.tokens += iTokens + oTokens; de.cache += crTokens; de.sessions++; de.cost += cost
      hDayMap.set(key, de)
    }
  }

  // Merge local + Hermes
  const totalInput = local.input_tokens + hInput
  const totalOutput = local.output_tokens + hOutput
  const totalCacheRead = local.cache_read_tokens + hCacheRead
  const totalCacheWrite = local.cache_write_tokens + hCacheWrite
  const totalReasoning = local.reasoning_tokens + hReasoning
  const totalSessions = local.sessions + hSessions
  const totalCost = hCost // local has no cost data

  // Merge by_model
  const modelMap = new Map<string, UsageStatsModelRow>()
  for (const m of [...local.by_model, ...hModelMap.values()].filter(m => m.model)) {
    const existing = modelMap.get(m.model)
    if (existing) {
      existing.input_tokens += m.input_tokens; existing.output_tokens += m.output_tokens
      existing.cache_read_tokens += m.cache_read_tokens; existing.cache_write_tokens += m.cache_write_tokens
      existing.reasoning_tokens += m.reasoning_tokens; existing.sessions += m.sessions
    } else {
      modelMap.set(m.model, { ...m })
    }
  }

  // Merge by_day
  const dayMap = new Map<string, UsageStatsDailyRow>()
  // Initialize last 30 days
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    dayMap.set(key, { date: key, tokens: 0, cache: 0, sessions: 0, cost: 0 })
  }
  for (const d of [...local.by_day, ...hDayMap.values()]) {
    const existing = dayMap.get(d.date)
    if (existing) {
      existing.tokens += d.tokens; existing.cache += d.cache; existing.sessions += d.sessions; existing.cost += d.cost
    }
  }

  ctx.body = {
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_read_tokens: totalCacheRead,
    total_cache_write_tokens: totalCacheWrite,
    total_reasoning_tokens: totalReasoning,
    total_sessions: totalSessions,
    total_cost: totalCost,
    model_usage: [...modelMap.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
    daily_usage: [...dayMap.values()],
  }
}
