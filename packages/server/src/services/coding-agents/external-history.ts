import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export type ExternalHistoryAgent = 'claude' | 'codex'

export interface ExternalHistoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface ExternalHistorySession {
  agent: ExternalHistoryAgent
  nativeSessionId: string
  sourcePath: string
  workspace: string | null
  title: string
  startedAt: number
  lastActive: number
  messages: ExternalHistoryMessage[]
}

export interface ExternalHistoryRoots {
  claudeProjectsDir?: string
  codexSessionsDir?: string
}

interface ParsedHistoryFileCacheEntry {
  mtimeMs: number
  size: number
  session: ExternalHistorySession | null
}

const parsedHistoryFileCache = new Map<string, ParsedHistoryFileCacheEntry>()

function parseJsonLines(text: string): Record<string, any>[] {
  const records: Record<string, any>[] = []
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value)
    } catch {
      // Native session files can contain a partial final line while a CLI is running.
    }
  }
  return records
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeText(item))
      .filter(Boolean)
      .join('\n')
  }
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string' || Array.isArray(record.content)) return normalizeText(record.content)
  return ''
}

function normalizeClaudeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return normalizeText(value)
  return value
    .map(item => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      if (record.type && record.type !== 'text' && record.type !== 'input_text' && record.type !== 'output_text') return ''
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function timestampSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value > 10_000_000_000 ? value / 1000 : value)
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return 0
}

function sessionBounds(messages: ExternalHistoryMessage[], fallback: number): { startedAt: number; lastActive: number } {
  const timestamps = messages.map(message => message.timestamp).filter(timestamp => timestamp > 0)
  const startedAt = timestamps.length > 0 ? Math.min(...timestamps) : fallback
  const lastActive = timestamps.length > 0 ? Math.max(...timestamps) : fallback
  return { startedAt, lastActive }
}

function makeSession(
  agent: ExternalHistoryAgent,
  nativeSessionId: string,
  sourcePath: string,
  workspace: string | null,
  title: string,
  fallbackTimestamp: number,
  messages: ExternalHistoryMessage[],
): ExternalHistorySession | null {
  const normalizedId = nativeSessionId.trim()
  if (!normalizedId) return null
  const bounds = sessionBounds(messages, fallbackTimestamp)
  return {
    agent,
    nativeSessionId: normalizedId,
    sourcePath,
    workspace: workspace?.trim() || null,
    title: title.trim() || `${agent} session`,
    startedAt: bounds.startedAt,
    lastActive: bounds.lastActive,
    messages,
  }
}

export function parseClaudeHistoryText(text: string, sourcePath = ''): ExternalHistorySession | null {
  const messages: ExternalHistoryMessage[] = []
  let nativeSessionId = ''
  let workspace: string | null = null
  let fallbackTimestamp = 0
  let latestTimestamp = 0

  for (const record of parseJsonLines(text)) {
    if (record.isSidechain === true) continue
    nativeSessionId ||= String(record.sessionId || record.message?.session_id || '').trim()
    workspace ||= typeof record.cwd === 'string' ? record.cwd : null
    const timestamp = timestampSeconds(record.timestamp)
    if (timestamp > 0 && (fallbackTimestamp === 0 || timestamp < fallbackTimestamp)) fallbackTimestamp = timestamp
    if (timestamp > latestTimestamp) latestTimestamp = timestamp

    const role = record.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = normalizeClaudeText(record.message?.content)
    if (!content.trim()) continue
    messages.push({ role, content, timestamp })
  }

  const session = makeSession(
    'claude',
    nativeSessionId,
    sourcePath,
    workspace,
    messages.find(message => message.role === 'user')?.content || '',
    fallbackTimestamp,
    messages,
  )
  if (session && latestTimestamp > session.lastActive) session.lastActive = latestTimestamp
  return session
}

