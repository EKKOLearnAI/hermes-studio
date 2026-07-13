import { randomUUID } from 'crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getProfileDir } from '../hermes-profile'
import type { HealthDomain, HealthIngestionEnvelope, HealthIngestionResult } from './types'

const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/
const MAX_STATE_BYTES = 65_536
const connectorLocks = new Map<string, Promise<void>>()

export type HealthConnectorHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unavailable'

export interface HealthConnectorStatus {
  configured: boolean
  health: HealthConnectorHealth
  lastAttemptAt?: string
  lastSuccessAt?: string
  cursor?: string
  domains: HealthDomain[]
  errorCode?: string
}

export interface HealthConnectorBatch {
  connectorId: string
  cursor?: string
  attemptedCount: number
  ingestedCount: number
}

export interface HealthConnector {
  id: string
  domains: HealthDomain[]
  status(): Promise<HealthConnectorStatus>
  sync(input: { cursor?: string; now?: string }): Promise<HealthConnectorBatch>
}

export type HealthEnvelopeIngestor = (envelope: HealthIngestionEnvelope) => HealthIngestionResult

interface PersistedConnectorState {
  lastAttemptAt?: string
  lastSuccessAt?: string
  cursor?: string
  health: HealthConnectorHealth
  errorCode?: string
}

interface ConnectorStateFile {
  version: 1
  connectors: Record<string, PersistedConnectorState>
}

export interface HealthConnectorStateStore {
  readonly lockKey: string
  read(connectorId: string): Promise<PersistedConnectorState | undefined>
  write(connectorId: string, state: PersistedConnectorState): Promise<void>
}

export class HealthConnectorError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'HealthConnectorError'
  }
}

export class FileHealthConnectorStateStore implements HealthConnectorStateStore {
  readonly lockKey: string

  constructor(private readonly path: string) {
    this.lockKey = path
  }

  async read(connectorId: string): Promise<PersistedConnectorState | undefined> {
    validateConnectorId(connectorId)
    const file = await this.readFile()
    return file.connectors[connectorId]
  }

  async write(connectorId: string, state: PersistedConnectorState): Promise<void> {
    validateConnectorId(connectorId)
    validateState(state)
    try {
      await withConnectorLock(`state:${this.lockKey}`, async () => {
        const file = await this.readFile()
        file.connectors[connectorId] = { ...state }
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
          await rename(temporary, this.path)
        } finally {
          await rm(temporary, { force: true })
        }
      })
    } catch (error) {
      if (error instanceof HealthConnectorError) throw error
      throw new HealthConnectorError('CONNECTOR_STATE_WRITE_FAILED')
    }
  }

  private async readFile(): Promise<ConnectorStateFile> {
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
      const raw = await readFile(this.path, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
      const parsed: unknown = JSON.parse(raw)
      if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.connectors)) {
        throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
      }
      const connectors: Record<string, PersistedConnectorState> = {}
      for (const [id, state] of Object.entries(parsed.connectors)) {
        validateConnectorId(id)
        validateState(state)
        connectors[id] = { ...(state as PersistedConnectorState) }
      }
      return { version: 1, connectors }
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { version: 1, connectors: {} }
      if (error instanceof HealthConnectorError) throw error
      throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
    }
  }
}

export function defaultHealthConnectorStateStore(profile = 'default'): FileHealthConnectorStateStore {
  return new FileHealthConnectorStateStore(join(getProfileDir(profile), 'health-loop', 'connectors.json'))
}

export interface ManagedConnectorSource {
  id: string
  domains: HealthDomain[]
  configured(): Promise<boolean>
  load(input: { cursor?: string; now: string }): Promise<{ envelopes: HealthIngestionEnvelope[]; cursor?: string }>
}

