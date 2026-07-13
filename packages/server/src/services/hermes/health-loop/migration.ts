import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { getHealthOverview, getHealthStateDbPath, type HealthOverview } from '../health-state'
import { listProfileNamesFromDisk } from '../hermes-profile'
import {
  claimTwinImportRun, completeTwinImportRun, failTwinImportRun, renewTwinImportRun, type TwinImportRunLeaseOptions,
} from '../personal-twin/legacy-import'
import { ingestHealthEnvelopesAtomically } from './ingestion'
import { HEALTH_DOMAINS, HealthIngestionError, type HealthDomain, type HealthEvidenceClass, type HealthIngestionEnvelope } from './types'

const MIGRATION_VERSION = 'health-migration-v2'
const MAPPING_VERSION = 2
const IMPORT_SOURCE = 'legacy-health-state'
const INTERNAL_KINDS = new Set(['lab', 'lab_result', 'checkup', 'blood', 'blood_test', 'urine', 'urine_test', 'vitamin', 'mineral', 'micronutrient', 'biomarker', 'vital', 'blood_pressure'])

export interface HealthMigrationCounts {
  read: number
  ingested: number
  replayed: number
  skipped: number
  conflicts: number
  errors: number
}

export interface HealthMigrationResult {
  runId: string
  status: 'completed'
  fingerprint: string
  version: string
  profiles: string[]
  counts: HealthMigrationCounts
  domainCounts: Record<HealthDomain, number>
  startedAt: string
  completedAt: string
}

interface CollectedHealthSources {
  entries: CollectedSourceEntry[]
  read: number
  skipped: number
}

interface CollectedSourceEntry {
  identity: string
  raw: Record<string, unknown>
  envelopes: HealthIngestionEnvelope[]
  skippedReason?: string
  errorCode?: 'HEALTH_MIGRATION_INVALID_SOURCE'
}

function emptyCounts(): HealthMigrationCounts {
  return { read: 0, ingested: 0, replayed: 0, skipped: 0, conflicts: 0, errors: 0 }
}

function emptyDomainCounts(): Record<HealthDomain, number> {
  return Object.fromEntries(HEALTH_DOMAINS.map(domain => [domain, 0])) as Record<HealthDomain, number>
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareUtf8(left, right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function profilesOnDisk(requested?: string[]): string[] {
  const known = new Set(listProfileNamesFromDisk().filter(profile => existsSync(getHealthStateDbPath(profile))))
  const selected = requested?.length ? requested : [...known]
  return [...new Set(selected.map(profile => profile.trim()).filter(profile => known.has(profile)))]
    .sort((left, right) => left === 'default' ? -1 : right === 'default' ? 1 : compareUtf8(left, right))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 65_536) throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid record')
    return parsed as Record<string, unknown>
  } catch { throw new Error('HEALTH_MIGRATION_INVALID_SOURCE') }
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) ? value : null
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 ? value : null
}

function aliasedValue(source: Record<string, unknown>, keys: string[]): unknown {
  const supplied = keys.filter(key => source[key] !== undefined && source[key] !== null).map(key => source[key])
  if (supplied.length > 1 && supplied.some(value => stableJson(value) !== stableJson(supplied[0]))) throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
  return supplied[0]
}

function copyAliasedNumber(source: Record<string, unknown>, target: Record<string, unknown>, keys: string[], targetKey: string): void {
  const value = aliasedValue(source, keys)
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
  target[targetKey] = value
}

function copyAliasedString(source: Record<string, unknown>, target: Record<string, unknown>, keys: string[], targetKey: string): void {
  const value = aliasedValue(source, keys)
  if (value === undefined) return
  if (typeof value !== 'string' || !value) throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
  target[targetKey] = value
}

function envelope(profile: string, domain: HealthDomain, id: string, observedAt: string, evidenceClass: HealthEvidenceClass, payload: Record<string, unknown>): HealthIngestionEnvelope {
  const rawSourceId = `${id}:${profile}`
  const sourceId = rawSourceId.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(rawSourceId)
    ? rawSourceId
    : `${id.slice(0, 120)}:digest-${createHash('sha256').update(rawSourceId).digest('hex')}`
  return { domain, source: IMPORT_SOURCE, sourceId, observedAt, evidenceClass, confidence: 1, payload, parserVersion: MIGRATION_VERSION }
}

function scaleEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const value = record(item.value); const observedAt = timestamp(aliasedValue(value, ['measuredAt', 'measured_at']) ?? item.recordedAt)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = {}
  const fields: Array<[string, string[]]> = [
    ['weightKg', ['weightKg', 'weight_kg']], ['bmi', ['bmi']], ['bodyFatPercent', ['bodyFatPercent', 'body_fat_percent']],
    ['muscleMassKg', ['muscleMassKg', 'muscle_mass_kg']], ['boneSaltKg', ['boneSaltKg', 'bone_salt_kg', 'boneMassKg', 'bone_mass_kg']],
    ['bodyWaterPercent', ['bodyWaterPercent', 'body_water_percent', 'waterPercent', 'water_percent']],
    ['visceralFatLevel', ['visceralFatLevel', 'visceral_fat_level']], ['basalMetabolismKcal', ['basalMetabolismKcal', 'basal_metabolism_kcal', 'bmrKcal', 'bmr_kcal']],
    ['proteinPercent', ['proteinPercent', 'protein_percent']], ['subcutaneousFatPercent', ['subcutaneousFatPercent', 'subcutaneous_fat_percent']],
    ['fatMassKg', ['fatMassKg', 'fat_mass_kg']], ['leanBodyMassKg', ['leanBodyMassKg', 'lean_body_mass_kg', 'leanMassKg', 'lean_mass_kg']],
    ['skeletalMusclePercent', ['skeletalMusclePercent', 'skeletal_muscle_percent']], ['bodyScore', ['bodyScore', 'body_score']],
    ['idealWeightKg', ['idealWeightKg', 'ideal_weight_kg']], ['waistHipRatio', ['waistHipRatio', 'waist_hip_ratio']],
    ['bodyAgeYears', ['bodyAgeYears', 'body_age_years', 'bodyAge', 'body_age']],
  ]
  for (const [target, aliases] of fields) copyAliasedNumber(value, payload, aliases, target)
  copyAliasedString(value, payload, ['deviceModel', 'device_model', 'sourceModel', 'source_model'], 'deviceModel')
  return Object.keys(payload).length ? envelope(profile, 'body_composition', `records:scale-reading:${id}`, observedAt, 'measured', payload) : null
}

