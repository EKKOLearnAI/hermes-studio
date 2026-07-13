import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { getHealthOverview, getHealthStateDbPath, type HealthOverview } from '../health-state'
import { listProfileNamesFromDisk } from '../hermes-profile'
import { claimTwinImportRun, completeTwinImportRun, failTwinImportRun } from '../personal-twin/legacy-import'
import { withPersonalTwinDb } from '../personal-twin/database'
import { ingestHealthEnvelope } from './ingestion'
import { HEALTH_DOMAINS, HealthIngestionError, type HealthDomain, type HealthEvidenceClass, type HealthIngestionEnvelope } from './types'

const MIGRATION_VERSION = 'health-migration-v1'
const IMPORT_SOURCE = 'legacy-health-state'
const INTERNAL_KINDS = new Set(['lab', 'checkup', 'blood', 'urine', 'vitamin', 'mineral', 'micronutrient', 'biomarker', 'vital', 'blood_pressure'])

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
  envelopes: HealthIngestionEnvelope[]
  read: number
  skipped: number
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
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 65_536) return {}
  try { return record(JSON.parse(value)) } catch { return {} }
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) ? value : null
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 ? value : null
}

function numberField(source: Record<string, unknown>, target: Record<string, unknown>, sourceKey: string, targetKey = sourceKey): void {
  if (typeof source[sourceKey] === 'number' && Number.isFinite(source[sourceKey])) target[targetKey] = source[sourceKey]
}

function envelope(profile: string, domain: HealthDomain, id: string, observedAt: string, evidenceClass: HealthEvidenceClass, payload: Record<string, unknown>): HealthIngestionEnvelope {
  return { domain, source: IMPORT_SOURCE, sourceId: `${id}:${profile}`, observedAt, evidenceClass, confidence: 1, payload, parserVersion: MIGRATION_VERSION }
}

function scaleEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const value = record(item.value); const observedAt = timestamp(value.measuredAt ?? item.recordedAt)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = {}
  for (const key of ['weightKg', 'bmi', 'bodyFatPercent', 'muscleMassKg', 'boneSaltKg', 'bodyWaterPercent', 'visceralFatLevel', 'basalMetabolismKcal', 'proteinPercent', 'fatMassKg', 'leanBodyMassKg', 'bodyScore', 'waistHipRatio']) numberField(value, payload, key)
  numberField(value, payload, 'bodyAge', 'bodyAgeYears')
  if (typeof value.sourceModel === 'string' && value.sourceModel) payload.deviceModel = value.sourceModel
  return Object.keys(payload).length ? envelope(profile, 'body_composition', id, observedAt, 'measured', payload) : null
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
    const present = sources.filter(key => values[key] !== undefined)
    if (present.length > 1 && present.some(key => values[key] !== values[present[0]])) throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
    if (present.length) numberField(values, payload, present[0], target)
  }
  for (const key of ['method', 'calibrationMethod', 'calibrationId', 'modelVersion']) if (typeof value[key] === 'string') payload[key] = value[key]
  numberField(value, payload, 'modelConfidence')
  const evidenceClass = hasModelEvidence(item, value) ? 'inferred' : 'reported'
  const envelopes: HealthIngestionEnvelope[] = []
  if (Object.keys(payload).length) envelopes.push(envelope(profile, 'measurements', `${id}:measurements`, observedAt, evidenceClass, payload))
  const bodyPayload: Record<string, unknown> = {}
  numberField(value, bodyPayload, 'weightKg'); numberField(value, bodyPayload, 'bodyFatPercent')
  if (Object.keys(bodyPayload).length) envelopes.push(envelope(profile, 'body_composition', `${id}:body-composition`, observedAt, evidenceClass, bodyPayload))
  return envelopes
}

function hasModelEvidence(item: Record<string, unknown>, value: Record<string, unknown>): boolean {
  const source = String(item.source ?? '').toLowerCase()
  return /(?:vision|camera|model)/.test(source) || typeof value.modelVersion === 'string'
}

function postureEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.recordedAt); const value = record(item.value)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = {}
  for (const key of ['findings', 'angles', 'landmarks', 'capture']) if (value[key] !== undefined) payload[key] = value[key]
  for (const key of ['modelVersion']) if (typeof value[key] === 'string') payload[key] = value[key]
  numberField(value, payload, 'modelConfidence')
  if (Array.isArray(value.issues)) payload.reportedIssues = value.issues
  if (value.priority !== undefined) payload.reportedPriority = value.priority
  if (Array.isArray(value.pain)) payload.reportedPain = value.pain.map(itemPain => {
    const pain = record(itemPain)
    return { area: pain.area, score: Object.prototype.hasOwnProperty.call(pain, 'score') ? pain.score : null }
  })
  if (Array.isArray(value.compensationChain)) payload.reportedCompensationChain = value.compensationChain
  if (Array.isArray(value.compensation_chain) && payload.reportedCompensationChain === undefined) payload.reportedCompensationChain = value.compensation_chain
  return Object.keys(payload).length ? envelope(profile, 'posture', id, observedAt, hasModelEvidence(item, value) ? 'inferred' : 'reported', payload) : null
}

function skinEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.recordedAt); const value = record(item.value)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = {}
  for (const key of ['region', 'appearances', 'trend', 'lightingProfile', 'device', 'comparisonBaseline']) if (value[key] !== undefined) payload[key] = value[key]
  for (const key of ['captureQuality', 'distanceCm']) numberField(value, payload, key)
  if (Array.isArray(value.concerns)) payload.reportedConcerns = value.concerns
  if (value.routine !== undefined) payload.reportedRoutine = value.routine
  return Object.keys(payload).length ? envelope(profile, 'skin', id, observedAt, hasModelEvidence(item, value) ? 'inferred' : 'reported', payload) : null
}

function internalEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.recordedAt); const value = record(item.value)
  if (!id || !observedAt || typeof value.value !== 'number' || !Number.isFinite(value.value)) return null
  const rawKey = value.marker ?? value.key ?? item.title
  const key = identifier(rawKey) ?? (typeof rawKey === 'string' ? rawKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : '')
  const unit = typeof value.unit === 'string' ? value.unit : typeof item.unit === 'string' ? item.unit : null
  if (!key || !unit) return null
  const marker: Record<string, unknown> = { key, value: value.value, unit, measuredAt: observedAt }
  if (typeof item.title === 'string' && item.title) marker.displayLabel = item.title
  numberField(value, marker, 'referenceLow'); numberField(value, marker, 'referenceHigh')
  if (marker.referenceLow === undefined && marker.referenceHigh === undefined && typeof value.referenceRange === 'string') {
    const match = value.referenceRange.trim().match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/)
    if (match) { marker.referenceLow = Number(match[1]); marker.referenceHigh = Number(match[2]) }
  }
  const providerFlag = value.providerAbnormalFlag ?? value.status
  if (typeof providerFlag === 'string' && providerFlag) marker.providerAbnormalFlag = providerFlag
  return envelope(profile, 'internal_health', id, observedAt, 'reported', { markers: [marker], reportDate: observedAt.slice(0, 10) })
}

function dietEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.loggedAt ?? item.createdAt); const nutrition = record(item.nutrition)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = { mealTime: observedAt, portionConfirmed: true, confirmationStatus: 'confirmed' }
  const aliases: Array<[string, string]> = [['caloriesKcal', 'caloriesKcal'], ['calories', 'caloriesKcal'], ['proteinG', 'proteinG'], ['protein', 'proteinG'], ['carbsG', 'carbsG'], ['carbs', 'carbsG'], ['fatG', 'fatG'], ['fat', 'fatG'], ['waterMl', 'waterMl'], ['water', 'waterMl']]
  for (const [source, target] of aliases) if (payload[target] === undefined) numberField(nutrition, payload, source, target)
  if (nutrition.micros !== undefined) payload.micros = nutrition.micros
  return Object.keys(payload).length > 3 ? envelope(profile, 'diet', id, observedAt, 'reported', payload) : null
}

function fitnessEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const observedAt = timestamp(item.startedAt ?? item.createdAt); const metrics = record(item.metrics)
  if (!id || !observedAt) return null
  const payload: Record<string, unknown> = { exercise: typeof item.title === 'string' && item.title ? item.title : typeof item.kind === 'string' ? item.kind : 'workout' }
  for (const key of ['durationMinutes']) numberField(item, payload, key)
  for (const key of ['pain', 'rpe', 'trainingLoad']) numberField(metrics, payload, key)
  for (const key of ['completed']) if (typeof metrics[key] === 'boolean') payload[key] = metrics[key]
  for (const key of ['exercises', 'muscles']) if (metrics[key] !== undefined) payload[key] = metrics[key]
  if (typeof item.intensity === 'string' && item.intensity) payload.intensity = item.intensity
  return envelope(profile, 'fitness', id, observedAt, 'reported', payload)
}

function sleepEnvelope(profile: string, item: Record<string, unknown>): HealthIngestionEnvelope | null {
  const id = identifier(item.id); const sleep = item.sleep !== undefined ? record(item.sleep) : jsonRecord(item.sleep_json)
  const checkinDate = item.checkinDate ?? item.checkin_date
  const observedAt = timestamp(sleep.endedAt ?? sleep.ended_at ?? item.createdAt ?? item.created_at) ?? (typeof checkinDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(checkinDate) ? `${checkinDate}T00:00:00Z` : null)
  if (!id || !observedAt || Object.keys(sleep).length === 0) return null
  const payload: Record<string, unknown> = {}
  for (const key of ['startedAt', 'endedAt', 'stages']) if (sleep[key] !== undefined) payload[key] = sleep[key]
  for (const key of ['durationMinutes', 'interruptions', 'restingHeartRateBpm', 'restingRespiratoryRateBrpm', 'restingSpo2Percent', 'freshnessMinutes', 'subjectiveRecovery', 'recoveryScore']) numberField(sleep, payload, key)
  return Object.keys(payload).length ? envelope(profile, 'sleep', id, observedAt, 'reported', payload) : null
}

function collectProfile(profile: string, source: HealthOverview): CollectedHealthSources {
  const envelopes: HealthIngestionEnvelope[] = []; let read = 0; let skipped = 0
  const add = (candidate: HealthIngestionEnvelope | null): void => { read += 1; if (candidate) envelopes.push(candidate); else skipped += 1 }
  const addMany = (candidates: HealthIngestionEnvelope[]): void => { read += 1; if (candidates.length) envelopes.push(...candidates); else skipped += 1 }
  for (const item of source.records) {
    const kind = String(item.kind ?? '')
    if (kind === 'scale_reading') add(scaleEnvelope(profile, item))
    else if (kind === 'body_measurement') addMany(measurementsEnvelopes(profile, item))
    else if (kind === 'posture_assessment') add(postureEnvelope(profile, item))
    else if (kind === 'skin_assessment') add(skinEnvelope(profile, item))
    else if (INTERNAL_KINDS.has(kind)) add(internalEnvelope(profile, item))
  }
  for (const item of source.foodLogs) add(dietEnvelope(profile, item))
  for (const item of source.workouts) add(fitnessEnvelope(profile, item))
  for (const item of source.dailyCheckins) add(sleepEnvelope(profile, item))
  return { envelopes, read, skipped }
}

function collect(profiles: string[]): CollectedHealthSources {
  const output: CollectedHealthSources = { envelopes: [], read: 0, skipped: 0 }
  for (const profile of profiles) {
    const item = collectProfile(profile, getHealthOverview({ profile, includeRecords: true }))
    output.envelopes.push(...item.envelopes); output.read += item.read; output.skipped += item.skipped
  }
  output.envelopes.sort((left, right) => compareUtf8(`${left.observedAt}\0${left.sourceId}\0${left.domain}`, `${right.observedAt}\0${right.sourceId}\0${right.domain}`))
  return output
}

