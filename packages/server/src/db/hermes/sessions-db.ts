import { getActiveProfileDir, getProfileDir } from '../../services/hermes/hermes-profile'

const SQLITE_AVAILABLE = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 5)
})()

const COMPRESSION_END_REASONS = new Set(['compression', 'compressed'])
const SEARCH_CANDIDATE_MULTIPLIER = 20
const SEARCH_CANDIDATE_MIN = 100

export interface HermesSessionRow {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  preview: string
  last_active: number
}

export interface HermesSessionSearchRow extends HermesSessionRow {
  matched_message_id: number | null
  snippet: string
  rank: number
}

export interface HermesMessageRow {
  id: number | string
  session_id: string
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  reasoning_details?: string | null
  codex_reasoning_items?: string | null
  reasoning_content?: string | null
}

export interface HermesSessionDetailRow extends HermesSessionRow {
  messages: HermesMessageRow[]
  thread_session_count: number
}

interface HermesSessionInternalRow extends HermesSessionRow {
  parent_session_id: string | null
}

function sessionDbPath(): string {
  return `${getActiveProfileDir()}/state.db`
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (value == null || value === '') return fallback
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeNullableString(value: unknown): string | null {
  if (value == null || value === '') return null
  return String(value)
}

function mapRow(row: Record<string, unknown>): HermesSessionRow {
  const startedAt = normalizeNumber(row.started_at)
  const rawTitle = normalizeNullableString(row.title)
  const preview = String(row.preview || '')
  // Fallback: when no explicit title, use first user message as title (same as CLI path)
  const title = rawTitle || (preview ? (preview.length > 40 ? preview.slice(0, 40) + '...' : preview) : null)
  return {
    id: String(row.id || ''),
    source: String(row.source || ''),
    user_id: normalizeNullableString(row.user_id),
    model: String(row.model || ''),
    title,
    started_at: startedAt,
    ended_at: normalizeNullableNumber(row.ended_at),
    end_reason: normalizeNullableString(row.end_reason),
    message_count: normalizeNumber(row.message_count),
    tool_call_count: normalizeNumber(row.tool_call_count),
    input_tokens: normalizeNumber(row.input_tokens),
    output_tokens: normalizeNumber(row.output_tokens),
    cache_read_tokens: normalizeNumber(row.cache_read_tokens),
    cache_write_tokens: normalizeNumber(row.cache_write_tokens),
    reasoning_tokens: normalizeNumber(row.reasoning_tokens),
    billing_provider: normalizeNullableString(row.billing_provider),
    estimated_cost_usd: normalizeNumber(row.estimated_cost_usd),
    actual_cost_usd: normalizeNullableNumber(row.actual_cost_usd),
    cost_status: String(row.cost_status || ''),
    preview: String(row.preview || ''),
    last_active: normalizeNumber(row.last_active, startedAt),
  }
}

const SESSION_SELECT = `
  s.id,
  s.source,
  COALESCE(s.user_id, '') AS user_id,
  COALESCE(s.model, '') AS model,
  COALESCE(s.title, '') AS title,
  COALESCE(s.started_at, 0) AS started_at,
  s.ended_at AS ended_at,
  COALESCE(s.end_reason, '') AS end_reason,
  COALESCE(s.message_count, 0) AS message_count,
  COALESCE(s.tool_call_count, 0) AS tool_call_count,
  COALESCE(s.input_tokens, 0) AS input_tokens,
  COALESCE(s.output_tokens, 0) AS output_tokens,
  COALESCE(s.cache_read_tokens, 0) AS cache_read_tokens,
  COALESCE(s.cache_write_tokens, 0) AS cache_write_tokens,
  COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
  COALESCE(s.billing_provider, '') AS billing_provider,
  COALESCE(s.estimated_cost_usd, 0) AS estimated_cost_usd,
  s.actual_cost_usd AS actual_cost_usd,
  COALESCE(s.cost_status, '') AS cost_status,
  COALESCE(
    (
      SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 63)
      FROM messages m
      WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
      ORDER BY m.timestamp, m.id
      LIMIT 1
    ),
    ''
  ) AS preview,
  COALESCE((SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id), s.started_at) AS last_active
`

function containsCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x20000 && cp <= 0x2A6DF) ||
      (cp >= 0x3000 && cp <= 0x303F) ||
      (cp >= 0x3040 && cp <= 0x309F) ||
      (cp >= 0x30A0 && cp <= 0x30FF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF)
    ) {
      return true
    }
  }
  return false
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function buildLikePattern(value: string): string {
  return `%${escapeLikePattern(value)}%`
}