function measurementsEnvelopes(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope[] {
  const id = identifier(item.id); const observedAt = timestamp(item.recordedAt); const value = record(item.value)
  if (!id || !observedAt) return []
  const values = record(value.measurements ?? value); const payload: Record<string, unknown> = {}
  const aliases: Array<[string, string[]]> = [
    ['chestCm', ['chestCm', 'chest_cm']], ['waistCm', ['waistCm', 'waist_cm']], ['hipCm', ['hipCm', 'hip_cm']],
    ['leftArmCm', ['leftArmCm', 'left_arm_cm', 'left_upper_arm_cm', 'left_upper_arm_relaxed_cm']],
    ['rightArmCm', ['rightArmCm', 'right_arm_cm', 'right_upper_arm_cm', 'right_upper_arm_relaxed_cm']],
    ['leftThighCm', ['leftThighCm', 'left_thigh_cm']], ['rightThighCm', ['rightThighCm', 'right_thigh_cm']],
    ['leftCalfCm', ['leftCalfCm', 'left_calf_cm']], ['rightCalfCm', ['rightCalfCm', 'right_calf_cm']],
  ]
  for (const [target, sources] of aliases) {
    copyAliasedNumber(values, payload, sources, target)
  }
  copyAliasedString(value, payload, ['method'], 'method')
  copyAliasedString(value, payload, ['calibrationMethod', 'calibration_method'], 'calibrationMethod')
  copyAliasedString(value, payload, ['calibrationId', 'calibration_id'], 'calibrationId')
  copyAliasedString(value, payload, ['modelVersion', 'model_version'], 'modelVersion')
  copyAliasedNumber(value, payload, ['modelConfidence', 'model_confidence'], 'modelConfidence')
  const evidenceClass = hasModelEvidence(item, value) ? 'inferred' : 'reported'
  const envelopes: HealthIngestionEnvelope[] = []
  if (Object.keys(payload).length) envelopes.push(envelope(profile, 'measurements', `body-profile:measurements:${id}:measurements`, observedAt, evidenceClass, payload))
  const bodyPayload: Record<string, unknown> = {}
  copyAliasedNumber(value, bodyPayload, ['weightKg', 'weight_kg'], 'weightKg')
  copyAliasedNumber(value, bodyPayload, ['bodyFatPercent', 'body_fat_percent'], 'bodyFatPercent')
  if (Object.keys(bodyPayload).length) envelopes.push(envelope(profile, 'body_composition', `body-profile:measurements:${id}:body-composition`, observedAt, evidenceClass, bodyPayload))
  return envelopes
}

function hasModelEvidence(item: Record<string, unknown>, value: Record<string, unknown>): boolean {
  const source = String(item.source ?? '').toLowerCase()
  return /(?:vision|camera|model)/.test(source) || typeof aliasedValue(value, ['modelVersion', 'model_version']) === 'string'
}

function postureEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.recordedAt); const value = record(item.value)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = {}
  for (const key of ['findings', 'angles', 'landmarks', 'capture']) if (value[key] !== undefined) payload[key] = value[key]
  copyAliasedString(value, payload, ['modelVersion', 'model_version'], 'modelVersion')
  copyAliasedNumber(value, payload, ['modelConfidence', 'model_confidence'], 'modelConfidence')
  const issues = aliasedValue(value, ['issues', 'reportedIssues', 'reported_issues']); if (issues !== undefined) payload.reportedIssues = issues
  const priority = aliasedValue(value, ['priority', 'reportedPriority', 'reported_priority']); if (priority !== undefined) payload.reportedPriority = priority
  const reportedPain = aliasedValue(value, ['pain', 'reportedPain', 'reported_pain'])
  if (reportedPain !== undefined && !Array.isArray(reportedPain)) throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
  if (Array.isArray(reportedPain)) payload.reportedPain = reportedPain.map(itemPain => {
    const pain = record(itemPain)
    return { area: pain.area, score: Object.prototype.hasOwnProperty.call(pain, 'score') ? pain.score : null }
  })
  const chain = aliasedValue(value, ['compensationChain', 'compensation_chain', 'reportedCompensationChain', 'reported_compensation_chain'])
  if (chain !== undefined) payload.reportedCompensationChain = chain
  return Object.keys(payload).length ? envelope(profile, 'posture', `body-profile:posture:${id}`, observedAt, hasModelEvidence(item, value) ? 'inferred' : 'reported', payload) : null
}

function skinEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.recordedAt); const value = record(item.value)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = {}
  for (const key of ['region', 'appearances', 'trend', 'device']) if (value[key] !== undefined) payload[key] = value[key]
  copyAliasedString(value, payload, ['lightingProfile', 'lighting_profile'], 'lightingProfile')
  copyAliasedString(value, payload, ['comparisonBaseline', 'comparison_baseline'], 'comparisonBaseline')
  copyAliasedNumber(value, payload, ['captureQuality', 'capture_quality'], 'captureQuality')
  copyAliasedNumber(value, payload, ['distanceCm', 'distance_cm'], 'distanceCm')
  const concerns = aliasedValue(value, ['concerns', 'reportedConcerns', 'reported_concerns']); if (concerns !== undefined) payload.reportedConcerns = concerns
  const routine = aliasedValue(value, ['routine', 'reportedRoutine', 'reported_routine']); if (routine !== undefined) payload.reportedRoutine = routine
  return Object.keys(payload).length ? envelope(profile, 'skin', `body-profile:skin:${id}`, observedAt, hasModelEvidence(item, value) ? 'inferred' : 'reported', payload) : null
}

function internalEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const kind = String(item.kind ?? 'unknown'); const observedAt = timestamp(item.recordedAt); const value = record(item.value)
  if (!id || !observedAt || typeof value.value !== 'number' || !Number.isFinite(value.value)) return null
  const rawKey = aliasedValue(value, ['marker', 'key']) ?? item.title
  const key = identifier(rawKey) ?? (typeof rawKey === 'string' ? rawKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : '')
  const units = [value.unit, item.unit].filter(unit => unit !== undefined && unit !== null && unit !== '')
  if (units.length > 1 && units.some(unit => unit !== units[0])) throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
  const unit = typeof units[0] === 'string' ? units[0] : null
  if (!key || !unit) return null
  const marker: Record<string, unknown> = { key, value: value.value, unit, measuredAt: observedAt }
  if (typeof item.title === 'string' && item.title) marker.displayLabel = item.title
  copyAliasedNumber(value, marker, ['referenceLow', 'reference_low'], 'referenceLow')
  copyAliasedNumber(value, marker, ['referenceHigh', 'reference_high'], 'referenceHigh')
  const referenceRange = aliasedValue(value, ['referenceRange', 'reference_range'])
  if (marker.referenceLow === undefined && marker.referenceHigh === undefined && typeof referenceRange === 'string') {
    const match = referenceRange.trim().match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/)
    if (match) { marker.referenceLow = Number(match[1]); marker.referenceHigh = Number(match[2]) }
  }
  const providerFlag = aliasedValue(value, ['providerAbnormalFlag', 'provider_abnormal_flag', 'providerFlag', 'provider_flag', 'status'])
  if (typeof providerFlag === 'string' && providerFlag) marker.providerAbnormalFlag = providerFlag
  const source = String(item.source ?? '').toLowerCase()
  const explicitlyReported = /(?:manual|user|self|reported|obsidian)/.test(source)
  const reliableKind = new Set(['lab', 'lab_result', 'blood_test', 'urine_test', 'blood', 'urine', 'biomarker', 'vital', 'blood_pressure']).has(kind)
  const reliableSource = /(?:laboratory|\blab\b|hospital|clinic|device|checkup)/.test(source)
  const evidenceClass: HealthEvidenceClass = !explicitlyReported && (reliableKind || reliableSource) ? 'measured' : 'reported'
  return envelope(profile, 'internal_health', `internal-markers:${kind}:${id}`, observedAt, evidenceClass, { markers: [marker], reportDate: observedAt.slice(0, 10) })
}

function dietEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.loggedAt ?? item.createdAt); const nutrition = record(item.nutrition)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = { mealTime: observedAt, portionConfirmed: true, confirmationStatus: 'confirmed' }
  const aliases: Array<[string, string[]]> = [
    ['caloriesKcal', ['caloriesKcal', 'calories_kcal', 'calories', 'kcal']], ['proteinG', ['proteinG', 'protein_g', 'protein']],
    ['carbsG', ['carbsG', 'carbs_g', 'carbs', 'carbohydrates']], ['fatG', ['fatG', 'fat_g', 'fat']], ['waterMl', ['waterMl', 'water_ml', 'water']],
  ]
  for (const [target, sources] of aliases) copyAliasedNumber(nutrition, payload, sources, target)
  if (nutrition.micros !== undefined) {
    const rawMicros = record(nutrition.micros); const micros: Record<string, unknown> = {}
    for (const [target, sources] of [
      ['fiberG', ['fiberG', 'fiber_g']], ['sodiumMg', ['sodiumMg', 'sodium_mg']], ['potassiumMg', ['potassiumMg', 'potassium_mg']],
      ['calciumMg', ['calciumMg', 'calcium_mg']], ['ironMg', ['ironMg', 'iron_mg']],
    ] as Array<[string, string[]]>) copyAliasedNumber(rawMicros, micros, sources, target)
    if (Object.keys(micros).length) payload.micros = micros
  }
  return Object.keys(payload).length > 3 ? envelope(profile, 'diet', `food-logs:${id}`, observedAt, 'reported', payload) : null
}

function fitnessEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.startedAt ?? item.createdAt); const metrics = record(item.metrics)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = { exercise: typeof item.title === 'string' && item.title ? item.title : typeof item.kind === 'string' ? item.kind : 'workout' }
  copyAliasedNumber(item, payload, ['durationMinutes', 'duration_minutes'], 'durationMinutes')
  copyAliasedNumber(metrics, payload, ['pain'], 'pain'); copyAliasedNumber(metrics, payload, ['rpe'], 'rpe')
  copyAliasedNumber(metrics, payload, ['trainingLoad', 'training_load'], 'trainingLoad')
  for (const key of ['completed']) if (typeof metrics[key] === 'boolean') payload[key] = metrics[key]
  for (const key of ['exercises', 'muscles']) if (metrics[key] !== undefined) payload[key] = metrics[key]
  if (typeof item.intensity === 'string' && item.intensity) payload.intensity = item.intensity
  return envelope(profile, 'fitness', `workouts:${id}`, observedAt, 'reported', payload)
}

function sleepEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const sleep = item.sleep !== undefined ? record(item.sleep) : jsonRecord(item.sleep_json)
  const checkinDate = item.checkinDate ?? item.checkin_date
  const endedAt = aliasedValue(sleep, ['endedAt', 'ended_at'])
  const observedAt = timestamp(endedAt ?? item.createdAt ?? item.created_at) ?? (typeof checkinDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(checkinDate) ? `${checkinDate}T00:00:00Z` : null)
  if (!id || !observedAt || Object.keys(sleep).length === 0) return null
  const payload: Record<string, unknown> = {}
  copyAliasedString(sleep, payload, ['startedAt', 'started_at'], 'startedAt')
  copyAliasedString(sleep, payload, ['endedAt', 'ended_at'], 'endedAt')
  const scalarFields: Array<[string, string[]]> = [
    ['durationMinutes', ['durationMinutes', 'duration_minutes']], ['interruptions', ['interruptions']],
    ['restingHeartRateBpm', ['restingHeartRateBpm', 'resting_heart_rate_bpm', 'restingHeartRate', 'resting_heart_rate']],
    ['hrvMs', ['hrvMs', 'hrv_ms']], ['restingRespiratoryRateBrpm', ['restingRespiratoryRateBrpm', 'resting_respiratory_rate_brpm']],
    ['restingSpo2Percent', ['restingSpo2Percent', 'resting_spo2_percent']], ['freshnessMinutes', ['freshnessMinutes', 'freshness_minutes']],
    ['subjectiveRecovery', ['subjectiveRecovery', 'subjective_recovery']], ['recoveryScore', ['recoveryScore', 'recovery_score']],
  ]
  for (const [target, sources] of scalarFields) copyAliasedNumber(sleep, payload, sources, target)
  const stages = aliasedValue(sleep, ['stages'])
  if (stages !== undefined) {
    const rawStages = record(stages); const normalizedStages: Record<string, unknown> = {}
    for (const [target, sources] of [
      ['deepMinutes', ['deepMinutes', 'deep_minutes']], ['remMinutes', ['remMinutes', 'rem_minutes']],
      ['lightMinutes', ['lightMinutes', 'light_minutes']], ['awakeMinutes', ['awakeMinutes', 'awake_minutes']],
    ] as Array<[string, string[]]>) copyAliasedNumber(rawStages, normalizedStages, sources, target)
    payload.stages = normalizedStages
  }
  return Object.keys(payload).length ? envelope(profile, 'sleep', `daily-checkins:${id}`, observedAt, 'reported', payload) : null
}

