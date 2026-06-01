import { ref } from 'vue'
import { auditQuantLabAction, type QuantLabTerminalActionType } from '@/api/hermes/quant-lab'

export type TerminalActionType = QuantLabTerminalActionType
export type TerminalActionStatus = 'accepted' | 'rejected'

export interface TerminalAction {
  id: string
  type: TerminalActionType
  payload: Record<string, unknown>
  timestamp: number
  source: string
  messageId?: string
}

export interface TerminalActionAuditEntry {
  id: string
  type: string
  payload: Record<string, unknown>
  raw?: string
  source: string
  messageId?: string
  status: TerminalActionStatus
  reason?: string
  timestamp: number
}

interface TerminalActionMeta {
  source?: string
  messageId?: string
  raw?: string
}

const TERMINAL_ACTION_TYPES: TerminalActionType[] = [
  'DRAW_LINE',
  'CHANGE_TICKER',
  'SIMULATE_TRADE',
  'ADD_JOURNAL',
  'SET_ALERT',
]

export const TERMINAL_ACTION_SPEC = `
<ACTION>{"type":"DRAW_LINE","ticker":"NVDA","price":420,"label":"STOP","reason":"20MA risk line"}</ACTION>
<ACTION>{"type":"CHANGE_TICKER","ticker":"AVGO","reason":"User asked to focus the setup"}</ACTION>
<ACTION>{"type":"SIMULATE_TRADE","ticker":"NVDA","side":"BUY","reason":"Paper-trade candidate only"}</ACTION>
<ACTION>{"type":"ADD_JOURNAL","ticker":"NVDA","action":"WATCH","note":"AI observed a setup but risk is still elevated"}</ACTION>
<ACTION>{"type":"SET_ALERT","ticker":"QQQ","condition":"below 20MA","price":520,"note":"Pause new paper buys if triggered"}</ACTION>
`.trim()

const latestAction = ref<TerminalAction | null>(null)
const actionAuditLog = ref<TerminalActionAuditEntry[]>([])
const SENSITIVE_KEY_RE = /(secret|token|password|passwd|api[_-]?key|key[_-]?id|chat[_-]?id|allowed[_-]chat|allowed[_-]user)/i

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeTicker(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isTerminalActionType(value: unknown): value is TerminalActionType {
  return typeof value === 'string' && TERMINAL_ACTION_TYPES.includes(value as TerminalActionType)
}

function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '已遮蔽'
  return `••••${value.slice(-4)}`
}

function redactSensitiveText(value: unknown): string {
  return String(value ?? '')
    .replace(/(apiKey=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:ALPACA|APCA|POLYGON|TELEGRAM)[A-Z0-9_]*(?:KEY|SECRET|TOKEN|CHAT_ID|USERS|IDS)\s*=\s*)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:ALPACA|APCA|POLYGON|TELEGRAM)[A-Z0-9_]*(?:KEY|SECRET|TOKEN|CHAT_ID|USERS|IDS)["']?\s*[:=]\s*["']?)[^"',\s<>]+/gi, '$1[redacted]')
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s"'<>]+/gi, 'https://api.telegram.org/bot[redacted]')
    .replace(/\bPK[A-Z0-9]{12,}\b/g, match => maskSecret(match))
}

function scrubPayload(value: unknown, keyHint = '', depth = 0): unknown {
  if (depth > 5) return '[redacted-depth]'
  if (typeof value === 'string') return SENSITIVE_KEY_RE.test(keyHint) ? maskSecret(value) : redactSensitiveText(value)
  if (Array.isArray(value)) return value.map(item => scrubPayload(item, '', depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? maskSecret(String(nested ?? '')) : scrubPayload(nested, key, depth + 1),
    ]))
  }
  return value
}

function validatePayload(type: TerminalActionType, payload: Record<string, unknown>): string | null {
  if (type === 'DRAW_LINE') {
    return numberOrNull(payload.price) === null ? 'DRAW_LINE requires numeric price.' : null
  }
  if (type === 'CHANGE_TICKER') {
    return normalizeTicker(payload.ticker) ? null : 'CHANGE_TICKER requires ticker.'
  }
  if (type === 'SIMULATE_TRADE') {
    return normalizeTicker(payload.ticker) ? null : 'SIMULATE_TRADE requires ticker.'
  }
  if (type === 'ADD_JOURNAL') {
    return typeof payload.note === 'string' && payload.note.trim() ? null : 'ADD_JOURNAL requires note.'
  }
  if (type === 'SET_ALERT') {
    const hasCondition = typeof payload.condition === 'string' && payload.condition.trim()
    const hasNote = typeof payload.note === 'string' && payload.note.trim()
    const hasPrice = numberOrNull(payload.price) !== null
    return hasCondition || hasNote || hasPrice ? null : 'SET_ALERT requires condition, note, or price.'
  }
  return 'Unsupported action type.'
}

