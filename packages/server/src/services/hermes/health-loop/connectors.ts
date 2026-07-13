import { randomUUID } from 'crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getProfileDir } from '../hermes-profile'
import type { HealthDomain, HealthIngestionEnvelope, HealthIngestionResult } from './types'

const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/
const MAX_STATE_BYTES = 65_536
const connectorLocks = new Map<string, Promise<void>>()

export type HealthConnectorHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unavailable'
export type HealthConnectorConfigurationState = 'configured' | 'not_configured' | 'invalid'
export type HealthConnectorAuthorizationState = 'authorized' | 'not_required' | 'required' | 'expired' | 'unknown'

export interface HealthConnectorCapabilities {
  read: HealthDomain[]
  write: HealthDomain[]
}

export interface HealthConnectorAccessState {
  configurationState: HealthConnectorConfigurationState
  authorizationState: HealthConnectorAuthorizationState
}

export interface HealthConnectorStatus {
  configured: boolean
  configurationState: HealthConnectorConfigurationState
  authorizationState: HealthConnectorAuthorizationState
  health: HealthConnectorHealth
  lastAttemptAt?: string
  lastSuccessAt?: string
  cursor?: string
  domains: HealthDomain[]
  freshnessByDomain: Partial<Record<HealthDomain, string>>
  capabilities: HealthConnectorCapabilities
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
  freshnessByDomain?: Partial<Record<HealthDomain, string>>
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
  cursorKind?: 'opaque' | 'timestamp'
  access(): Promise<HealthConnectorAccessState>
  capabilities: HealthConnectorCapabilities
  load(input: { cursor?: string; now: string }): Promise<{ envelopes: HealthIngestionEnvelope[]; cursor?: string; health?: HealthConnectorHealth }>
}