function collectProfile(profile: string, source: HealthOverview): CollectedHealthSources {
  const entries: CollectedSourceEntry[] = []
  const add = (collection: string, item: Record<string, unknown>, mapper: () => HealthIngestionEnvelope | HealthIngestionEnvelope[] | null, skippedReason: string): void => {
    const rawId = identifier(item.id) ?? `digest-${createHash('sha256').update(stableJson(item)).digest('hex')}`
    const identity = `${profile}:${collection}:${rawId}`
    try {
      const mapped = mapper(); const envelopes = Array.isArray(mapped) ? mapped : mapped ? [mapped] : []
      entries.push({ identity, raw: item, envelopes, ...(envelopes.length ? {} : { skippedReason }) })
    } catch {
      entries.push({ identity, raw: item, envelopes: [], errorCode: 'HEALTH_MIGRATION_INVALID_SOURCE' })
    }
  }
  for (const item of source.records) {
    const kind = String(item.kind ?? '')
    if (kind === 'scale_reading') add(`records:${kind}`, item, () => scaleEnvelope(profile, item), 'unsupported_scale_record')
    else if (kind === 'body_measurement') add('body-profile:measurements', item, () => measurementsEnvelopes(profile, item), 'unsupported_measurement_record')
    else if (kind === 'posture_assessment') add('body-profile:posture', item, () => postureEnvelope(profile, item), 'unsupported_posture_record')
    else if (kind === 'skin_assessment') add('body-profile:skin', item, () => skinEnvelope(profile, item), 'unsupported_skin_record')
    else if (INTERNAL_KINDS.has(kind)) add(`internal-markers:${kind}`, item, () => internalEnvelope(profile, item), 'unsupported_internal_marker')
    else add(`records:${kind || 'unknown'}`, item, () => null, 'unsupported_record_kind')
  }
  for (const item of source.foodLogs) add('food-logs', item, () => dietEnvelope(profile, item), 'unsupported_food_log')
  for (const item of source.workouts) add('workouts', item, () => fitnessEnvelope(profile, item), 'unsupported_workout')
  for (const item of source.dailyCheckins) add('daily-checkins', item, () => sleepEnvelope(profile, item), 'unsupported_daily_checkin')
  entries.sort((left, right) => compareUtf8(left.identity, right.identity) || compareUtf8(stableJson(left.raw), stableJson(right.raw)))
  return { entries, read: entries.length, skipped: entries.filter(entry => entry.skippedReason !== undefined).length }
}

function collect(profiles: string[]): CollectedHealthSources {
  const output: CollectedHealthSources = { entries: [], read: 0, skipped: 0 }
  for (const profile of profiles) {
    const item = collectProfile(profile, getHealthOverview({ profile, includeRecords: true }))
    output.entries.push(...item.entries); output.read += item.read; output.skipped += item.skipped
  }
  output.entries.sort((left, right) => compareUtf8(left.identity, right.identity) || compareUtf8(stableJson(left.raw), stableJson(right.raw)))
  return output
}

function fingerprint(entries: CollectedSourceEntry[]): string {
  const snapshot = entries.map(entry => ({
    identity: entry.identity, raw: entry.raw,
    outcome: entry.errorCode ? { error: entry.errorCode }
      : entry.skippedReason ? { skipped: entry.skippedReason }
        : { mapped: entry.envelopes.map(item => ({ domain: item.domain, sourceId: item.sourceId })) },
  }))
  return createHash('sha256').update(stableJson({ version: MIGRATION_VERSION, mappingVersion: MAPPING_VERSION, records: snapshot })).digest('hex')
}

function flatRunCounts(counts: HealthMigrationCounts, domains: Record<HealthDomain, number>): Record<string, number> {
  return {
    ...counts, mappingVersion: MAPPING_VERSION, mappedTotal: counts.ingested + counts.replayed,
    ...Object.fromEntries(HEALTH_DOMAINS.map(domain => [`domain${domain.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`, domains[domain]])),
  }
}

