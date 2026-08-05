import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_EKKO_LOG_MAX_BYTES } from '../config'

export type EkkoLogCategory =
  | 'run'
  | 'model'
  | 'tool'
  | 'context'
  | 'skill'
  | 'memory'
  | 'system'

export type EkkoLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface EkkoLogEntry {
  category: EkkoLogCategory
  event: string
  level?: EkkoLogLevel
  profile?: string
  sessionId?: string
  runId?: string
  turnId?: string
  data?: unknown
}

export interface EkkoFileLoggerOptions {
  directory: string
  maxBytes?: number
  now?: () => Date
}

export interface EkkoFileLogReaderOptions {
  directory: string
}

export interface EkkoLogWriter {
  write(entry: EkkoLogEntry): boolean
}

export interface EkkoLogRecord {
  timestamp: string
  level: EkkoLogLevel
  category: EkkoLogCategory
  event: string
  profile?: string
  sessionId?: string
  runId?: string
  turnId?: string
  data?: unknown
}

export interface EkkoLogQuery {
  sessionId?: string
  runId?: string
  turnId?: string
  category?: EkkoLogCategory
  level?: EkkoLogLevel
  event?: string
  text?: string
  after?: string | Date
  before?: string | Date
  limit?: number
}

export const EKKO_LOG_FILE_NAME = 'ekko-agent.jsonl'
const MAX_LOG_STRING_CHARS = 8_192
const MAX_LOG_ARRAY_ITEMS = 100
const MAX_LOG_OBJECT_KEYS = 100
const MAX_LOG_DEPTH = 8

/**
 * Append-only structured logger for one Ekko profile.
 *
 * It intentionally owns one file only. When the file would exceed maxBytes,
 * the old content is discarded and logging continues from the current event.
 */
export class EkkoFileLogger implements EkkoLogWriter {
  readonly filePath: string
  readonly maxBytes: number
  private readonly now: () => Date

  constructor(options: EkkoFileLoggerOptions) {
    this.filePath = join(options.directory, EKKO_LOG_FILE_NAME)
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_EKKO_LOG_MAX_BYTES)
    this.now = options.now ?? (() => new Date())
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  }

  write(entry: EkkoLogEntry): boolean {
    try {
      let line = this.line(entry)
      let lineBytes = Buffer.byteLength(line)
      if (lineBytes > this.maxBytes) {
        line = this.line({
          ...entry,
          data: {
            omitted: true,
            reason: 'event_exceeded_log_size_limit',
            originalBytes: lineBytes,
          },
        })
        lineBytes = Buffer.byteLength(line)
        if (lineBytes > this.maxBytes) {
          writeFileSync(this.filePath, '', { encoding: 'utf8', mode: 0o600 })
          return false
        }
      }
      const currentBytes = fileSize(this.filePath)
      if (currentBytes + lineBytes > this.maxBytes) {
        const reset = this.line({
          category: 'system',
          event: 'log.size_limit_reset',
          level: 'warn',
          profile: entry.profile,
          sessionId: entry.sessionId,
          runId: entry.runId,
          turnId: entry.turnId,
          data: {
            discardedBytes: currentBytes,
            maxBytes: this.maxBytes,
          },
        })
        const resetAndEntry = Buffer.byteLength(reset) + lineBytes <= this.maxBytes
          ? `${reset}${line}`
          : line
        writeFileSync(this.filePath, resetAndEntry, { encoding: 'utf8', mode: 0o600 })
        return true
      }
      appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  query(query: EkkoLogQuery = {}): EkkoLogRecord[] {
    return queryEkkoLogFile(this.filePath, query)
  }

  private line(entry: EkkoLogEntry): string {
    const record = {
      timestamp: this.now().toISOString(),
      level: entry.level ?? 'info',
      category: entry.category,
      event: sanitizeString(entry.event),
      ...(entry.profile ? { profile: sanitizeString(entry.profile) } : {}),
      ...(entry.sessionId ? { sessionId: sanitizeString(entry.sessionId) } : {}),
      ...(entry.runId ? { runId: sanitizeString(entry.runId) } : {}),
      ...(entry.turnId ? { turnId: sanitizeString(entry.turnId) } : {}),
      ...(entry.data === undefined ? {} : { data: sanitizeLogValue(entry.data) }),
    }
    return `${JSON.stringify(record)}\n`
  }
}

/**
 * Read-only view over one Ekko profile log.
 *
 * Unlike EkkoFileLogger, constructing a reader never creates directories or
 * files. Hosts can expose log queries without acquiring write ownership.
 */
export class EkkoFileLogReader {
  readonly filePath: string

  constructor(options: EkkoFileLogReaderOptions) {
    this.filePath = join(options.directory, EKKO_LOG_FILE_NAME)
  }

  query(query: EkkoLogQuery = {}): EkkoLogRecord[] {
    return queryEkkoLogFile(this.filePath, query)
  }
}

export function queryEkkoLogFile(filePath: string, query: EkkoLogQuery = {}): EkkoLogRecord[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }

  const after = timestampValue(query.after)
  const before = timestampValue(query.before)
  const textQuery = String(query.text || '').trim().toLowerCase()
  const records: EkkoLogRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: EkkoLogRecord
    try {
      record = JSON.parse(line) as EkkoLogRecord
    } catch {
      continue
    }
    if (!isLogRecord(record)) continue
    if (query.sessionId && record.sessionId !== query.sessionId) continue
    if (query.runId && record.runId !== query.runId) continue
    if (query.turnId && record.turnId !== query.turnId) continue
    if (query.category && record.category !== query.category) continue
    if (query.level && record.level !== query.level) continue
    if (query.event && record.event !== query.event) continue
    const timestamp = Date.parse(record.timestamp)
    if (after != null && (!Number.isFinite(timestamp) || timestamp < after)) continue
    if (before != null && (!Number.isFinite(timestamp) || timestamp > before)) continue
    if (textQuery && !line.toLowerCase().includes(textQuery)) continue
    records.push(record)
  }

  const limit = positiveInteger(query.limit, 0)
  return limit > 0 && records.length > limit ? records.slice(-limit) : records
}

