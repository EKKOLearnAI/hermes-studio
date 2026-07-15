import { isProxy } from 'node:util/types'
import { isIP } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { isFabricSensitiveString } from '../action-fabric/audit'
import {
  INTERNET_CHECKPOINT_KINDS,
  INTERNET_EXECUTION_ENVIRONMENTS,
  INTERNET_EXECUTOR_TYPES,
  INTERNET_RECEIPT_STATUSES,
  InternetCheckpointInput,
  InternetCheckpointResult,
  InternetExecutionCheckpoint,
  InternetExecutionIdentityConflictError,
  InternetExecutionNotFoundError,
  InternetExecutionReceipt,
  InternetExecutionValidationError,
  InternetExecutionVersionConflictError,
  InternetReceiptListOptions,
  InternetReceiptPrepareInput,
  InternetReceiptPrepareResult,
  InternetReceiptStatus,
  InternetReceiptTransitionInput,
} from './types'

interface ReceiptRow {
  workflow_id: string; intent_id: string; material_digest: string; capability_id: string
  provider: string; profile: string; executor_id: string; executor_type: InternetExecutionReceipt['executorType']
  environment: InternetExecutionReceipt['environment']; operation: string; request_json: string
  safe_to_replay: number; status: InternetReceiptStatus; provider_request_id: string | null
  result_json: string | null; error_code: string | null; version: number
  created_at: string; updated_at: string; completed_at: string | null
}

interface CheckpointRow {
  workflow_id: string; ordinal: number; kind: InternetExecutionCheckpoint['kind']; public_url: string | null
  evidence_digest: string | null; details_json: string; observed_at: string; created_at: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SEMANTIC_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)+$/
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,79}$/
const OPERATION = /^[a-z][a-z0-9._-]{0,99}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
// `author` is public Bilibili result data; match the exact `auth` key or full
// credential terms so the security filter does not confuse authorship with auth.
const SENSITIVE_KEY = /(?:^auth$|authentication|authorization|bearer|cookie|credential|password|passphrase|secret|token|api.?key|private.?key|headers?|environment|local.?path|file.?path|directory)/i
const TERMINAL = new Set<InternetReceiptStatus>(['verified', 'mismatch', 'failed', 'waiting_user'])
const TRANSITIONS: Record<InternetReceiptStatus, readonly InternetReceiptStatus[]> = {
  prepared: ['executing', 'failed', 'waiting_user'],
  executing: ['executed', 'unknown', 'failed', 'waiting_user'],
  executed: ['verifying', 'failed', 'waiting_user'],
  verifying: ['verified', 'mismatch', 'unknown', 'failed', 'waiting_user'],
  unknown: ['executing', 'verifying', 'failed', 'waiting_user'],
  verified: [], mismatch: [], failed: [], waiting_user: [],
}

export class InternetExecutionStore {
  constructor(private readonly database: DatabaseSync) {}

  getReceipt(workflowId: string): InternetExecutionReceipt | null {
    const id = workflowIdentifier(workflowId)
    const row = this.database.prepare('SELECT * FROM internet_execution_receipts WHERE workflow_id=?')
      .get(id) as ReceiptRow | undefined
    return row ? receiptFromRow(row) : null
  }

