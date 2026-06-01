import Router from '@koa/router'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { config } from '../../config'

export const auroraIntentAuditRoutes = new Router()

type AuroraIntentAuditStatus =
  | 'fallback'
  | 'approval_required'
  | 'approval_queued'
  | 'approval_approved'
  | 'approval_rejected'
  | 'approval_expired'
  | 'completed'
  | 'app_opened'
  | 'rejected'
  | 'failed'

interface AuroraIntentAuditRecord {
  id: string
  input: string
  status: AuroraIntentAuditStatus
  timestamp: string
  toolId?: string
  toolName?: string
  securityLevel?: string
  appKind?: string
  summary?: string
  payload?: Record<string, unknown>
}

const AUDIT_PATH = join(config.appHome, 'aurora', 'intent-audit.json')
const MAX_RECORDS = 200
const MAX_TEXT_LENGTH = 2000

function isAuditStatus(value: unknown): value is AuroraIntentAuditStatus {
  return (
    value === 'fallback' ||
    value === 'approval_required' ||
    value === 'approval_queued' ||
    value === 'approval_approved' ||
    value === 'approval_rejected' ||
    value === 'approval_expired' ||
    value === 'completed' ||
    value === 'app_opened' ||
    value === 'rejected' ||
    value === 'failed'
  )
}

function makeId(): string {
  return `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\r/g, '').trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function normalizePayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const json = JSON.stringify(value)
    if (json.length > 24_000) return { truncated: true, preview: json.slice(0, 24_000) }
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function normalizeRecord(value: unknown): AuroraIntentAuditRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = normalizeText((value as any).input)
  const timestamp = normalizeText((value as any).timestamp, 80) || new Date().toISOString()
  const status = (value as any).status
  if (!input || !isAuditStatus(status)) return null

  return {
    id: normalizeText((value as any).id, 120) || makeId(),
    input,
    status,
    timestamp,
    toolId: normalizeText((value as any).toolId, 180),
    toolName: normalizeText((value as any).toolName, 180),
    securityLevel: normalizeText((value as any).securityLevel, 80),
    appKind: normalizeText((value as any).appKind, 120),
    summary: normalizeText((value as any).summary),
    payload: normalizePayload((value as any).payload),
  }
}

async function readRecords(): Promise<AuroraIntentAuditRecord[]> {
  try {
    const raw = await readFile(AUDIT_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeRecord)
      .filter((record): record is AuroraIntentAuditRecord => Boolean(record))
      .slice(0, MAX_RECORDS)
  } catch {
    return []
  }
}

async function writeRecords(records: AuroraIntentAuditRecord[]): Promise<void> {
  await mkdir(dirname(AUDIT_PATH), { recursive: true })
  await writeFile(AUDIT_PATH, `${JSON.stringify(records.slice(0, MAX_RECORDS), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

function sortByNewest(records: AuroraIntentAuditRecord[]): AuroraIntentAuditRecord[] {
  return [...records].sort((left, right) =>
    (Date.parse(right.timestamp) || 0) - (Date.parse(left.timestamp) || 0),
  )
}

auroraIntentAuditRoutes.get('/api/aurora/intent-audit', async (ctx) => {
  const limitRaw = Number(ctx.query.limit || 50)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_RECORDS) : 50
  const records = sortByNewest(await readRecords()).slice(0, limit)

  ctx.body = {
    generatedAt: new Date().toISOString(),
    storage: 'server',
    records,
  }
})

auroraIntentAuditRoutes.post('/api/aurora/intent-audit', async (ctx) => {
  const body = (ctx.request.body || {}) as { record?: unknown }
  const incoming = normalizeRecord(body.record || body)
  if (!incoming) {
    ctx.status = 400
    ctx.body = { error: 'Invalid Aurora intent audit record.' }
    return
  }

  const existing = await readRecords()
  const withoutDuplicate = existing.filter(record => record.id !== incoming.id)
  const records = sortByNewest([incoming, ...withoutDuplicate]).slice(0, MAX_RECORDS)
  await writeRecords(records)

  ctx.body = {
    ok: true,
    record: incoming,
    count: records.length,
  }
})

auroraIntentAuditRoutes.delete('/api/aurora/intent-audit', async (ctx) => {
  await writeRecords([])
  ctx.body = { ok: true, count: 0 }
})