export function createManagedHealthConnector(options: {
  source: ManagedConnectorSource
  stateStore: HealthConnectorStateStore
  ingest: HealthEnvelopeIngestor
}): HealthConnector {
  const { source, stateStore, ingest } = options
  validateConnectorId(source.id)
  validateDomains(source.domains)

  const status = async (): Promise<HealthConnectorStatus> => {
    let configured = false
    try {
      configured = await source.configured()
    } catch {
      return { configured: false, health: 'unavailable', domains: [...source.domains], errorCode: 'CONNECTOR_STATUS_FAILED' }
    }
    try {
      const state = await stateStore.read(source.id)
      return {
        configured, health: state?.health ?? 'unavailable',
        ...(state?.lastAttemptAt ? { lastAttemptAt: state.lastAttemptAt } : {}),
        ...(state?.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
        ...(state?.cursor ? { cursor: state.cursor } : {}), domains: [...source.domains],
        ...(state?.errorCode ? { errorCode: state.errorCode } : {}),
      }
    } catch {
      return { configured, health: 'unavailable', domains: [...source.domains], errorCode: 'CONNECTOR_STATE_CORRUPT' }
    }
  }

  const sync = async (input: { cursor?: string; now?: string }): Promise<HealthConnectorBatch> => {
    const now = validateTimestamp(input.now ?? new Date().toISOString())
    if (input.cursor !== undefined) validateCursor(input.cursor)
    return withConnectorLock(`connector:${stateStore.lockKey}:${source.id}`, async () => {
      let previous: PersistedConnectorState | undefined
      try {
        previous = await stateStore.read(source.id)
      } catch {
        throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
      }
      if (input.cursor !== undefined && previous?.cursor !== undefined && input.cursor !== previous.cursor) {
        throw new HealthConnectorError('CONNECTOR_CURSOR_CONFLICT')
      }
      const cursor = input.cursor ?? previous?.cursor
      const attempted: PersistedConnectorState = {
        ...(previous ?? { health: 'unavailable' as const }),
        lastAttemptAt: now,
      }
      await stateStore.write(source.id, attempted)
      try {
        if (!(await source.configured())) throw new HealthConnectorError('CONNECTOR_NOT_CONFIGURED')
        const loaded = await source.load({ cursor, now })
        if (loaded.cursor !== undefined) validateCursor(loaded.cursor)
        if (loaded.envelopes.length > 1_000) throw new HealthConnectorError('CONNECTOR_IMPORT_LIMIT')
        let ingestedCount = 0
        for (const envelope of loaded.envelopes) {
          ingest(envelope)
          ingestedCount += 1
        }
        const nextCursor = loaded.cursor ?? cursor
        const successful: PersistedConnectorState = {
          health: 'healthy', lastAttemptAt: now, lastSuccessAt: now,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        }
        await stateStore.write(source.id, successful)
        return { connectorId: source.id, cursor: nextCursor, attemptedCount: loaded.envelopes.length, ingestedCount }
      } catch (error) {
        const code = sanitizedErrorCode(error)
        await stateStore.write(source.id, {
          health: code === 'CONNECTOR_NOT_CONFIGURED' ? 'unavailable' : 'degraded',
          lastAttemptAt: now,
          ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
          ...(previous?.cursor ? { cursor: previous.cursor } : {}),
          errorCode: code,
        })
        if (error instanceof HealthConnectorError) throw error
        throw new HealthConnectorError(code)
      }
    })
  }

  return { id: source.id, domains: [...source.domains], status, sync }
}

export function createHealthConnectorRegistry(connectors: HealthConnector[]): {
  list(): HealthConnector[]
  get(id: string): HealthConnector | undefined
} {
  const byId = new Map<string, HealthConnector>()
  for (const connector of connectors) {
    validateConnectorId(connector.id)
    validateDomains(connector.domains)
    if (byId.has(connector.id)) throw new HealthConnectorError('CONNECTOR_DUPLICATE_ID')
    byId.set(connector.id, connector)
  }
  const ordered = [...byId.values()].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)))
  return { list: () => [...ordered], get: id => byId.get(id) }
}

export function createConnectorCursor(observedAt: string, sourceId: string): string {
  const time = validateTimestamp(observedAt)
  if (!SOURCE_ID.test(sourceId)) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return Buffer.from(`${time}\0${sourceId}`, 'utf8').toString('base64url')
}

export function compareEnvelopeCursor(envelope: HealthIngestionEnvelope, cursor: string): number {
  validateCursor(cursor)
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const separator = decoded.indexOf('\0')
  const timeOrder = compareTimestampInstants(validateTimestamp(envelope.observedAt), decoded.slice(0, separator))
  return timeOrder || Buffer.compare(Buffer.from(envelope.sourceId, 'utf8'), Buffer.from(decoded.slice(separator + 1), 'utf8'))
}

export function compareHealthEnvelopeOrder(left: HealthIngestionEnvelope, right: HealthIngestionEnvelope): number {
  const timeOrder = compareTimestampInstants(validateTimestamp(left.observedAt), validateTimestamp(right.observedAt))
  return timeOrder || Buffer.compare(Buffer.from(left.sourceId, 'utf8'), Buffer.from(right.sourceId, 'utf8'))
}

export function validateConnectorTimestamp(value: string): string {
  return validateTimestamp(value)
}