export function parseCodexHistoryText(text: string, sourcePath = ''): ExternalHistorySession | null {
  const messages: ExternalHistoryMessage[] = []
  let nativeSessionId = ''
  let workspace: string | null = null
  let fallbackTimestamp = 0
  let latestTimestamp = 0

  for (const record of parseJsonLines(text)) {
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, any>
      : null
    if (!payload) continue

    const timestamp = timestampSeconds(record.timestamp || payload.timestamp)
    if (timestamp > 0 && (fallbackTimestamp === 0 || timestamp < fallbackTimestamp)) fallbackTimestamp = timestamp
    if (timestamp > latestTimestamp) latestTimestamp = timestamp
    if (payload.type === 'session_meta') {
      nativeSessionId ||= String(payload.id || '').trim()
      workspace ||= typeof payload.cwd === 'string' ? payload.cwd : null
      continue
    }

    let role: 'user' | 'assistant' | null = null
    let content: unknown = null
    if (payload.type === 'user_message') {
      role = 'user'
      content = payload.message
    } else if (payload.type === 'agent_message') {
      role = 'assistant'
      content = payload.message
    } else if (payload.type === 'response_item' && (payload.role === 'user' || payload.role === 'assistant')) {
      role = payload.role
      content = payload.content ?? payload.message
    }
    if (!role) continue

    const normalizedContent = normalizeText(content)
    if (!normalizedContent.trim()) continue
    messages.push({ role, content: normalizedContent, timestamp })
  }

  if (!nativeSessionId) {
    const fileName = basename(sourcePath)
    const match = fileName.match(/-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/iu)
    nativeSessionId = match?.[1] || ''
  }

  const session = makeSession(
    'codex',
    nativeSessionId,
    sourcePath,
    workspace,
    messages.find(message => message.role === 'user')?.content || '',
    fallbackTimestamp,
    messages,
  )
  if (session && latestTimestamp > session.lastActive) session.lastActive = latestTimestamp
  return session
}

export function externalSessionId(agent: ExternalHistoryAgent, nativeSessionId: string, profile = 'default'): string {
  const digest = createHash('sha256').update(`${profile}:${agent}:${nativeSessionId}`).digest('hex').slice(0, 32)
  return `external_${agent}_${digest}`
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        files.push(fullPath)
      }
    }
  }
  await visit(resolve(root))
  return files
}

async function parseExternalHistoryFile(
  agent: ExternalHistoryAgent,
  sourcePath: string,
): Promise<ExternalHistorySession | null> {
  let fileStats
  try {
    fileStats = await stat(sourcePath)
  } catch {
    return null
  }

  const cached = parsedHistoryFileCache.get(sourcePath)
  if (cached && cached.mtimeMs === fileStats.mtimeMs && cached.size === fileStats.size) {
    return cached.session
  }

  let text
  try {
    text = await readFile(sourcePath, 'utf8')
  } catch {
    return null
  }
  const session = agent === 'claude'
    ? parseClaudeHistoryText(text, sourcePath)
    : parseCodexHistoryText(text, sourcePath)
  parsedHistoryFileCache.set(sourcePath, { mtimeMs: fileStats.mtimeMs, size: fileStats.size, session })
  return session
}

export async function discoverExternalCodingAgentHistory(
  roots: ExternalHistoryRoots = {},
): Promise<ExternalHistorySession[]> {
  const claudeRoot = roots.claudeProjectsDir || join(homedir(), '.claude', 'projects')
  const codexRoot = roots.codexSessionsDir || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  const [claudeFiles, codexFiles] = await Promise.all([
    collectJsonlFiles(claudeRoot),
    collectJsonlFiles(codexRoot),
  ])
  const discoveredPaths = new Set([...claudeFiles, ...codexFiles])
  for (const sourcePath of parsedHistoryFileCache.keys()) {
    if (!discoveredPaths.has(sourcePath)) parsedHistoryFileCache.delete(sourcePath)
  }
  const sessions = new Map<string, ExternalHistorySession>()

  const agentFiles: Array<[ExternalHistoryAgent, string[]]> = [
    ['claude', claudeFiles],
    ['codex', codexFiles],
  ]
  for (const [agent, files] of agentFiles) {
    for (const sourcePath of files) {
      const session = await parseExternalHistoryFile(agent, sourcePath)
      if (!session) continue
      const key = `${session.agent}:${session.nativeSessionId}`
      const existing = sessions.get(key)
      if (!existing || session.lastActive >= existing.lastActive) sessions.set(key, session)
    }
  }

  return [...sessions.values()].sort((a, b) => b.lastActive - a.lastActive)
}