function normalizeTitleLikeQuery(query: string): string {
  const tokens = query.match(/"[^"]*"\*?|\S+/g)
  if (!tokens) return query

  const normalizedTokens = tokens
    .map((token) => {
      let value = token.endsWith('*') ? token.slice(0, -1) : token
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }
      return value
    })
    .filter(Boolean)

  return normalizedTokens.join(' ').trim() || query
}

function shouldUseLiteralContentSearch(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return false
  if (/[^\p{L}\p{N}\s"*.-]/u.test(trimmed)) return true

  const tokens = trimmed.match(/"[^"]*"\*?|\S+/g)
  if (!tokens) return true

  for (const token of tokens) {
    if (/^(AND|OR|NOT)$/i.test(token)) continue

    const raw = token.endsWith('*') ? token.slice(0, -1) : token
    if (!raw) return true

    if (raw.startsWith('"') && raw.endsWith('"')) {
      const inner = raw.slice(1, -1)
      if (!inner.trim()) return true
      if (!/^[\p{L}\p{N}\s.-]+$/u.test(inner)) return true
      if ((inner.includes('.') || inner.includes('-')) && !/^[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*(?:\s+[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*)*$/u.test(inner)) return true
      continue
    }

    if (raw.includes('.') || raw.includes('-')) {
      if (!/^[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*$/u.test(raw)) return true
      continue
    }

    if (!/^[\p{L}\p{N}]+$/u.test(raw)) return true
  }

  return false
}

function runLiteralContentSearch(
  db: { prepare: (sql: string) => { all: (...params: any[]) => Record<string, unknown>[] } },
  source: string | undefined,
  query: string,
  limit: number,
): Record<string, unknown>[] {
  const loweredQuery = query.toLowerCase()
  const likePattern = buildLikePattern(loweredQuery)
  const sourceClause = source ? 'AND s.source = ?' : ''
  const sourceParams = source ? [source] : []
  const likeSql = `
    WITH base AS (
      SELECT
        ${SESSION_SELECT},
        s.parent_session_id AS parent_session_id
      FROM sessions s
      WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
        ${sourceClause}
    )
    SELECT
      base.*,
      m.id AS matched_message_id,
      substr(
        m.content,
        max(1, instr(LOWER(m.content), ?) - 40),
        120
      ) AS snippet,
      0 AS rank
    FROM base
    JOIN messages m ON m.session_id = base.id
    WHERE LOWER(m.content) LIKE ? ESCAPE '\\'
    ORDER BY base.last_active DESC, m.timestamp DESC
    LIMIT ?
  `
  return db.prepare(likeSql).all(...sourceParams, loweredQuery, likePattern, limit) as Record<string, unknown>[]
}

function sanitizeFtsQuery(query: string): string {
  const quotedParts: string[] = []

  const preserved = query.replace(/"[^"]*"/g, (match) => {
    quotedParts.push(match)
    return `\u0000Q${quotedParts.length - 1}\u0000`
  })

  let sanitized = preserved.replace(/[+{}()"^]/g, ' ')
  sanitized = sanitized.replace(/\*+/g, '*')
  sanitized = sanitized.replace(/(^|\s)\*/g, '$1')
  sanitized = sanitized.trim().replace(/^(AND|OR|NOT)\b\s*/i, '')
  sanitized = sanitized.trim().replace(/\s+(AND|OR|NOT)\s*$/i, '')
  sanitized = sanitized.replace(/\b([\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)+)\b/gu, '"$1"')

  for (let i = 0; i < quotedParts.length; i += 1) {
    sanitized = sanitized.replace(`\u0000Q${i}\u0000`, quotedParts[i])
  }

  return sanitized.trim()
}

function toPrefixQuery(query: string): string {
  const tokens = query.match(/"[^"]*"\*?|\S+/g)
  if (!tokens) return ''
  return tokens
    .map((token) => {
      if (token === 'AND' || token === 'OR' || token === 'NOT') return token
      if (token.startsWith('"') && token.endsWith('"')) return token
      if (token.endsWith('*')) return token
      return `${token}*`
    })
    .join(' ')
}

function mapSearchRow(row: Record<string, unknown>): HermesSessionSearchRow {
  return {
    ...mapRow(row),
    matched_message_id: normalizeNullableNumber(row.matched_message_id),
    snippet: String(row.snippet || row.preview || ''),
    rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : 0,
  }
}

function mapInternalSessionRow(row: Record<string, unknown>): HermesSessionInternalRow {
  return {
    ...mapRow(row),
    parent_session_id: normalizeNullableString(row.parent_session_id),
  }
}

function parseToolCalls(value: unknown): any[] | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeMessageId(value: unknown): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  const asNumber = Number(value)
  if (Number.isInteger(asNumber)) return asNumber
  return String(value || '')
}

function mapMessageRow(row: Record<string, unknown>): HermesMessageRow {
  const reasoning = normalizeNullableString(row.reasoning) || normalizeNullableString(row.reasoning_content)
  return {
    id: normalizeMessageId(row.id),
    session_id: String(row.session_id || ''),
    role: String(row.role || ''),
    content: row.content == null ? '' : String(row.content),
    tool_call_id: normalizeNullableString(row.tool_call_id),
    tool_calls: parseToolCalls(row.tool_calls),
    tool_name: normalizeNullableString(row.tool_name),
    timestamp: normalizeNumber(row.timestamp),
    token_count: normalizeNullableNumber(row.token_count),
    finish_reason: normalizeNullableString(row.finish_reason),
    reasoning,
    reasoning_details: normalizeNullableString(row.reasoning_details),
    codex_reasoning_items: normalizeNullableString(row.codex_reasoning_items),
    reasoning_content: normalizeNullableString(row.reasoning_content),
  }
}

function isCompressionEnded(session: HermesSessionInternalRow | undefined): boolean {
  return !!session && COMPRESSION_END_REASONS.has(String(session.end_reason || ''))
}

function isCompressionContinuation(parent: HermesSessionInternalRow | undefined, child: HermesSessionInternalRow | undefined): boolean {
  if (!parent || !child || !isCompressionEnded(parent) || parent.ended_at == null) return false
  return child.source !== 'tool' && Number(child.started_at || 0) >= Number(parent.ended_at || 0)
}

function latestSessionInChain(chain: HermesSessionInternalRow[]): HermesSessionInternalRow {
  return chain.reduce((latest, session) => {
    const latestStarted = Number(latest.started_at || 0)
    const sessionStarted = Number(session.started_at || 0)
    if (sessionStarted !== latestStarted) return sessionStarted > latestStarted ? session : latest
    return session.id.localeCompare(latest.id) > 0 ? session : latest
  }, chain[0])
}

function projectSessionSummary(root: HermesSessionInternalRow, chain: HermesSessionInternalRow[]): HermesSessionRow {
  const latest = latestSessionInChain(chain)
  const { parent_session_id: _parentSessionId, ...rootRow } = root
  return {
    ...rootRow,
    id: latest.id,
    model: latest.model || root.model,
    title: latest.title || root.title,
    ended_at: latest.ended_at,
    end_reason: latest.end_reason,
    message_count: latest.message_count,
    tool_call_count: latest.tool_call_count,
    input_tokens: latest.input_tokens,
    output_tokens: latest.output_tokens,
    cache_read_tokens: latest.cache_read_tokens,
    cache_write_tokens: latest.cache_write_tokens,
    reasoning_tokens: latest.reasoning_tokens,
    billing_provider: latest.billing_provider ?? root.billing_provider,
    estimated_cost_usd: latest.estimated_cost_usd,
    actual_cost_usd: latest.actual_cost_usd,
    cost_status: latest.cost_status,
    preview: latest.preview || root.preview,
    last_active: latest.last_active || root.last_active,
  }
}

// --- In-memory session index for chain traversal ---

interface SessionIndex {
  byId: Map<string, HermesSessionInternalRow>
  childrenByParent: Map<string, string[]>
}

function loadAllSessions(db: { prepare: (sql: string) => { all: (...params: any[]) => Record<string, unknown>[] } }): SessionIndex {
  const rows = db.prepare(`
    SELECT
      ${SESSION_SELECT},
      s.parent_session_id AS parent_session_id
    FROM sessions s
    WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
  `).all() as Record<string, unknown>[]
  const sessions = rows.map(mapInternalSessionRow)
  const byId = new Map(sessions.map(s => [s.id, s]))
  const childrenByParent = new Map<string, string[]>()
  for (const s of sessions) {
    const key = s.parent_session_id ?? ''
    const list = childrenByParent.get(key) || []
    list.push(s.id)
    childrenByParent.set(key, list)
  }
  return { byId, childrenByParent }
}

function getLatestContinuationChild(
  parent: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow | null {
  if (!isCompressionEnded(parent) || parent.ended_at == null) return null
  const candidates = (idx.childrenByParent.get(parent.id) || [])
    .map(id => idx.byId.get(id))
    .filter((c): c is HermesSessionInternalRow => !!c)
    .filter(c => Number(c.started_at || 0) >= Number(parent.ended_at || 0))
    .sort((a, b) => {
      const aDelta = Number(a.started_at || 0) - Number(parent.ended_at || 0)
      const bDelta = Number(b.started_at || 0) - Number(parent.ended_at || 0)
      if (aDelta !== bDelta) return aDelta - bDelta
      return b.id.localeCompare(a.id)
    })
  return candidates[0] || null
}

function collectCompressionPath(
  session: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  const reversed: HermesSessionInternalRow[] = [session]
  const seen = new Set<string>()
  let current: HermesSessionInternalRow | null = session

  for (let depth = 0; current && current.parent_session_id && depth < 100 && !seen.has(current.id); depth += 1) {
    seen.add(current.id)
    const parent = idx.byId.get(current.parent_session_id)
    if (!parent || !isCompressionContinuation(parent, current)) break
    reversed.push(parent)
    current = parent
  }

  return reversed.reverse()
}

function extendCompressionChain(
  chain: HermesSessionInternalRow[],
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  const result = [...chain]
  const seen = new Set(result.map(s => s.id))
  let current: HermesSessionInternalRow | null = result[result.length - 1] || null

  for (let depth = 0; current && depth < 100; depth += 1) {
    const next = getLatestContinuationChild(current, idx)
    if (!next || seen.has(next.id)) break
    result.push(next)
    seen.add(next.id)
    current = next
  }

  return result
}

function collectSessionChain(
  root: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  return extendCompressionChain([root], idx)
}

function collectSessionChainForMatchedSession(
  session: HermesSessionInternalRow,
  idx: SessionIndex,
): HermesSessionInternalRow[] {
  return extendCompressionChain(collectCompressionPath(session, idx), idx)
}

type SessionDbLike = {
  prepare: (sql: string) => { all: (...params: any[]) => Record<string, unknown>[] }
}

function searchCandidateLimit(limit: number): number {
  return Math.max(limit * SEARCH_CANDIDATE_MULTIPLIER, SEARCH_CANDIDATE_MIN)
}

function projectSearchRow(
  row: Record<string, unknown>,
  idx: SessionIndex,
  source?: string,
): HermesSessionSearchRow | null {
  const matchedSession = mapInternalSessionRow(row)
  if (!matchedSession.id) return null

  const chain = collectSessionChainForMatchedSession(matchedSession, idx)
  const root = chain[0]
  if (!root) return null
  if (source && matchedSession.source !== source) return null

  const projected = projectSessionSummary(root, chain)
  return {
    ...projected,
    matched_message_id: normalizeNullableNumber(row.matched_message_id),
    snippet: String(row.snippet || row.preview || ''),
    rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : 0,
  }
}

function aggregateSessionDetail(
  chain: HermesSessionInternalRow[],
  messages: HermesMessageRow[],
  requestedSessionId: string,
): HermesSessionDetailRow {
  const root = chain[0]
  const latest = latestSessionInChain(chain)
  const costStatuses = Array.from(new Set(chain.map(session => String(session.cost_status || '')).filter(Boolean)))
  const actualCosts = chain
    .map(session => session.actual_cost_usd)
    .filter((value): value is number => value != null)
  const firstPreview = chain.map(session => session.preview).find(Boolean) || root.preview

  const { parent_session_id: _parentSessionId, ...rootRow } = root

  return {
    ...rootRow,
    id: requestedSessionId,
    source: latest.source || root.source,
    title: latest.title || root.title || (firstPreview ? (firstPreview.length > 40 ? `${firstPreview.slice(0, 40)}...` : firstPreview) : null),
    preview: latest.preview || root.preview || firstPreview || '',
    model: latest.model || root.model,
    ended_at: latest.ended_at,
    end_reason: latest.end_reason,
    last_active: Math.max(...chain.map(session => session.last_active || session.started_at || 0)),
    message_count: chain.reduce((sum, session) => sum + Number(session.message_count || 0), 0),
    tool_call_count: chain.reduce((sum, session) => sum + Number(session.tool_call_count || 0), 0),
    input_tokens: chain.reduce((sum, session) => sum + Number(session.input_tokens || 0), 0),
    output_tokens: chain.reduce((sum, session) => sum + Number(session.output_tokens || 0), 0),
    cache_read_tokens: chain.reduce((sum, session) => sum + Number(session.cache_read_tokens || 0), 0),
    cache_write_tokens: chain.reduce((sum, session) => sum + Number(session.cache_write_tokens || 0), 0),
    reasoning_tokens: chain.reduce((sum, session) => sum + Number(session.reasoning_tokens || 0), 0),
    billing_provider: latest.billing_provider ?? root.billing_provider,
    estimated_cost_usd: chain.reduce((sum, session) => sum + Number(session.estimated_cost_usd || 0), 0),
    actual_cost_usd: actualCosts.length ? actualCosts.reduce((sum, value) => sum + Number(value || 0), 0) : null,
    cost_status: costStatuses.length === 1 ? costStatuses[0] : (costStatuses.length > 1 ? 'mixed' : ''),
    messages,
    thread_session_count: chain.length,
  }
}

async function openSessionDb() {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = sessionDbPath()
  console.log(`[sessions-db] Opening session db: ${dbPath}`)
  try {
    return new DatabaseSync(dbPath, { open: true, readOnly: true })
  } catch (err: any) {
    console.error(`[sessions-db] Failed to open session db at ${dbPath}:`, err.message)
    throw err
  }
}

/**
 * Lightweight alternative: get messages + session row for a single session ID
 * without chain traversal. Used by syncFromHermes for ephemeral sessions.
 */
export async function getSessionMessagesFromDb(sessionId: string): Promise<{
  messages: HermesMessageRow[]
  session: HermesSessionRow | null
} | null> {
  const db = await openSessionDb()
  try {
    const sessionRow = db.prepare(`
      SELECT ${SESSION_SELECT}
      FROM sessions s
      WHERE s.id = ?
    `).get(sessionId) as Record<string, unknown> | undefined

    const messageRows = db.prepare(`
      SELECT
        id, session_id, role, content, tool_call_id, tool_calls, tool_name,
        timestamp, token_count, finish_reason, reasoning, reasoning_details,
        codex_reasoning_items, reasoning_content
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp, id
    `).all(sessionId) as Record<string, unknown>[]

    return {
      messages: messageRows.map(mapMessageRow),
      session: sessionRow ? mapRow(sessionRow) : null,
    }
  } finally {
    db.close()
  }
}

export async function getSessionDetailFromDb(sessionId: string): Promise<HermesSessionDetailRow | null> {
  const db = await openSessionDb()
  try {
    const idx = loadAllSessions(db)
    const requested = idx.byId.get(sessionId) || null
    if (!requested) return null

    const chain = collectSessionChainForMatchedSession(requested, idx)
    if (!chain.length) return null

    const ids = chain.map(session => session.id)
    const placeholders = ids.map(() => '?').join(', ')
    const messageRows = db.prepare(`
      SELECT
        id,
        session_id,
        role,
        content,
        tool_call_id,
        tool_calls,
        tool_name,
        timestamp,
        token_count,
        finish_reason,
        reasoning,
        reasoning_details,
        codex_reasoning_items,
        reasoning_content
      FROM messages
      WHERE session_id IN (${placeholders})
      ORDER BY timestamp, id
    `).all(...ids) as Record<string, unknown>[]
    const messages = messageRows.map(mapMessageRow)
    return aggregateSessionDetail(chain, messages, sessionId)
  } finally {
    db.close()
  }
}

export async function getSessionDetailFromDbWithProfile(sessionId: string, profile: string): Promise<HermesSessionDetailRow | null> {
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = `${getProfileDir(profile)}/state.db`
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  try {
    const idx = loadAllSessions(db)
    const requested = idx.byId.get(sessionId) || null
    if (!requested) return null

    const chain = collectSessionChainForMatchedSession(requested, idx)
    if (!chain.length) return null

    const ids = chain.map(session => session.id)
    const placeholders = ids.map(() => '?').join(', ')
    const messageRows = db.prepare(`
      SELECT
        id,
        session_id,
        role,
        content,
        tool_call_id,
        tool_calls,
        tool_name,
        timestamp,
        token_count,
        finish_reason,
        reasoning,
        reasoning_details,
        codex_reasoning_items,
        reasoning_content
      FROM messages
      WHERE session_id IN (${placeholders})
      ORDER BY timestamp, id
    `).all(...ids) as Record<string, unknown>[]
    const messages = messageRows.map(mapMessageRow)
    return aggregateSessionDetail(chain, messages, sessionId)
  } finally {
    db.close()
  }
}

export async function listSessionSummaries(source?: string, limit = 2000): Promise<HermesSessionRow[]> {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(sessionDbPath(), { open: true, readOnly: true })

  try {
    const clauses = ["s.parent_session_id IS NULL", "s.source != 'tool'", "s.id NOT LIKE 'compress_%'"]
    const params: any[] = []
    if (source) {
      clauses.push('s.source = ?')
      params.push(source)
    }
    params.push(Math.max(limit * 4, limit))

    const rawRows = db.prepare(`
      SELECT
        ${SESSION_SELECT},
        s.parent_session_id AS parent_session_id
      FROM sessions s
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[] | undefined
    const roots = (Array.isArray(rawRows) ? rawRows : []).map(mapInternalSessionRow)

    const idx = loadAllSessions(db)
    return roots
      .map(root => projectSessionSummary(root, collectSessionChain(root, idx)))
      .sort((a, b) => Number(b.last_active || b.started_at || 0) - Number(a.last_active || a.started_at || 0))
      .slice(0, limit)
  } finally {
    db.close()
  }
}

export async function searchSessionSummaries(
  query: string,
  source?: string,
  limit = 20,
): Promise<HermesSessionSearchRow[]> {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const trimmed = query.trim()
  if (!trimmed) {
    const recent = await listSessionSummaries(source, limit)
    return recent.map(row => ({
      ...row,
      matched_message_id: null,
      snippet: row.preview,
      rank: 0,
    }))
  }

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(sessionDbPath(), { open: true, readOnly: true })
  const normalized = sanitizeFtsQuery(trimmed)
  const prefixQuery = toPrefixQuery(normalized)
  const titlePattern = buildLikePattern(normalizeTitleLikeQuery(trimmed).toLowerCase())
  const useLiteralContentSearch = containsCjk(trimmed) || shouldUseLiteralContentSearch(trimmed)
  const candidateLimit = searchCandidateLimit(limit)
  let titleRows: Record<string, unknown>[] = []

  try {
    const sourceClause = source ? 'AND s.source = ?' : ''
    const sourceParams = source ? [source] : []
    const allSessionsBaseSql = `
      SELECT
        ${SESSION_SELECT},
        s.parent_session_id AS parent_session_id
      FROM sessions s
      WHERE s.source != 'tool' AND s.id NOT LIKE 'compress_%'
        ${sourceClause}
    `

    const titleSql = `
      WITH base AS (
        ${allSessionsBaseSql}
      )
      SELECT
        base.*,
        NULL AS matched_message_id,
        CASE
          WHEN base.title IS NOT NULL AND base.title != '' THEN base.title
          ELSE base.preview
        END AS snippet,
        0 AS rank
      FROM base
      WHERE LOWER(COALESCE(base.title, '')) LIKE ? ESCAPE '\\'
      ORDER BY base.last_active DESC
      LIMIT ?
    `

    const titleStatement = db.prepare(titleSql)
    titleRows = titleStatement.all(...sourceParams, titlePattern, candidateLimit) as Record<string, unknown>[]

    const contentSql = `
      WITH base AS (
        ${allSessionsBaseSql}
      )
      SELECT
        base.*,
        m.id AS matched_message_id,
        snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
        bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN base ON base.id = m.session_id
      WHERE messages_fts MATCH ?
      ORDER BY rank, base.last_active DESC
      LIMIT ?
    `

    const contentRows = useLiteralContentSearch
      ? runLiteralContentSearch(db, source, trimmed, candidateLimit)
      : prefixQuery
        ? (db.prepare(contentSql).all(...sourceParams, prefixQuery, candidateLimit) as Record<string, unknown>[])
        : []

    const idx = loadAllSessions(db)
    const merged = new Map<string, HermesSessionSearchRow>()
    for (const row of titleRows) {
      const mapped = projectSearchRow(row, idx, source)
      if (mapped) merged.set(mapped.id, mapped)
    }
    for (const row of contentRows) {
      const mapped = projectSearchRow(row, idx, source)
      if (mapped && !merged.has(mapped.id)) {
        merged.set(mapped.id, mapped)
      }
    }

    const items = [...merged.values()]
    items.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return b.last_active - a.last_active
    })
    return items.slice(0, limit)
  } catch (_err) {
    // FTS queries can fail for various inputs (pure numbers, special syntax, etc.)
    // Fall back to title-only LIKE results + literal content search for CJK
    const likeRows = containsCjk(normalized)
      ? runLiteralContentSearch(db, source, trimmed, candidateLimit)
      : []
    const idx2 = loadAllSessions(db)
    const merged = new Map<string, HermesSessionSearchRow>()
    for (const row of titleRows) {
      const mapped = projectSearchRow(row, idx2, source)
      if (mapped) merged.set(mapped.id, mapped)
    }
    for (const row of likeRows) {
      const mapped = projectSearchRow(row, idx2, source)
      if (mapped && !merged.has(mapped.id)) {
        merged.set(mapped.id, mapped)
      }
    }
    const items = [...merged.values()]
    items.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return b.last_active - a.last_active
    })
    return items.slice(0, limit)
  } finally {
    db.close()
  }
}
