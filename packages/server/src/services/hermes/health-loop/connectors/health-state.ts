import { getHealthOverview } from '../../health-state'
import { ingestHealthEnvelope } from '../ingestion'
import type { HealthIngestionEnvelope } from '../types'
import {
  compareEnvelopeCursor, compareHealthEnvelopeOrder, createConnectorCursor, createManagedHealthConnector,
  defaultHealthConnectorStateStore, HealthConnectorError, validateConnectorTimestamp, type HealthConnector,
  type HealthConnectorStateStore, type HealthEnvelopeIngestor,
} from '../connectors'

interface LegacyHealthSource {
  foodLogs?: Array<Record<string, unknown>>
  foodItems?: Array<Record<string, unknown>>
  workouts?: Array<Record<string, unknown>>
  dailyCheckins?: Array<Record<string, unknown>>
}

export function createHealthStateConnector(options: {
  profile?: string
  stateStore?: HealthConnectorStateStore
  ingest?: HealthEnvelopeIngestor
  readSource?: (profile?: string) => LegacyHealthSource
} = {}): HealthConnector {
  const profile = options.profile ?? 'default'
  const reader = options.readSource ?? (selected => getHealthOverview({ profile: selected, includeRecords: false }))
  return createManagedHealthConnector({
    stateStore: options.stateStore ?? defaultHealthConnectorStateStore(profile),
    ingest: options.ingest ?? ingestHealthEnvelope,
    source: {
      id: 'health-state',
      domains: ['diet', 'fitness', 'sleep'],
      cursorKind: 'timestamp',
      capabilities: { read: ['diet', 'fitness', 'sleep'], write: [] },
      access: async () => ({ configurationState: 'configured', authorizationState: 'not_required' }),
      load: async ({ cursor, now }) => {
        const source = reader(profile)
        const foodNames = new Map((source.foodItems ?? []).map(item => [String(item.id ?? ''), String(item.name ?? '')]))
        const envelopes = [
          ...(source.foodLogs ?? []).map(item => dietEnvelope(item, foodNames)),
          ...(source.workouts ?? []).map(fitnessEnvelope),
          ...(source.dailyCheckins ?? []).flatMap(item => {
            const envelope = sleepEnvelope(item)
            return envelope ? [envelope] : []
          }),
        ].sort(compareHealthEnvelopeOrder).filter(envelope => compareHealthEnvelopeOrder(envelope, { ...envelope, observedAt: now }) <= 0)
          .filter(envelope => !cursor || compareEnvelopeCursor(envelope, cursor) > 0)
        const last = envelopes.at(-1)
        return { envelopes, ...(last ? { cursor: createConnectorCursor(last.observedAt, last.sourceId) } : { cursor }) }
      },
    },
  })
}

function dietEnvelope(record: Record<string, unknown>, foodNames: Map<string, string>): HealthIngestionEnvelope {
  const id = identifier(record.id)
  const observedAt = timestamp(record.loggedAt ?? record.logged_at ?? record.createdAt ?? record.created_at)
  const nutrition = recordValue(record.nutrition ?? parseJsonField(record.nutrition_json))
  const payload: Record<string, unknown> = { mealTime: observedAt, confirmationStatus: 'confirmed', portionConfirmed: true }
  copyAliasedNumber(nutrition, payload, ['caloriesKcal', 'calories', 'kcal'], 'caloriesKcal')
  copyAliasedNumber(nutrition, payload, ['proteinG', 'protein'], 'proteinG')
  copyAliasedNumber(nutrition, payload, ['carbsG', 'carbs', 'carbohydrates'], 'carbsG')
  copyAliasedNumber(nutrition, payload, ['fatG', 'fat'], 'fatG')
  copyAliasedNumber(nutrition, payload, ['waterMl', 'water'], 'waterMl')
  if (nutrition.micros !== undefined) payload.micros = recordValue(nutrition.micros)
  const foodName = foodNames.get(String(record.foodItemId ?? record.food_item_id ?? ''))
  const quantity = record.quantity
  const unit = String(record.unit ?? '').toLowerCase()
  if (foodName && typeof quantity === 'number' && Number.isFinite(quantity) && ['g', 'gram', 'grams'].includes(unit)) {
    payload.foods = [{ name: foodName, portionGrams: quantity }]
  }
  if (Object.keys(payload).length === 3) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return { domain: 'diet', source: 'health-state', sourceId: `food-log:${id}`, observedAt, evidenceClass: 'reported', confidence: 1, payload }
}

