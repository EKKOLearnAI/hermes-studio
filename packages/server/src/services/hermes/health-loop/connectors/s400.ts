import { getScaleSyncSettings, runScaleSync } from '../../scale-sync'
import { ingestHealthEnvelope } from '../ingestion'
import type { HealthIngestionEnvelope } from '../types'
import {
  compareHealthEnvelopeOrder, createConnectorCursor, createManagedHealthConnector, defaultHealthConnectorStateStore, HealthConnectorError,
  type HealthConnector, type HealthConnectorStateStore, type HealthEnvelopeIngestor,
} from '../connectors'

interface S400Settings {
  configured: boolean
}

interface S400SyncResult {
  status: 'synced' | 'skipped' | 'failed'
  reason?: string
  readings: Array<Record<string, unknown>>
}

export function createS400HealthConnector(options: {
  profile?: string
  stateStore?: HealthConnectorStateStore
  ingest?: HealthEnvelopeIngestor
  getSettings?: (profile?: string) => Promise<S400Settings>
  runSync?: (profile?: string, actor?: string) => Promise<S400SyncResult>
} = {}): HealthConnector {
  const profile = options.profile ?? 'default'
  const settingsReader = options.getSettings ?? getScaleSyncSettings
  const syncRunner = options.runSync ?? runScaleSync
  return createManagedHealthConnector({
    stateStore: options.stateStore ?? defaultHealthConnectorStateStore(profile),
    ingest: options.ingest ?? ingestHealthEnvelope,
    source: {
      id: 's400',
      domains: ['body_composition'],
      configured: async () => Boolean((await settingsReader(profile)).configured),
      load: async () => {
        const result = await syncRunner(profile, 'health-connector')
        if (result.status !== 'synced') throw new HealthConnectorError(scaleErrorCode(result.reason))
        const envelopes = result.readings.map(readingToEnvelope)
          .sort(compareHealthEnvelopeOrder)
        const last = envelopes.at(-1)
        return { envelopes, ...(last ? { cursor: createConnectorCursor(last.observedAt, last.sourceId) } : {}) }
      },
    },
  })
}

function readingToEnvelope(record: Record<string, unknown>): HealthIngestionEnvelope {
  const value = plainRecord(record.value)
  const sourceId = requiredIdentifier(record.id, 200)
  const observedAt = requiredString(value.measuredAt ?? record.recordedAt)
  const payload: Record<string, unknown> = {}
  copyNumber(value, payload, 'weightKg')
  copyNumber(value, payload, 'bmi')
  copyNumber(value, payload, 'bodyFatPercent')
  copyNumber(value, payload, 'muscleMassKg')
  copyNumber(value, payload, 'boneSaltKg')
  copyNumber(value, payload, 'bodyWaterPercent')
  copyNumber(value, payload, 'visceralFatLevel')
  copyNumber(value, payload, 'basalMetabolismKcal')
  copyNumber(value, payload, 'proteinPercent')
  copyNumber(value, payload, 'fatMassKg')
  copyNumber(value, payload, 'leanBodyMassKg')
  copyNumber(value, payload, 'bodyScore')
  copyNumber(value, payload, 'waistHipRatio')
  if (value.bodyAge !== null && value.bodyAge !== undefined) payload.bodyAgeYears = value.bodyAge
  if (value.sourceModel !== null && value.sourceModel !== undefined) payload.deviceModel = requiredString(value.sourceModel)
  if (!Object.prototype.hasOwnProperty.call(payload, 'weightKg')) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return {
    domain: 'body_composition', source: 's400', sourceId, observedAt,
    evidenceClass: 'measured', confidence: 1, payload,
  }
}

function scaleErrorCode(reason: string | undefined): string {
  const known: Record<string, string> = {
    disabled: 'CONNECTOR_NOT_CONFIGURED',
    missing_xiaomi_credentials: 'CONNECTOR_NOT_CONFIGURED',
    missing_scaleconnect_path: 'CONNECTOR_NOT_CONFIGURED',
    untrusted_scaleconnect_path: 'CONNECTOR_PROVIDER_UNTRUSTED',
    untrusted_scaleconnect_state_path: 'CONNECTOR_PROVIDER_UNTRUSTED',
    scaleconnect_not_found: 'CONNECTOR_PROVIDER_UNAVAILABLE',
    xiaomi_identity_verification_required: 'CONNECTOR_AUTHORIZATION_REQUIRED',
    scaleconnect_load_data_failed: 'CONNECTOR_PROVIDER_FAILED',
    scaleconnect_failed: 'CONNECTOR_PROVIDER_FAILED',
  }
  return known[reason ?? ''] ?? 'CONNECTOR_PROVIDER_FAILED'
}

function copyNumber(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key]
  if (value !== null && value !== undefined) target[key] = value
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return value
}

function requiredIdentifier(value: unknown, max: number): string {
  const text = requiredString(value)
  if (text.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return text
}