function fromStoredCounts(values: Record<string, number>): { counts: HealthMigrationCounts; domains: Record<HealthDomain, number> } {
  const countKeys = ['read', 'ingested', 'replayed', 'skipped', 'conflicts', 'errors']
  const domainKeys = HEALTH_DOMAINS.map(domain => `domain${domain.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`)
  const expected = [...countKeys, 'mappingVersion', 'mappedTotal', ...domainKeys].sort(compareUtf8)
  const actual = Object.keys(values).sort(compareUtf8)
  if (stableJson(actual) !== stableJson(expected) || values.mappingVersion !== MAPPING_VERSION) throw new Error('HEALTH_MIGRATION_RUN_CORRUPT')
  const counts = emptyCounts(); const domains = emptyDomainCounts()
  for (const key of Object.keys(counts) as Array<keyof HealthMigrationCounts>) counts[key] = values[key]
  for (const domain of HEALTH_DOMAINS) domains[domain] = values[`domain${domain.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`]
  const domainTotal = Object.values(domains).reduce((sum, value) => sum + value, 0)
  if (counts.conflicts !== 0 || counts.errors !== 0 || counts.skipped > counts.read
    || values.mappedTotal !== counts.ingested + counts.replayed || domainTotal !== values.mappedTotal
    || values.mappedTotal < counts.read - counts.skipped) throw new Error('HEALTH_MIGRATION_RUN_CORRUPT')
  return { counts, domains }
}

export function syncLegacyHealthTwinSources(options: { profiles?: string[]; lease?: TwinImportRunLeaseOptions } = {}): HealthMigrationResult {
  const profiles = profilesOnDisk(options.profiles)
  let collected: CollectedHealthSources
  try { collected = collect(profiles) } catch { throw new Error('HEALTH_MIGRATION_SOURCE_UNAVAILABLE') }
  const sourceFingerprint = fingerprint(collected.entries)
  let claim = claimTwinImportRun({ source: IMPORT_SOURCE, fingerprint: sourceFingerprint, version: MIGRATION_VERSION }, options.lease)
  if (!claim.owner) {
    if (claim.status !== 'completed' || !claim.completedAt) throw new Error('HEALTH_MIGRATION_IN_PROGRESS')
    const stored = fromStoredCounts(claim.counts)
    return { runId: claim.runId, status: 'completed', fingerprint: sourceFingerprint, version: MIGRATION_VERSION, profiles, counts: stored.counts, domainCounts: stored.domains, startedAt: claim.startedAt, completedAt: claim.completedAt }
  }
  const counts = emptyCounts(); counts.read = collected.read; counts.skipped = collected.skipped
  const domains = emptyDomainCounts()
  try {
    for (const entry of collected.entries) {
      claim = renewTwinImportRun(claim, options.lease)
      if (entry.errorCode) { counts.errors += 1; throw new Error(entry.errorCode) }
      if (entry.envelopes.length === 0) {
        claim = renewTwinImportRun(claim, options.lease)
        continue
      }
      let ingested
      try { ingested = ingestHealthEnvelopesAtomically(entry.envelopes) } catch (error) {
        if (error instanceof HealthIngestionError && error.code === 'HEALTH_INGESTION_IDENTITY_CONFLICT') {
          counts.conflicts += 1
          throw new Error('HEALTH_MIGRATION_SOURCE_CONFLICT')
        }
        counts.errors += 1
        throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
      }
      for (let index = 0; index < entry.envelopes.length; index += 1) {
        domains[entry.envelopes[index].domain] += 1
        if (ingested[index].status === 'replayed') counts.replayed += 1
        else counts.ingested += 1
      }
      claim = renewTwinImportRun(claim, options.lease)
    }
    const completed = completeTwinImportRun(claim, flatRunCounts(counts, domains), options.lease)
    return { runId: completed.runId, status: 'completed', fingerprint: sourceFingerprint, version: MIGRATION_VERSION, profiles, counts, domainCounts: domains, startedAt: completed.startedAt, completedAt: completed.completedAt! }
  } catch (error) {
    if (error instanceof Error && error.message === 'TWIN_IMPORT_RUN_LEASE_LOST') throw new Error('HEALTH_MIGRATION_LEASE_LOST')
    const code = error instanceof Error && /^HEALTH_MIGRATION_[A-Z_]+$/.test(error.message) ? error.message : 'HEALTH_MIGRATION_FAILED'
    try { failTwinImportRun(claim, code, flatRunCounts(counts, domains), options.lease) } catch (failure) {
      if (failure instanceof Error && failure.message === 'TWIN_IMPORT_RUN_LEASE_LOST') throw new Error('HEALTH_MIGRATION_LEASE_LOST')
      throw failure
    }
    throw new Error(code)
  }
}