function fitnessEnvelope(record: Record<string, unknown>): HealthIngestionEnvelope {
  const id = identifier(record.id)
  const observedAt = timestamp(record.startedAt ?? record.started_at ?? record.createdAt ?? record.created_at)
  const metrics = recordValue(record.metrics ?? parseJsonField(record.metrics_json))
  const payload: Record<string, unknown> = { exercise: nonEmptyString(record.title ?? record.kind ?? 'workout') }
  copyAliasedNumber(record, payload, ['durationMinutes', 'duration_minutes'], 'durationMinutes')
  copyAliasedNumber(metrics, payload, ['pain'], 'pain')
  copyAliasedNumber(metrics, payload, ['rpe'], 'rpe')
  copyAliasedNumber(metrics, payload, ['trainingLoad', 'training_load'], 'trainingLoad')
  const intensity = record.intensity
  if (typeof intensity === 'string' && intensity) payload.intensity = intensity
  if (typeof metrics.completed === 'boolean') payload.completed = metrics.completed
  if (Array.isArray(metrics.muscles)) payload.muscles = metrics.muscles
  if (Array.isArray(metrics.exercises)) payload.exercises = metrics.exercises
  return { domain: 'fitness', source: 'health-state', sourceId: `workout:${id}`, observedAt, evidenceClass: 'reported', confidence: 1, payload }
}

function sleepEnvelope(record: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(record.id)
  const sleep = recordValue(record.sleep ?? parseJsonField(record.sleep_json))
  const allowed = new Set([
    'startedAt', 'started_at', 'endedAt', 'ended_at', 'durationMinutes', 'duration_minutes', 'interruptions', 'stages',
    'restingHeartRateBpm', 'resting_heart_rate_bpm', 'restingRespiratoryRateBrpm', 'resting_respiratory_rate_brpm',
    'restingSpo2Percent', 'resting_spo2_percent', 'freshnessMinutes', 'freshness_minutes',
    'subjectiveRecovery', 'subjective_recovery', 'recoveryScore', 'recovery_score',
  ])
  const keys = Object.keys(sleep)
  if (keys.length === 0) return null
  if (keys.some(key => !allowed.has(key))) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  const observedAt = timestamp(sleep.endedAt ?? sleep.ended_at ?? record.createdAt ?? record.created_at ?? dateAtMidnight(record.checkinDate ?? record.checkin_date))
  const payload: Record<string, unknown> = {}
  copyString(sleep, payload, ['startedAt', 'started_at'], 'startedAt')
  copyString(sleep, payload, ['endedAt', 'ended_at'], 'endedAt')
  copyAliasedNumber(sleep, payload, ['durationMinutes', 'duration_minutes'], 'durationMinutes')
  copyAliasedNumber(sleep, payload, ['interruptions'], 'interruptions')
  copyAliasedNumber(sleep, payload, ['restingHeartRateBpm', 'resting_heart_rate_bpm'], 'restingHeartRateBpm')
  copyAliasedNumber(sleep, payload, ['restingRespiratoryRateBrpm', 'resting_respiratory_rate_brpm'], 'restingRespiratoryRateBrpm')
  copyAliasedNumber(sleep, payload, ['restingSpo2Percent', 'resting_spo2_percent'], 'restingSpo2Percent')
  copyAliasedNumber(sleep, payload, ['freshnessMinutes', 'freshness_minutes'], 'freshnessMinutes')
  copyAliasedNumber(sleep, payload, ['subjectiveRecovery', 'subjective_recovery'], 'subjectiveRecovery')
  copyAliasedNumber(sleep, payload, ['recoveryScore', 'recovery_score'], 'recoveryScore')
  if (sleep.stages !== undefined) payload.stages = recordValue(sleep.stages)
  if (Object.keys(payload).length === 0) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return { domain: 'sleep', source: 'health-state', sourceId: `sleep:${id}`, observedAt, evidenceClass: 'reported', confidence: 1, payload }
}

function parseJsonField(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 65_536) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  try { return JSON.parse(value) } catch { throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT') }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return value as Record<string, unknown>
}

function copyAliasedNumber(source: Record<string, unknown>, target: Record<string, unknown>, aliases: string[], key: string): void {
  const values = aliases.filter(alias => source[alias] !== undefined).map(alias => source[alias])
  if (values.length > 1 && values.some(value => value !== values[0])) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  if (values.length) target[key] = values[0]
}

function copyString(source: Record<string, unknown>, target: Record<string, unknown>, aliases: string[], key: string): void {
  const value = aliases.map(alias => source[alias]).find(item => item !== undefined)
  if (value !== undefined) target[key] = nonEmptyString(value)
}

function identifier(value: unknown): string {
  const result = nonEmptyString(value)
  if (result.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return result
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return value
}

function timestamp(value: unknown): string {
  const result = nonEmptyString(value)
  try { return validateConnectorTimestamp(result) } catch { throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT') }
}

function dateAtMidnight(value: unknown): string {
  const date = nonEmptyString(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HealthConnectorError('CONNECTOR_INVALID_IMPORT')
  return `${date}T00:00:00Z`
}