function normalizePayload(type: TerminalActionType, payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload }
  const ticker = normalizeTicker(normalized.ticker)
  if (ticker) normalized.ticker = ticker

  if ('price' in normalized) {
    const price = numberOrNull(normalized.price)
    if (price !== null) normalized.price = price
  }

  if (type === 'SIMULATE_TRADE') {
    const side = String(normalized.side || normalized.action || 'MARK').trim().toUpperCase()
    normalized.side = ['BUY', 'SELL', 'MARK', 'WATCH'].includes(side) ? side : 'MARK'
  }

  if (type === 'ADD_JOURNAL') {
    const action = String(normalized.action || 'WATCH').trim().toUpperCase()
    normalized.action = ['BUY', 'SELL', 'HOLD', 'WATCH', 'MARK', 'RESET'].includes(action) ? action : 'WATCH'
    normalized.note = String(normalized.note || '').trim().slice(0, 800)
  }

  if (type === 'SET_ALERT') {
    normalized.condition = String(normalized.condition || '').trim().slice(0, 180)
    normalized.note = String(normalized.note || normalized.reason || '').trim().slice(0, 500)
  }

  return normalized
}

function pushAudit(entry: TerminalActionAuditEntry) {
  const safeEntry: TerminalActionAuditEntry = {
    ...entry,
    payload: scrubPayload(entry.payload) as Record<string, unknown>,
    raw: entry.raw ? redactSensitiveText(entry.raw) : undefined,
    reason: entry.reason ? redactSensitiveText(entry.reason) : undefined,
  }
  actionAuditLog.value = [safeEntry, ...actionAuditLog.value].slice(0, 80)
  auditQuantLabAction({
    type: safeEntry.type,
    payload: safeEntry.payload,
    raw: safeEntry.raw,
    source: safeEntry.source,
    messageId: safeEntry.messageId,
    status: safeEntry.status,
    reason: safeEntry.reason,
  }).catch((err) => {
    console.warn('[Terminal Action] audit persistence failed:', err)
  })
}

export function stripTerminalActionBlocks(content: string, hidePartialPrefix = false): string {
  const visible = content.replace(/<ACTION>[\s\S]*?(<\/ACTION>|$)/g, '')
  if (!hidePartialPrefix) return visible

  const actionPrefix = '<ACTION>'
  for (let length = actionPrefix.length - 1; length > 0; length -= 1) {
    const partial = actionPrefix.slice(0, length)
    if (visible.endsWith(partial)) {
      return visible.slice(0, -length)
    }
  }

  return visible
}

export function extractTerminalActionBlocks(content: string): string[] {
  const blocks: string[] = []
  const actionRegex = /<ACTION>([\s\S]*?)<\/ACTION>/g
  let match: RegExpExecArray | null

  while ((match = actionRegex.exec(content)) !== null) {
    const raw = match[1]?.trim()
    if (raw) blocks.push(raw)
  }

  return blocks
}

export function parseTerminalActionBlock(raw: string): { type?: TerminalActionType; payload: Record<string, unknown>; reason?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { payload: {}, reason: 'ACTION block must contain valid JSON.' }
  }

  if (!isRecord(parsed)) return { payload: {}, reason: 'ACTION JSON must be an object.' }
  if (!isTerminalActionType(parsed.type)) return { payload: parsed, reason: `Unsupported ACTION type: ${String(parsed.type || 'missing')}.` }

  const { type, payload: nestedPayload, ...rest } = parsed
  const mergedPayload = {
    ...rest,
    ...(isRecord(nestedPayload) ? nestedPayload : {}),
  }
  const normalizedPayload = normalizePayload(type, mergedPayload)
  const validationReason = validatePayload(type, normalizedPayload)

  return {
    type,
    payload: normalizedPayload,
    reason: validationReason || undefined,
  }
}

export function useTerminalActions() {
  function dispatchAction(type: TerminalActionType, payload: Record<string, unknown>, meta: TerminalActionMeta = {}) {
    const normalizedPayload = normalizePayload(type, payload)
    const reason = validatePayload(type, normalizedPayload)
    const timestamp = Date.now()
    const id = uid()
    const auditEntry: TerminalActionAuditEntry = {
      id,
      type,
      payload: normalizedPayload,
      raw: meta.raw,
      source: meta.source || 'ui',
      messageId: meta.messageId,
      status: reason ? 'rejected' : 'accepted',
      reason: reason || undefined,
      timestamp,
    }

    pushAudit(auditEntry)
    if (reason) return auditEntry

    latestAction.value = {
      id,
      type,
      payload: normalizedPayload,
      timestamp,
      source: auditEntry.source,
      messageId: meta.messageId,
    }

    return auditEntry
  }

  function dispatchRawTerminalAction(raw: string, meta: TerminalActionMeta = {}) {
    const parsed = parseTerminalActionBlock(raw)
    if (!parsed.type) {
      const entry: TerminalActionAuditEntry = {
        id: uid(),
        type: 'INVALID',
        payload: parsed.payload,
        raw,
        source: meta.source || 'assistant-stream',
        messageId: meta.messageId,
        status: 'rejected',
        reason: parsed.reason || 'Invalid ACTION block.',
        timestamp: Date.now(),
      }
      pushAudit(entry)
      return entry
    }

    return dispatchAction(parsed.type, parsed.payload, { ...meta, raw })
  }

  return {
    latestAction,
    actionAuditLog,
    dispatchAction,
    dispatchRawTerminalAction,
  }
}