export function sanitizeLogValue(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>())
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return value.toString()
  if (depth >= MAX_LOG_DEPTH) return '[max depth]'
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    }
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map(item => sanitizeValue(item, depth + 1, seen))
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_LOG_ARRAY_ITEMS} more items]`)
    }
    return items
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
    result[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : sanitizeValue(item, depth + 1, seen)
  }
  if (entries.length > MAX_LOG_OBJECT_KEYS) {
    result.__truncatedKeys = entries.length - MAX_LOG_OBJECT_KEYS
  }
  return result
}

function sanitizeString(value: string): string {
  if (/^data:[^;,]+;base64,/i.test(value)) {
    return `[base64 data omitted: ${value.length} chars]`
  }
  let sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b((?:API_?KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|SECRET)\s*=\s*)("[^"]*"|'[^']*'|[^\s;]+)/gi, '$1[REDACTED]')
  if (sanitized.length > MAX_LOG_STRING_CHARS) {
    sanitized = `${sanitized.slice(0, MAX_LOG_STRING_CHARS)}…[truncated ${sanitized.length - MAX_LOG_STRING_CHARS} chars]`
  }
  return sanitized
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, '_')
  return normalized === 'authorization' ||
    normalized === 'proxy_authorization' ||
    normalized === 'api_key' ||
    normalized === 'apikey' ||
    normalized === 'token' ||
    normalized.endsWith('_token') ||
    normalized === 'access_token' ||
    normalized === 'refresh_token' ||
    normalized === 'secret' ||
    normalized === 'client_secret' ||
    normalized === 'password' ||
    normalized === 'cookie' ||
    normalized === 'set_cookie'
}

function fileSize(path: string): number {
  if (!existsSync(path)) return 0
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function timestampValue(value: string | Date | undefined): number | null {
  if (!value) return null
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function isLogRecord(value: EkkoLogRecord): boolean {
  return Boolean(
    value &&
    typeof value.timestamp === 'string' &&
    typeof value.level === 'string' &&
    typeof value.category === 'string' &&
    typeof value.event === 'string',
  )
}
