import { ingestHealthEnvelope } from '../ingestion'
import { normalizeHealthIngestionEnvelope } from '../normalizers'
import type { HealthDomain, HealthEvidenceClass, HealthIngestionEnvelope } from '../types'
import {
  compareEnvelopeCursor, compareHealthEnvelopeOrder, createConnectorCursor, createManagedHealthConnector, defaultHealthConnectorStateStore,
  HealthConnectorError, type HealthConnector, type HealthConnectorStateStore, type HealthEnvelopeIngestor,
} from '../connectors'

const MAX_IMPORT_BYTES = 1_048_576
const MAX_ROWS = 1_000
const MAX_COLUMNS = 64
const COMMON_JSON_FIELDS = new Set(['domain', 'sourceId', 'observedAt', 'evidenceClass', 'confidence', 'payload', 'artifactIds', 'parserVersion'])
const DOMAIN_FIELDS: Record<'diet' | 'fitness' | 'sleep', Set<string>> = {
  diet: new Set(['foods', 'supplements', 'mealTime', 'caloriesKcal', 'proteinG', 'carbsG', 'fatG', 'waterMl', 'micros', 'parserConfidence', 'portionConfirmed', 'confirmationStatus']),
  fitness: new Set(['exercise', 'exercises', 'sets', 'reps', 'loadKg', 'durationMinutes', 'pain', 'rpe', 'trainingLoad', 'intensity', 'muscles', 'completed']),
  sleep: new Set(['startedAt', 'endedAt', 'durationMinutes', 'interruptions', 'stages', 'restingHeartRateBpm', 'restingRespiratoryRateBrpm', 'restingSpo2Percent', 'freshnessMinutes', 'subjectiveRecovery', 'recoveryScore']),
}
const COMMON_CSV_FIELDS = new Set(['domain', 'sourceId', 'observedAt', 'evidenceClass', 'confidence'])
const CSV_FIELDS = new Set([
  ...COMMON_CSV_FIELDS, 'foodName', 'portionGrams', 'caloriesKcal', 'proteinG', 'carbsG', 'fatG', 'waterMl',
  'exercise', 'durationMinutes', 'intensity', 'pain', 'rpe', 'completed', 'startedAt', 'endedAt', 'interruptions',
  'subjectiveRecovery', 'recoveryScore',
])

export function createStructuredImportConnector(options: {
  id: string
  format: 'json' | 'csv'
  content: string
  profile?: string
  stateStore?: HealthConnectorStateStore
  ingest?: HealthEnvelopeIngestor
}): HealthConnector {
  const profile = options.profile ?? 'default'
  return createManagedHealthConnector({
    stateStore: options.stateStore ?? defaultHealthConnectorStateStore(profile),
    ingest: options.ingest ?? ingestHealthEnvelope,
    source: {
      id: options.id,
      domains: ['diet', 'fitness', 'sleep'],
      configured: async () => true,
      load: async ({ cursor, now }) => {
        const parsed = parseImport(options.format, options.content, options.id)
          .sort(compareHealthEnvelopeOrder)
          .filter(envelope => compareHealthEnvelopeOrder(envelope, { ...envelope, observedAt: now }) <= 0)
          .filter(envelope => !cursor || compareEnvelopeCursor(envelope, cursor) > 0)
        const last = parsed.at(-1)
        return { envelopes: parsed, ...(last ? { cursor: createConnectorCursor(last.observedAt, last.sourceId) } : { cursor }) }
      },
    },
  })
}

function parseImport(format: 'json' | 'csv', content: string, source: string): HealthIngestionEnvelope[] {
  if (typeof content !== 'string' || containsUnpairedSurrogate(content)) fail('CONNECTOR_INVALID_IMPORT')
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) fail('CONNECTOR_IMPORT_LIMIT')
  return format === 'json' ? parseJson(content, source) : parseCsvImport(content, source)
}

function parseJson(content: string, source: string): HealthIngestionEnvelope[] {
  let value: unknown
  try { value = JSON.parse(content) } catch { fail('CONNECTOR_INVALID_IMPORT') }
  if (!Array.isArray(value)) fail('CONNECTOR_INVALID_IMPORT')
  if (value.length > MAX_ROWS) fail('CONNECTOR_IMPORT_LIMIT')
  return value.map(item => {
    const record = plainRecord(item)
    rejectUnknown(record, COMMON_JSON_FIELDS)
    const domain = healthDomain(record.domain)
    const payload = plainRecord(record.payload)
    rejectUnknown(payload, DOMAIN_FIELDS[domain])
    const envelope: HealthIngestionEnvelope = {
      domain, source, sourceId: string(record.sourceId), observedAt: string(record.observedAt),
      evidenceClass: evidenceClass(record.evidenceClass), confidence: finiteNumber(record.confidence), payload,
      ...(record.artifactIds !== undefined ? { artifactIds: stringArray(record.artifactIds) } : {}),
      ...(record.parserVersion !== undefined ? { parserVersion: string(record.parserVersion) } : {}),
    }
    validateEnvelope(envelope)
    return envelope
  })
}