  listReceipts(options: InternetReceiptListOptions = {}): InternetExecutionReceipt[] {
    const conditions: string[] = []
    const values: Array<string | number | null> = []
    if (options.status !== undefined) {
      if (!INTERNET_RECEIPT_STATUSES.includes(options.status)) throw invalid('Internet receipt status is invalid')
      conditions.push('status=?'); values.push(options.status)
    }
    if (options.provider !== undefined) {
      conditions.push('provider=?'); values.push(provider(options.provider))
    }
    if (options.profile !== undefined) {
      conditions.push('profile=?'); values.push(profileName(options.profile))
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    values.push(listLimit(options.limit))
    return (this.database.prepare(`SELECT * FROM internet_execution_receipts ${where}
      ORDER BY updated_at DESC,workflow_id LIMIT ?`).all(...values) as unknown as ReceiptRow[]).map(receiptFromRow)
  }

  prepareReceipt(input: InternetReceiptPrepareInput): InternetReceiptPrepareResult {
    const normalized = normalizePrepare(input)
    return inTransaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM internet_execution_receipts WHERE workflow_id=?')
        .get(normalized.workflowId) as ReceiptRow | undefined
      if (existing) {
        if (!samePreparedMaterial(existing, normalized)) {
          throw new InternetExecutionIdentityConflictError('Internet workflow receipt changed material')
        }
        return { disposition: 'replayed', receipt: receiptFromRow(existing) }
      }
      const now = new Date().toISOString()
      this.database.prepare(`INSERT INTO internet_execution_receipts
        (workflow_id,intent_id,material_digest,capability_id,provider,profile,executor_id,executor_type,environment,
         operation,request_json,safe_to_replay,status,provider_request_id,result_json,error_code,version,
         created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,1,?,?,NULL)`).run(
        normalized.workflowId, normalized.intentId, normalized.materialDigest, normalized.capabilityId,
        normalized.provider, normalized.profile, normalized.executorId, normalized.executorType,
        normalized.environment, normalized.operation, normalized.requestJson, Number(normalized.safeToReplay), now, now,
      )
      return { disposition: 'created', receipt: this.requiredReceipt(normalized.workflowId) }
    })
  }

  transitionReceipt(input: InternetReceiptTransitionInput): InternetExecutionReceipt {
    const workflowId = workflowIdentifier(input.workflowId)
    const materialDigest = digest(input.materialDigest, 'Internet material digest')
    const expectedVersion = version(input.expectedVersion)
    if (!INTERNET_RECEIPT_STATUSES.includes(input.status)) {
      throw invalid('Internet receipt status is invalid')
    }
    const providerRequestId = input.providerRequestId == null ? null
      : safeOpaqueIdentifier(input.providerRequestId, 'Internet provider request id', 255)
    const resultJson = input.result == null ? null : canonicalJson(input.result, 65_536)
    const errorCode = input.errorCode == null ? null : validErrorCode(input.errorCode)
    return inTransaction(this.database, () => {
      const current = this.database.prepare('SELECT * FROM internet_execution_receipts WHERE workflow_id=?')
        .get(workflowId) as ReceiptRow | undefined
      if (!current) throw new InternetExecutionNotFoundError(`Internet receipt not found: ${workflowId}`)
      if (current.material_digest !== materialDigest) {
        throw new InternetExecutionIdentityConflictError('Internet material digest changed')
      }
      if (current.version !== expectedVersion) throw new InternetExecutionVersionConflictError('Internet receipt version changed')
      if (!TRANSITIONS[current.status].includes(input.status)) {
        throw invalid(`Internet receipt transition ${current.status} -> ${input.status} is invalid`)
      }
      if (current.status === 'unknown' && input.status === 'executing' && current.safe_to_replay !== 1) {
        throw invalid('Internet receipt is not safe to replay')
      }
      if (current.provider_request_id !== null && providerRequestId !== null
        && current.provider_request_id !== providerRequestId) {
        throw new InternetExecutionIdentityConflictError('Internet provider request identity changed')
      }
      assertTransitionPayload(input.status, resultJson, errorCode)
      const nextProviderRequestId = current.provider_request_id ?? providerRequestId
      const nextResultJson = resultJson ?? current.result_json
      const now = new Date().toISOString()
      this.database.prepare(`UPDATE internet_execution_receipts SET status=?,provider_request_id=?,result_json=?,
        error_code=?,version=version+1,updated_at=?,completed_at=? WHERE workflow_id=? AND version=?`).run(
        input.status, nextProviderRequestId, nextResultJson, errorCode, now, TERMINAL.has(input.status) ? now : null,
        workflowId, expectedVersion,
      )
      return this.requiredReceipt(workflowId)
    })
  }

  recordCheckpoint(input: InternetCheckpointInput): InternetCheckpointResult {
    const workflowId = workflowIdentifier(input.workflowId)
    const materialDigest = digest(input.materialDigest, 'Internet checkpoint material digest')
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 100_000) {
      throw invalid('Internet checkpoint ordinal is invalid')
    }
    if (!INTERNET_CHECKPOINT_KINDS.includes(input.kind)) throw invalid('Internet checkpoint kind is invalid')
    const publicUrl = input.publicUrl == null ? null : safePublicUrl(input.publicUrl)
    if (input.kind === 'browser_navigate' && publicUrl === null) {
      throw invalid('Browser navigation checkpoint requires a public URL')
    }
    const evidenceDigest = input.evidenceDigest == null ? null
      : digest(input.evidenceDigest, 'Internet checkpoint evidence digest')
    const detailsJson = canonicalJson(input.details ?? {}, 65_536)
    const observedAt = timestamp(input.observedAt, 'Internet checkpoint observedAt')
    return inTransaction(this.database, () => {
      const receipt = this.database.prepare(`SELECT material_digest,executor_type
        FROM internet_execution_receipts WHERE workflow_id=?`).get(workflowId) as
        { material_digest: string; executor_type: InternetExecutionReceipt['executorType'] } | undefined
      if (!receipt) throw new InternetExecutionNotFoundError(`Internet receipt not found: ${workflowId}`)
      if (receipt.material_digest !== materialDigest) {
        throw new InternetExecutionIdentityConflictError('Internet checkpoint material digest changed')
      }
      if ((input.kind === 'mcp_call' && receipt.executor_type !== 'mcp')
        || (input.kind.startsWith('browser_') && receipt.executor_type !== 'browser')) {
        throw invalid('Internet checkpoint kind does not match the receipt executor')
      }
      if (input.kind === 'mcp_call' && publicUrl !== null) {
        throw invalid('MCP checkpoints cannot persist a browser URL')
      }
      const existing = this.database.prepare(`SELECT * FROM internet_execution_checkpoints
        WHERE workflow_id=? AND ordinal=?`).get(workflowId, input.ordinal) as CheckpointRow | undefined
      if (existing) {
        const same = existing.kind === input.kind && existing.public_url === publicUrl
          && existing.evidence_digest === evidenceDigest && existing.details_json === detailsJson
          && existing.observed_at === observedAt
        if (!same) throw new InternetExecutionIdentityConflictError('Internet checkpoint changed material')
        return { disposition: 'replayed', checkpoint: checkpointFromRow(existing) }
      }
      const expectedOrdinal = Number((this.database.prepare(`SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal
        FROM internet_execution_checkpoints WHERE workflow_id=?`).get(workflowId) as { ordinal: number }).ordinal)
      if (input.ordinal !== expectedOrdinal) throw invalid('Internet checkpoint ordinal must be contiguous')
      const now = new Date().toISOString()
      this.database.prepare(`INSERT INTO internet_execution_checkpoints
        (workflow_id,ordinal,kind,public_url,evidence_digest,details_json,observed_at,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(
        workflowId, input.ordinal, input.kind, publicUrl, evidenceDigest, detailsJson, observedAt, now,
      )
      return { disposition: 'created', checkpoint: this.requiredCheckpoint(workflowId, input.ordinal) }
    })
  }

  listCheckpoints(workflowId: string): InternetExecutionCheckpoint[] {
    const id = workflowIdentifier(workflowId)
    return (this.database.prepare(`SELECT * FROM internet_execution_checkpoints
      WHERE workflow_id=? ORDER BY ordinal`).all(id) as unknown as CheckpointRow[]).map(checkpointFromRow)
  }

  private requiredReceipt(workflowId: string): InternetExecutionReceipt {
    const row = this.database.prepare('SELECT * FROM internet_execution_receipts WHERE workflow_id=?')
      .get(workflowId) as ReceiptRow | undefined
    if (!row) throw new InternetExecutionNotFoundError(`Internet receipt not found: ${workflowId}`)
    return receiptFromRow(row)
  }

  private requiredCheckpoint(workflowId: string, ordinal: number): InternetExecutionCheckpoint {
    const row = this.database.prepare(`SELECT * FROM internet_execution_checkpoints
      WHERE workflow_id=? AND ordinal=?`).get(workflowId, ordinal) as CheckpointRow | undefined
    if (!row) throw new InternetExecutionNotFoundError('Internet checkpoint was not persisted')
    return checkpointFromRow(row)
  }
}

function normalizePrepare(input: InternetReceiptPrepareInput) {
  if (!INTERNET_EXECUTOR_TYPES.includes(input.executorType)) throw invalid('Internet executor type is invalid')
  if (!INTERNET_EXECUTION_ENVIRONMENTS.includes(input.environment)) throw invalid('Internet environment is invalid')
  if (typeof input.safeToReplay !== 'boolean') throw invalid('Internet safeToReplay must be boolean')
  return {
    workflowId: workflowIdentifier(input.workflowId), intentId: prefixedIdentifier(input.intentId, 'intent-', 'Internet intent id'),
    materialDigest: digest(input.materialDigest, 'Internet material digest'), capabilityId: semanticId(input.capabilityId),
    provider: provider(input.provider), profile: profileName(input.profile),
    executorId: boundedIdentifier(input.executorId, 'Internet executor id', 160), executorType: input.executorType,
    environment: input.environment, operation: operation(input.operation), requestJson: canonicalJson(input.request, 65_536),
    safeToReplay: input.safeToReplay,
  }
}

function samePreparedMaterial(row: ReceiptRow, input: ReturnType<typeof normalizePrepare>): boolean {
  return row.intent_id === input.intentId && row.material_digest === input.materialDigest
    && row.capability_id === input.capabilityId && row.provider === input.provider && row.profile === input.profile
    && row.executor_id === input.executorId && row.executor_type === input.executorType
    && row.environment === input.environment && row.operation === input.operation
    && row.request_json === input.requestJson && row.safe_to_replay === Number(input.safeToReplay)
}

function assertTransitionPayload(status: InternetReceiptStatus, resultJson: string | null, errorCode: string | null): void {
  if (['executed', 'verified', 'mismatch'].includes(status) && resultJson === null) {
    throw invalid(`Internet receipt status ${status} requires a result`)
  }
  if (status === 'verified' && errorCode !== null) throw invalid('Verified internet receipt cannot contain an error')
  if (['unknown', 'mismatch', 'failed', 'waiting_user'].includes(status) && errorCode === null) {
    throw invalid(`Internet receipt status ${status} requires an error code`)
  }
  if (!['unknown', 'mismatch', 'failed', 'waiting_user'].includes(status) && errorCode !== null) {
    throw invalid(`Internet receipt status ${status} cannot contain an error code`)
  }
}

function canonicalJson(value: unknown, maxBytes: number): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('Internet JSON must be an object')
  const seen = new Set<object>()
  let nodes = 0
  const visit = (item: unknown, depth: number): string => {
    nodes += 1
    if (nodes > 1024 || depth > 8) throw invalid('Internet JSON exceeds structural bounds')
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalid('Internet JSON numbers must be finite')
      return JSON.stringify(item)
    }
    if (typeof item === 'string') {
      if (item.length > 8_192 || isFabricSensitiveString(item)) throw invalid('Internet JSON contains sensitive data')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || isProxy(item) || seen.has(item)) throw invalid('Internet JSON must be plain acyclic data')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw invalid('Internet JSON must use plain objects')
    }
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        if (item.length > 128) throw invalid('Internet JSON array is too large')
        const ownKeys = Reflect.ownKeys(item)
        if (ownKeys.some(key => typeof key === 'symbol'
          || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
          throw invalid('Internet JSON array has invalid properties')
        }
        const values: string[] = []
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid('Internet JSON arrays must be dense data')
          values.push(visit(descriptor.value, depth + 1))
        }
        return `[${values.join(',')}]`
      }
      const keys = Reflect.ownKeys(item)
      if (keys.length > 128 || keys.some(key => typeof key !== 'string')) throw invalid('Internet JSON object has invalid keys')
      return `{${(keys as string[]).sort().map(key => {
        if (!key || key.length > 160 || key === '__proto__' || key === 'prototype' || key === 'constructor'
          || SENSITIVE_KEY.test(key)) throw invalid('Internet JSON contains a sensitive key')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid('Internet JSON must contain data properties')
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`
      }).join(',')}}`
    } finally { seen.delete(item) }
  }
  const encoded = visit(value, 0)
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw invalid('Internet JSON exceeds its byte limit')
  return encoded
}

function safePublicUrl(value: unknown): string {
  const text = boundedText(value, 'Internet public URL', 2048)
  if (isFabricSensitiveString(text)) throw invalid('Internet public URL contains sensitive data')
  let parsed: URL
  try { parsed = new URL(text) } catch { throw invalid('Internet public URL is invalid') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) {
    throw invalid('Internet public URL must be credential-free HTTPS')
  }
  const host = parsed.hostname.toLowerCase()
  const unbracketedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIP(unbracketedHost) !== 0 || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(host)) {
    throw invalid('Internet public URL cannot target a private host')
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_KEY.test(key)) throw invalid('Internet public URL contains a sensitive query')
  }
  parsed.hostname = host
  return parsed.toString()
}

function receiptFromRow(row: ReceiptRow): InternetExecutionReceipt {
  return {
    workflowId: row.workflow_id, intentId: row.intent_id, materialDigest: row.material_digest,
    capabilityId: row.capability_id, provider: row.provider, profile: row.profile, executorId: row.executor_id,
    executorType: row.executor_type, environment: row.environment, operation: row.operation,
    request: JSON.parse(row.request_json) as Record<string, unknown>, safeToReplay: row.safe_to_replay === 1,
    status: row.status, providerRequestId: row.provider_request_id,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as Record<string, unknown>,
    errorCode: row.error_code, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function checkpointFromRow(row: CheckpointRow): InternetExecutionCheckpoint {
  return {
    workflowId: row.workflow_id, ordinal: row.ordinal, kind: row.kind, publicUrl: row.public_url,
    evidenceDigest: row.evidence_digest, details: JSON.parse(row.details_json) as Record<string, unknown>,
    observedAt: row.observed_at, createdAt: row.created_at,
  }
}

function inTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return operation()
  db.exec('BEGIN IMMEDIATE')
  try { const result = operation(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}

function workflowIdentifier(value: unknown): string { return prefixedIdentifier(value, 'workflow-', 'Internet workflow id') }
function prefixedIdentifier(value: unknown, prefix: string, field: string): string {
  const id = boundedIdentifier(value, field, 200)
  if (!id.startsWith(prefix)) throw invalid(`${field} is invalid`)
  return id
}
function boundedIdentifier(value: unknown, field: string, maximum: number): string {
  const text = boundedText(value, field, maximum)
  if (!ID.test(text)) throw invalid(`${field} is invalid`)
  return text
}
function semanticId(value: unknown): string {
  const text = boundedText(value, 'Internet capability id', 160)
  if (!SEMANTIC_ID.test(text)) throw invalid('Internet capability id is invalid')
  return text
}
function provider(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER.test(value)) throw invalid('Internet provider is invalid')
  return value
}
function operation(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION.test(value)) throw invalid('Internet operation is invalid')
  return value
}
function profileName(value: unknown): string {
  const name = boundedText(value, 'Internet profile', 200)
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid('Internet profile is invalid')
  }
  return name
}
function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(`${field} is invalid`)
  return value
}
function validErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !ERROR_CODE.test(value)) throw invalid('Internet error code is invalid')
  return value
}
function safeOpaqueIdentifier(value: unknown, field: string, maximum: number): string {
  const text = boundedText(value, field, maximum)
  if (isFabricSensitiveString(text)) throw invalid(`${field} contains sensitive data`)
  return text
}
function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw invalid(`${field} is required`)
  const text = value.trim()
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(`${field} is invalid`)
  return text
}
function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid(`${field} is invalid`)
  return new Date(value).toISOString()
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid('Internet expectedVersion is invalid')
  return value as number
}
function listLimit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 100 : Math.max(1, Math.min(200, Math.floor(value)))
}
function invalid(message: string): InternetExecutionValidationError {
  return new InternetExecutionValidationError(message)
}