export function createManagedHealthConnector(options: {
  source: ManagedConnectorSource
  stateStore: HealthConnectorStateStore
  ingest: HealthEnvelopeIngestor
}): HealthConnector {
  const { source, stateStore, ingest } = options
  validateConnectorId(source.id)
  validateDomains(source.domains)
  validateCapabilities(source.capabilities, source.domains)

  const status = async (): Promise<HealthConnectorStatus> => {
    let access: HealthConnectorAccessState
    try {
      access = await source.access()
      validateAccess(access)
    } catch {
      return statusBase(source, { configurationState: 'invalid', authorizationState: 'unknown' }, 'unavailable', 'CONNECTOR_STATUS_FAILED')
    }
    try {
      const state = await stateStore.read(source.id)
      validateStateForSource(state, source)
      const effectiveAccess = state?.errorCode === 'CONNECTOR_AUTHORIZATION_REQUIRED'
        ? { ...access, authorizationState: 'required' as const }
        : access
      return {
        ...statusBase(source, effectiveAccess, state?.health ?? 'unavailable'),
        ...(state?.lastAttemptAt ? { lastAttemptAt: state.lastAttemptAt } : {}),
        ...(state?.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
        ...(state?.cursor ? { cursor: state.cursor } : {}),
        freshnessByDomain: { ...(state?.freshnessByDomain ?? {}) },
        ...(state?.errorCode ? { errorCode: state.errorCode } : {}),
      }
    } catch {
      return statusBase(source, access, 'unavailable', 'CONNECTOR_STATE_CORRUPT')
    }
  }

  const sync = async (input: { cursor?: string; now?: string }): Promise<HealthConnectorBatch> => {
    const now = validateTimestamp(input.now ?? new Date().toISOString())
    if (input.cursor !== undefined) validateCursor(input.cursor)
    return withConnectorLock(`connector:${stateStore.lockKey}:${source.id}`, async () => {
      let previous: PersistedConnectorState | undefined
      try {
        previous = await stateStore.read(source.id)
        validateStateForSource(previous, source)
      } catch {
        throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
      }
      if (input.cursor !== undefined && previous?.cursor !== undefined) {
        if (source.cursorKind === 'timestamp') {
          if (compareCursorValues(input.cursor, previous.cursor) < 0) throw new HealthConnectorError('CONNECTOR_CURSOR_CONFLICT')
        } else if (input.cursor !== previous.cursor) throw new HealthConnectorError('CONNECTOR_CURSOR_CONFLICT')
      }
      const cursor = source.cursorKind === 'timestamp' ? maxCursor(input.cursor, previous?.cursor) : (input.cursor ?? previous?.cursor)
      const inputCursorTime = cursor ? comparableCursorTimestamp(cursor, source.cursorKind) : undefined
      if (inputCursorTime && compareTimestampInstants(inputCursorTime, now) > 0) {
        throw new HealthConnectorError('CONNECTOR_CURSOR_CONFLICT')
      }
      let freshnessByDomain = { ...(previous?.freshnessByDomain ?? {}) }
      const attempted: PersistedConnectorState = {
        ...(previous ?? { health: 'unavailable' as const }),
        lastAttemptAt: now,
      }
      await stateStore.write(source.id, attempted)
      try {
        const access = await source.access()
        validateAccess(access)
        if (access.configurationState !== 'configured') throw new HealthConnectorError('CONNECTOR_NOT_CONFIGURED')
        if (access.authorizationState !== 'authorized' && access.authorizationState !== 'not_required') {
          throw new HealthConnectorError('CONNECTOR_AUTHORIZATION_REQUIRED')
        }
        const loaded = await source.load({ cursor, now })
        if (loaded.health !== undefined && !['healthy', 'degraded', 'unhealthy', 'unavailable'].includes(loaded.health)) {
          throw new HealthConnectorError('CONNECTOR_INVALID_HEALTH')
        }
        if (loaded.cursor !== undefined) validateCursor(loaded.cursor)
        if (loaded.envelopes.length > 1_000) throw new HealthConnectorError('CONNECTOR_IMPORT_LIMIT')
        let ingestedCount = 0
        for (const envelope of loaded.envelopes) {
          if (!source.domains.includes(envelope.domain)) throw new HealthConnectorError('CONNECTOR_INVALID_DOMAINS')
          validateTimestamp(envelope.observedAt, 'CONNECTOR_INVALID_IMPORT')
          ingest(envelope)
          ingestedCount += 1
          const current = freshnessByDomain[envelope.domain]
          if (!current || compareTimestampInstants(envelope.observedAt, current) > 0) freshnessByDomain[envelope.domain] = envelope.observedAt
        }
        const nextCursor = source.cursorKind === 'timestamp' ? maxCursor(cursor, loaded.cursor) : (loaded.cursor ?? cursor)
        const nextCursorTime = nextCursor ? comparableCursorTimestamp(nextCursor, source.cursorKind) : undefined
        if (nextCursorTime && compareTimestampInstants(nextCursorTime, now) > 0) throw new HealthConnectorError('CONNECTOR_CURSOR_CONFLICT')
        const successful: PersistedConnectorState = {
          health: loaded.health ?? 'healthy', lastAttemptAt: now, lastSuccessAt: now,
          ...(nextCursor ? { cursor: nextCursor } : {}),
          ...(Object.keys(freshnessByDomain).length ? { freshnessByDomain } : {}),
        }
        await stateStore.write(source.id, successful)
        return { connectorId: source.id, cursor: nextCursor, attemptedCount: loaded.envelopes.length, ingestedCount }
      } catch (error) {
        const code = sanitizedErrorCode(error)
        await stateStore.write(source.id, {
          health: code === 'CONNECTOR_NOT_CONFIGURED' || code === 'CONNECTOR_AUTHORIZATION_REQUIRED' ? 'unavailable' : 'degraded',
          lastAttemptAt: now,
          ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
          ...(previous?.cursor ? { cursor: previous.cursor } : {}),
          ...(Object.keys(freshnessByDomain).length ? { freshnessByDomain } : {}),
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
  const [cursorTime, cursorSource] = decodeTimestampCursor(cursor)
  const timeOrder = compareTimestampInstants(validateTimestamp(envelope.observedAt), cursorTime)
  return timeOrder || (cursorSource ? Buffer.compare(Buffer.from(envelope.sourceId, 'utf8'), Buffer.from(cursorSource, 'utf8')) : 0)
}

export function compareHealthEnvelopeOrder(left: HealthIngestionEnvelope, right: HealthIngestionEnvelope): number {
  const timeOrder = compareTimestampInstants(validateTimestamp(left.observedAt), validateTimestamp(right.observedAt))
  return timeOrder || Buffer.compare(Buffer.from(left.sourceId, 'utf8'), Buffer.from(right.sourceId, 'utf8'))
}

export function validateConnectorTimestamp(value: string): string {
  return validateTimestamp(value)
}

function statusBase(
  source: ManagedConnectorSource,
  access: HealthConnectorAccessState,
  health: HealthConnectorHealth,
  errorCode?: string,
): HealthConnectorStatus {
  return {
    configured: access.configurationState === 'configured',
    configurationState: access.configurationState,
    authorizationState: access.authorizationState,
    health,
    domains: [...source.domains],
    freshnessByDomain: {},
    capabilities: { read: [...source.capabilities.read], write: [...source.capabilities.write] },
    ...(errorCode ? { errorCode } : {}),
  }
}

function validateState(value: unknown): asserts value is PersistedConnectorState {
  if (!isPlainObject(value) || !['healthy', 'degraded', 'unhealthy', 'unavailable'].includes(String(value.health))) {
    throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  }
  const keys = Object.keys(value)
  if (keys.some(key => !['lastAttemptAt', 'lastSuccessAt', 'cursor', 'health', 'freshnessByDomain', 'errorCode'].includes(key))) {
    throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  }
  for (const key of ['lastAttemptAt', 'lastSuccessAt'] as const) {
    if (value[key] !== undefined) validateTimestamp(String(value[key]), 'CONNECTOR_STATE_CORRUPT')
  }
  if (value.cursor !== undefined) validateCursor(String(value.cursor), 'CONNECTOR_STATE_CORRUPT')
  if (value.freshnessByDomain !== undefined) {
    if (!isPlainObject(value.freshnessByDomain)) throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
    const allowed = new Set<HealthDomain>(['body_composition', 'measurements', 'posture', 'skin', 'diet', 'fitness', 'sleep', 'internal_health'])
    for (const [domain, timestamp] of Object.entries(value.freshnessByDomain)) {
      if (!allowed.has(domain as HealthDomain) || typeof timestamp !== 'string') throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
      validateTimestamp(timestamp, 'CONNECTOR_STATE_CORRUPT')
    }
  }
  const attempt = typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : undefined
  const success = typeof value.lastSuccessAt === 'string' ? value.lastSuccessAt : undefined
  const freshness = isPlainObject(value.freshnessByDomain) ? Object.values(value.freshnessByDomain) as string[] : []
  if (!attempt && (success || freshness.length > 0)) throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  if (attempt && success && compareTimestampInstants(success, attempt) > 0) throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  if (attempt && freshness.some(timestamp => compareTimestampInstants(timestamp, attempt) > 0)) throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !ERROR_CODE.test(value.errorCode))) {
    throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  }
}

function validateStateForSource(state: PersistedConnectorState | undefined, source: ManagedConnectorSource): void {
  if (!state) return
  if (state.freshnessByDomain && Object.keys(state.freshnessByDomain).some(domain => !source.domains.includes(domain as HealthDomain))) {
    throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
  }
  if (source.cursorKind === 'timestamp' && state.cursor) {
    let timestamp: string
    try { timestamp = cursorTimestamp(state.cursor) } catch { throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT') }
    if (!state.lastAttemptAt || compareTimestampInstants(timestamp, state.lastAttemptAt) > 0) {
      throw new HealthConnectorError('CONNECTOR_STATE_CORRUPT')
    }
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

function validateCapabilities(capabilities: HealthConnectorCapabilities, domains: HealthDomain[]): void {
  if (!isPlainObject(capabilities) || !Array.isArray(capabilities.read) || !Array.isArray(capabilities.write)) {
    throw new HealthConnectorError('CONNECTOR_INVALID_CAPABILITIES')
  }
  const supported = new Set(domains)
  for (const list of [capabilities.read, capabilities.write]) {
    if (new Set(list).size !== list.length || list.some(domain => !supported.has(domain))) throw new HealthConnectorError('CONNECTOR_INVALID_CAPABILITIES')
  }
}

function validateAccess(access: HealthConnectorAccessState): void {
  if (!isPlainObject(access)
    || !['configured', 'not_configured', 'invalid'].includes(String(access.configurationState))
    || !['authorized', 'not_required', 'required', 'expired', 'unknown'].includes(String(access.authorizationState))) {
    throw new HealthConnectorError('CONNECTOR_STATUS_FAILED')
  }
}

function validateCursor(cursor: string, errorCode = 'CONNECTOR_INVALID_CURSOR'): void {
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 512 || Buffer.byteLength(cursor, 'utf8') > 512 || !/^[\x21-\x7e]+$/.test(cursor)) {
    throw new HealthConnectorError(errorCode)
  }
}

function decodeTimestampCursor(cursor: string, errorCode = 'CONNECTOR_INVALID_CURSOR'): [string, string] {
  validateCursor(cursor, errorCode)
  if (RFC3339.test(cursor)) return [validateTimestamp(cursor, errorCode), '']
  try {
    const decodedBuffer = Buffer.from(cursor, 'base64url')
    if (decodedBuffer.toString('base64url') !== cursor) throw new Error('non-canonical cursor')
    const decoded = decodedBuffer.toString('utf8')
    const separator = decoded.indexOf('\0')
    if (separator <= 0 || separator !== decoded.lastIndexOf('\0')) throw new Error('invalid cursor fields')
    const timestamp = validateTimestamp(decoded.slice(0, separator), errorCode)
    const sourceId = decoded.slice(separator + 1)
    if (!SOURCE_ID.test(sourceId)) throw new Error('invalid cursor source')
    return [timestamp, sourceId]
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
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
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

function maxCursor(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  validateCursor(left); validateCursor(right)
  return compareCursorValues(left, right) >= 0 ? left : right
}

function compareCursorValues(left: string, right: string): number {
  const [leftTime, leftSource] = decodeTimestampCursor(left); const [rightTime, rightSource] = decodeTimestampCursor(right)
  return compareTimestampInstants(leftTime, rightTime)
    || Buffer.compare(Buffer.from(leftSource, 'utf8'), Buffer.from(rightSource, 'utf8'))
}

function cursorTimestamp(cursor: string): string {
  return decodeTimestampCursor(cursor)[0]
}

function comparableCursorTimestamp(cursor: string, kind: ManagedConnectorSource['cursorKind']): string | undefined {
  if (kind === 'timestamp') return cursorTimestamp(cursor)
  return undefined
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