function parseCsvImport(content: string, source: string): HealthIngestionEnvelope[] {
  const rows = parseCsv(content)
  if (rows.length === 0) fail('CONNECTOR_INVALID_IMPORT')
  if (rows.length - 1 > MAX_ROWS) fail('CONNECTOR_IMPORT_LIMIT')
  const headers = rows[0].map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '') : header)
  if (headers.length > MAX_COLUMNS || new Set(headers).size !== headers.length || headers.some(header => !CSV_FIELDS.has(header))) fail('CONNECTOR_INVALID_IMPORT')
  for (const required of COMMON_CSV_FIELDS) if (!headers.includes(required)) fail('CONNECTOR_INVALID_IMPORT')
  return rows.slice(1).filter(row => row.some(cell => cell !== '')).map(row => {
    if (row.length !== headers.length) fail('CONNECTOR_INVALID_IMPORT')
    const values = Object.fromEntries(headers.map((header, index) => [header, row[index]]))
    for (const cell of row) if (/^[\t ]*[=+\-@]/.test(cell)) fail('CONNECTOR_INVALID_IMPORT')
    const domain = healthDomain(values.domain)
    rejectWrongDomainCsv(values, domain)
    const payload = csvPayload(values, domain)
    const envelope: HealthIngestionEnvelope = {
      domain, source, sourceId: values.sourceId, observedAt: values.observedAt,
      evidenceClass: evidenceClass(values.evidenceClass), confidence: csvNumber(values.confidence), payload,
      parserVersion: 'structured-csv-v1',
    }
    validateEnvelope(envelope)
    return envelope
  })
}

function csvPayload(values: Record<string, string>, domain: 'diet' | 'fitness' | 'sleep'): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (domain === 'diet') {
    for (const key of ['caloriesKcal', 'proteinG', 'carbsG', 'fatG', 'waterMl']) addNumber(values, payload, key)
    if (values.foodName || values.portionGrams) {
      if (!values.foodName || !values.portionGrams) fail('CONNECTOR_INVALID_IMPORT')
      payload.foods = [{ name: values.foodName, portionGrams: csvNumber(values.portionGrams) }]
    }
  } else if (domain === 'fitness') {
    if (values.exercise) payload.exercise = values.exercise
    for (const key of ['durationMinutes', 'pain', 'rpe']) addNumber(values, payload, key)
    if (values.intensity) payload.intensity = values.intensity
    if (values.completed) payload.completed = csvBoolean(values.completed)
  } else {
    if (values.startedAt) payload.startedAt = values.startedAt
    if (values.endedAt) payload.endedAt = values.endedAt
    for (const key of ['durationMinutes', 'interruptions', 'subjectiveRecovery', 'recoveryScore']) addNumber(values, payload, key)
  }
  if (Object.keys(payload).length === 0) fail('CONNECTOR_INVALID_IMPORT')
  return payload
}

function rejectWrongDomainCsv(values: Record<string, string>, domain: 'diet' | 'fitness' | 'sleep'): void {
  const allowed = domain === 'diet'
    ? new Set([...COMMON_CSV_FIELDS, 'foodName', 'portionGrams', 'caloriesKcal', 'proteinG', 'carbsG', 'fatG', 'waterMl'])
    : domain === 'fitness'
      ? new Set([...COMMON_CSV_FIELDS, 'exercise', 'durationMinutes', 'intensity', 'pain', 'rpe', 'completed'])
      : new Set([...COMMON_CSV_FIELDS, 'startedAt', 'endedAt', 'durationMinutes', 'interruptions', 'subjectiveRecovery', 'recoveryScore'])
  for (const [key, value] of Object.entries(values)) if (value !== '' && !allowed.has(key)) fail('CONNECTOR_INVALID_IMPORT')
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let closedQuote = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') { cell += '"'; index += 1 }
      else if (character === '"') { quoted = false; closedQuote = true }
      else cell += character
      continue
    }
    if (closedQuote && character !== ',' && character !== '\r' && character !== '\n') fail('CONNECTOR_INVALID_IMPORT')
    if (character === '"') {
      if (cell !== '' || closedQuote) fail('CONNECTOR_INVALID_IMPORT')
      quoted = true
    } else if (character === ',') {
      row.push(cell); cell = ''; closedQuote = false
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && content[index + 1] === '\n') index += 1
      row.push(cell); rows.push(row); row = []; cell = ''; closedQuote = false
    } else {
      if (closedQuote) fail('CONNECTOR_INVALID_IMPORT')
      cell += character
    }
  }
  if (quoted) fail('CONNECTOR_INVALID_IMPORT')
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

function validateEnvelope(envelope: HealthIngestionEnvelope): void {
  try { normalizeHealthIngestionEnvelope(envelope) } catch { fail('CONNECTOR_INVALID_IMPORT') }
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(record).some(key => !allowed.has(key))) fail('CONNECTOR_INVALID_IMPORT')
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONNECTOR_INVALID_IMPORT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('CONNECTOR_INVALID_IMPORT')
  return value as Record<string, unknown>
}

function healthDomain(value: unknown): 'diet' | 'fitness' | 'sleep' {
  if (value !== 'diet' && value !== 'fitness' && value !== 'sleep') fail('CONNECTOR_INVALID_IMPORT')
  return value
}

function evidenceClass(value: unknown): HealthEvidenceClass {
  if (value !== 'measured' && value !== 'reported' && value !== 'inferred' && value !== 'derived') fail('CONNECTOR_INVALID_IMPORT')
  return value
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) fail('CONNECTOR_INVALID_IMPORT')
  return value
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('CONNECTOR_INVALID_IMPORT')
  return value as string[]
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('CONNECTOR_INVALID_IMPORT')
  return value
}

function csvNumber(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) fail('CONNECTOR_INVALID_IMPORT')
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail('CONNECTOR_INVALID_IMPORT')
  return parsed
}

function csvBoolean(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  fail('CONNECTOR_INVALID_IMPORT')
}

function addNumber(source: Record<string, string>, target: Record<string, unknown>, key: string): void {
  if (source[key]) target[key] = csvNumber(source[key])
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function fail(code: 'CONNECTOR_INVALID_IMPORT' | 'CONNECTOR_IMPORT_LIMIT'): never {
  throw new HealthConnectorError(code)
}