function fingerprint(envelopes: HealthIngestionEnvelope[]): string {
  return createHash('sha256').update(stableJson({ version: MIGRATION_VERSION, records: envelopes })).digest('hex')
}

function storedEventExists(item: HealthIngestionEnvelope): boolean {
  return withPersonalTwinDb(db => Boolean(db.prepare(`SELECT 1 FROM twin_events WHERE source = ? AND source_id = ? AND event_type = 'health.ingestion.recorded'`)
    .get(item.source, `${item.sourceId}:health.ingestion.recorded`)))
}

function flatRunCounts(counts: HealthMigrationCounts, domains: Record<HealthDomain, number>): Record<string, number> {
  return { ...counts, ...Object.fromEntries(HEALTH_DOMAINS.map(domain => [`domain${domain.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`, domains[domain]])) }
}

function fromStoredCounts(values: Record<string, number>): { counts: HealthMigrationCounts; domains: Record<HealthDomain, number> } {
  const counts = emptyCounts(); const domains = emptyDomainCounts()
  for (const key of Object.keys(counts) as Array<keyof HealthMigrationCounts>) counts[key] = values[key] ?? 0
  for (const domain of HEALTH_DOMAINS) domains[domain] = values[`domain${domain.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`] ?? 0
  return { counts, domains }
}

export function syncLegacyHealthTwinSources(options: { profiles?: string[] } = {}): HealthMigrationResult {
  const profiles = profilesOnDisk(options.profiles)
  let collected: CollectedHealthSources
  try { collected = collect(profiles) } catch { throw new Error('HEALTH_MIGRATION_SOURCE_UNAVAILABLE') }
  const sourceFingerprint = fingerprint(collected.envelopes)
  const claim = claimTwinImportRun({ source: IMPORT_SOURCE, fingerprint: sourceFingerprint, version: MIGRATION_VERSION })
  if (!claim.owner) {
    if (claim.status !== 'completed' || !claim.completedAt) throw new Error('HEALTH_MIGRATION_IN_PROGRESS')
    const stored = fromStoredCounts(claim.counts)
    return { runId: claim.runId, status: 'completed', fingerprint: sourceFingerprint, version: MIGRATION_VERSION, profiles, counts: stored.counts, domainCounts: stored.domains, startedAt: claim.startedAt, completedAt: claim.completedAt }
  }
  const counts = emptyCounts(); counts.read = collected.read; counts.skipped = collected.skipped
  const domains = emptyDomainCounts()
  try {
    for (const item of collected.envelopes) {
      domains[item.domain] += 1
      const replay = storedEventExists(item)
      try { ingestHealthEnvelope(item) } catch (error) {
        if (error instanceof HealthIngestionError && error.code === 'HEALTH_INGESTION_IDENTITY_CONFLICT') {
          counts.conflicts += 1
          throw new Error('HEALTH_MIGRATION_SOURCE_CONFLICT')
        }
        counts.errors += 1
        throw new Error('HEALTH_MIGRATION_INVALID_SOURCE')
      }
      if (replay) counts.replayed += 1
      else counts.ingested += 1
    }
    const completed = completeTwinImportRun(claim, flatRunCounts(counts, domains))
    return { runId: completed.runId, status: 'completed', fingerprint: sourceFingerprint, version: MIGRATION_VERSION, profiles, counts, domainCounts: domains, startedAt: completed.startedAt, completedAt: completed.completedAt! }
  } catch (error) {
    const code = error instanceof Error && /^HEALTH_MIGRATION_[A-Z_]+$/.test(error.message) ? error.message : 'HEALTH_MIGRATION_FAILED'
    failTwinImportRun(claim, code, flatRunCounts(counts, domains))
    throw new Error(code)
  }
}