function validateState(value: unknown): asserts value is PersistedConnectorState {
  if (!isPlainObject(value) || !['healthy', 'degraded', 'unhealthy', 'unavailable'].includes(String(value.health))) {
    throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  }
  const keys = Object.keys(value)
  if (keys.some(key => !['lastAttemptAt', 'lastSuccessAt', 'cursor', 'health', 'errorCode'].includes(key))) {
    throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  }
  for (const key of ['lastAttemptAt', 'lastSuccessAt'] as const) {
    if (value[key] !== undefined) validateTimestamp(String(value[key]), 'CONNECTOR_STATE_CORRUPT')
  }
  if (value.cursor !== undefined) validateCursor(String(value.cursor), 'CONNECTOR_STATE_CORRUPT')
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !ERROR_CODE.test(value.errorCode))) {
    throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  }
}

function validateConnectorId(id: string): void {
  if (typeof id !== 'string' || !CONNECTOR_ID.test(id)) throw new HealthConnectorError('CONNECTOR_INVALID_ID')
}

function validateDomains(domains: HealthDomain[]): void {
  const allowed = new Set(['body_composition', 'measurements', 'posture', 'skin', 'diet', 'fitness', 'sleep', 'internal_health'])
  if (!Array.isArray(domains) || domains.length === 0 || new Set(domains).size !== domains.length || domains.some(domain => !allowed.has(domain))) {
    throw new HealthConnectorError('CONNECTOR_INVALID_DOMAINS')
  }
}

function validateCursor(cursor: string, errorCode = 'CONNECTOR_INVALID_CURSOR'): void {
  if (typeof cursor !== 'string' || !CURSOR.test(cursor)) throw new HealthConnectorError(errorCode)
  try {
    const decodedBuffer = Buffer.from(cursor, 'base64url')
    if (decodedBuffer.toString('base64url') !== cursor) throw new Error('non-canonical cursor')
    const decoded = decodedBuffer.toString('utf8')
    const separator = decoded.indexOf('\0')
    if (separator <= 0 || separator !== decoded.lastIndexOf('\0')) throw new Error('invalid cursor fields')
    validateTimestamp(decoded.slice(0, separator), errorCode)
    if (!SOURCE_ID.test(decoded.slice(separator + 1))) throw new Error('invalid cursor source')
  } catch (error) {
    if (error instanceof HealthConnectorError && error.code === errorCode) throw error
    throw new HealthConnectorError(errorCode)
  }
}

function validateTimestamp(value: string, errorCode = 'CONNECTOR_INVALID_TIMESTAMP'): string {
  if (typeof value !== 'string') throw new HealthConnectorError(errorCode)
  const match = value.match(RFC3339)
  if (!match) throw new HealthConnectorError(errorCode)
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6])
  const offsetHour = Number(match[9] ?? 0); const offsetMinute = Number(match[10] ?? 0)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new HealthConnectorError(errorCode)
  }
  if (Number.isNaN(Date.parse(value)) && year !== 0) throw new HealthConnectorError(errorCode)
  return value
}

function compareTimestampInstants(left: string, right: string): number {
  const leftValue = timestampNanoseconds(left)
  const rightValue = timestampNanoseconds(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function timestampNanoseconds(value: string): bigint {
  const match = value.match(RFC3339)!
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6])
  const fraction = BigInt((match[7] ?? '').padEnd(9, '0') || '0')
  const offset = (Number(match[9] ?? 0) * 60 + Number(match[10] ?? 0)) * (match[8] === '-' ? -1 : 1)
  const epochSeconds = BigInt(daysFromCivil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second - offset * 60)
  return epochSeconds * 1_000_000_000n + fraction
}

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(adjustedYear / 400)
  const yearOfEra = adjustedYear - era * 400
  const shiftedMonth = month + (month > 2 ? -3 : 9)
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

function sanitizedErrorCode(error: unknown): string {
  if (error instanceof HealthConnectorError && ERROR_CODE.test(error.code)) return error.code
  const candidate = isPlainObject(error) && typeof error.code === 'string' ? error.code : ''
  if (/^HEALTH_INGESTION_[A-Z0-9_]{1,60}$/.test(candidate)) return candidate
  return 'CONNECTOR_SYNC_FAILED'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function withConnectorLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = connectorLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => current)
  connectorLocks.set(key, tail)
  await previous
  try { return await operation() } finally {
    release()
    if (connectorLocks.get(key) === tail) connectorLocks.delete(key)
  }
}
