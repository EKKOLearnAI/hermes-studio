import { createHash } from 'crypto'
import { isProxy } from 'node:util/types'
import {
  HEALTH_DOMAINS, HealthDomain, HealthEvidenceClass, HealthIngestionEnvelope, HealthIngestionError,
  NormalizedHealthIngestion, NormalizedHealthObservation,
} from './types'

const MAX_JSON_DEPTH = 8
const MAX_JSON_NODES = 512
const MAX_JSON_BYTES = 65_536
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const ARTIFACT_ID = /^artifact-[0-9a-f]{64}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function fail(code: ConstructorParameters<typeof HealthIngestionError>[0], detail: string): never {
  throw new HealthIngestionError(code, detail)
}

function canonicalSafeJson(value: unknown): string {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): string => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON structural limits exceeded')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON numbers must be finite')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || item === null || isProxy(item)) fail('HEALTH_INGESTION_INVALID_JSON', 'payload must be plain JSON')
    if (seen.has(item)) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON cycles are not allowed')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) fail('HEALTH_INGESTION_INVALID_JSON', 'payload must be plain JSON')
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        const keys = Reflect.ownKeys(item)
        if (item.length > 128 || keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
          fail('HEALTH_INGESTION_INVALID_JSON', 'JSON array limits exceeded')
        }
        const values: string[] = []
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON accessors are not allowed')
          values.push(visit(descriptor.value, depth + 1))
        }
        return `[${values.join(',')}]`
      }
      const keys = Reflect.ownKeys(item)
      if (keys.some(key => typeof key !== 'string')) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON symbol keys are not allowed')
      const output: string[] = []
      for (const key of (keys as string[]).sort()) {
        if (POISON_KEYS.has(key)) fail('HEALTH_INGESTION_INVALID_JSON', 'prototype keys are not allowed')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON accessors are not allowed')
        output.push(`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`)
      }
      return `{${output.join(',')}}`
    } finally {
      seen.delete(item)
    }
  }
  const json = visit(value, 0)
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON byte limit exceeded')
  return json
}

function plainRecord(value: unknown, field = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('HEALTH_INGESTION_INVALID_PAYLOAD', `${field} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('HEALTH_INGESTION_INVALID_PAYLOAD', `${field} must be an object`)
  return value as Record<string, unknown>
}

function strictTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('HEALTH_INGESTION_INVALID_TIMESTAMP', `${field} must be RFC3339`)
  const match = RFC3339.exec(value)
  if (!match) fail('HEALTH_INGESTION_INVALID_TIMESTAMP', `${field} must be RFC3339`)
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6])
  const offsetHour = match[10] ? Number(match[10]) : 0; const offsetMinute = match[11] ? Number(match[11]) : 0
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    fail('HEALTH_INGESTION_INVALID_TIMESTAMP', `${field} must be RFC3339`)
  }
  return value
}

function dateOnly(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('HEALTH_INGESTION_INVALID_TIMESTAMP', `${field} must be YYYY-MM-DD`)
  strictTimestamp(`${value}T00:00:00Z`, field)
  return value
}

function boundedIdentifier(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !IDENTIFIER.test(value)) {
    fail('HEALTH_INGESTION_INVALID_IDENTITY', `${field} is invalid`)
  }
  return value
}

function text(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('HEALTH_INGESTION_INVALID_PAYLOAD', `${field} is invalid`)
  }
  return value
}

function number(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail('HEALTH_INGESTION_INVALID_NUMBER', `${field} is outside its allowed range`)
  }
  return value
}

function optionalNumber(record: Record<string, unknown>, key: string, min: number, max: number, integer = false): number | undefined {
  return record[key] === undefined ? undefined : number(record[key], key, min, max, integer)
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail('HEALTH_INGESTION_INVALID_PAYLOAD', `${key} must be boolean`)
  return value
}

function add(output: NormalizedHealthObservation[], metric: string, value: unknown, unit: string | null = null): void {
  if (value !== undefined) output.push({ metric, value, unit })
}

function normalizeBody(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  const fields: Array<[string, string, string | null, number, number]> = [
    ['weightKg', 'weight_kg', 'kg', 0.1, 500], ['bmi', 'bmi', null, 5, 100], ['bodyFatPercent', 'body_fat_percent', '%', 0, 80],
    ['muscleMassKg', 'muscle_mass_kg', 'kg', 0, 300], ['boneMassKg', 'bone_mass_kg', 'kg', 0, 30],
    ['waterPercent', 'water_percent', '%', 0, 100], ['visceralFatLevel', 'visceral_fat_level', null, 0, 100],
    ['bmrKcal', 'bmr_kcal', 'kcal/day', 100, 10_000], ['metabolicAgeYears', 'metabolic_age_years', 'year', 1, 150],
    ['proteinPercent', 'protein_percent', '%', 0, 100], ['subcutaneousFatPercent', 'subcutaneous_fat_percent', '%', 0, 80],
    ['fatMassKg', 'fat_mass_kg', 'kg', 0, 300], ['leanBodyMassKg', 'lean_body_mass_kg', 'kg', 0, 300],
    ['skeletalMusclePercent', 'skeletal_muscle_percent', '%', 0, 100], ['bodyScore', 'body_score', null, 0, 100],
    ['idealWeightKg', 'ideal_weight_kg', 'kg', 0.1, 500],
  ]
  for (const [key, suffix, unit, min, max] of fields) add(output, `health.body_composition.${suffix}`, optionalNumber(record, key, min, max), unit)
  return output
}

function normalizeMeasurements(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  for (const key of ['chestCm', 'waistCm', 'hipCm', 'leftArmCm', 'rightArmCm', 'leftThighCm', 'rightThighCm', 'leftCalfCm', 'rightCalfCm']) {
    add(output, `health.measurements.${key.replace(/Cm$/, '').replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}_cm`, optionalNumber(record, key, 1, 300), 'cm')
  }
  if (record.method !== undefined) add(output, 'health.measurements.method', boundedIdentifier(record.method, 'method', 40))
  if (record.calibrationId !== undefined) add(output, 'health.measurements.calibration_id', boundedIdentifier(record.calibrationId, 'calibrationId', 80))
  return output
}

function normalizePosture(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.findings !== undefined) {
    if (!Array.isArray(record.findings) || record.findings.length > 32) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'findings is invalid')
    add(output, 'health.posture.findings', record.findings.map((item, index) => {
      const finding = plainRecord(item, `findings[${index}]`)
      return { code: boundedIdentifier(finding.code, 'finding.code', 60), severity: number(finding.severity, 'finding.severity', 0, 1), confidence: number(finding.confidence, 'finding.confidence', 0, 1) }
    }))
  }
  if (record.angles !== undefined) {
    const angles = plainRecord(record.angles, 'angles'); const normalized: Record<string, number> = {}
    const allowed: Array<[string, number, number]> = [['headForwardDeg', -90, 90], ['shoulderTiltDeg', -45, 45], ['pelvicTiltDeg', -45, 45], ['spineLeanDeg', -45, 45]]
    for (const [key, min, max] of allowed) { const value = optionalNumber(angles, key, min, max); if (value !== undefined) normalized[key] = value }
    if (Object.keys(normalized).length) add(output, 'health.posture.angles', normalized, 'degree')
  }
  if (record.capture !== undefined) {
    const capture = plainRecord(record.capture, 'capture')
    if (!Array.isArray(capture.views) || capture.views.length < 1 || capture.views.length > 4) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'capture.views is invalid')
    add(output, 'health.posture.capture', { views: [...new Set(capture.views.map((view, index) => text(view, `capture.views[${index}]`, 20)))].sort(), quality: number(capture.quality, 'capture.quality', 0, 1) })
  }
  if (record.modelVersion !== undefined) add(output, 'health.posture.model_version', boundedIdentifier(record.modelVersion, 'modelVersion', 64))
  add(output, 'health.posture.model_confidence', optionalNumber(record, 'modelConfidence', 0, 1))
  return output
}

function normalizeSkin(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.region !== undefined) add(output, 'health.skin.region', boundedIdentifier(record.region, 'region', 60))
  if (record.appearances !== undefined) {
    if (!Array.isArray(record.appearances) || record.appearances.length > 32) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'appearances is invalid')
    add(output, 'health.skin.appearances', record.appearances.map((item, index) => {
      const appearance = plainRecord(item, `appearances[${index}]`)
      return { type: boundedIdentifier(appearance.type, 'appearance.type', 60), severity: number(appearance.severity, 'appearance.severity', 0, 1) }
    }))
  }
  if (record.trend !== undefined) {
    const trend = boundedIdentifier(record.trend, 'trend', 20)
    if (!['improving', 'stable', 'worsening', 'unknown'].includes(trend!)) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'trend is invalid')
    add(output, 'health.skin.trend', trend)
  }
  add(output, 'health.skin.capture_quality', optionalNumber(record, 'captureQuality', 0, 1))
  return output
}

function normalizeDiet(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.foods !== undefined) {
    if (!Array.isArray(record.foods) || record.foods.length > 64) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'foods is invalid')
    add(output, 'health.diet.foods', record.foods.map((item, index) => {
      const food = plainRecord(item, `foods[${index}]`)
      return { name: text(food.name, 'food.name', 100), portionGrams: number(food.portionGrams, 'food.portionGrams', 0.1, 10_000) }
    }))
  }
  const fields: Array<[string, string, string, number]> = [
    ['caloriesKcal', 'calories_kcal', 'kcal', 20_000], ['proteinG', 'protein_g', 'g', 1_000], ['carbsG', 'carbs_g', 'g', 2_000],
    ['fatG', 'fat_g', 'g', 1_000], ['waterMl', 'water_ml', 'mL', 20_000],
  ]
  for (const [key, suffix, unit, max] of fields) add(output, `health.diet.${suffix}`, optionalNumber(record, key, 0, max), unit)
  if (record.micros !== undefined) {
    const micros = plainRecord(record.micros, 'micros'); const normalized: Record<string, number> = {}
    const allowed: Array<[string, number, string]> = [['fiberG', 500, 'g'], ['sodiumMg', 100_000, 'mg'], ['potassiumMg', 100_000, 'mg'], ['calciumMg', 100_000, 'mg'], ['ironMg', 10_000, 'mg']]
    for (const [key, max, unit] of allowed) { const value = optionalNumber(micros, key, 0, max); if (value !== undefined) normalized[`${key}:${unit}`] = value }
    if (Object.keys(normalized).length) add(output, 'health.diet.micros', normalized)
  }
  add(output, 'health.diet.portion_confirmed', optionalBoolean(record, 'portionConfirmed'))
  return output
}

function normalizeFitness(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.exercise !== undefined) add(output, 'health.fitness.exercise', text(record.exercise, 'exercise', 100))
  const fields: Array<[string, string, string | null, number, number, boolean?]> = [
    ['sets', 'sets', null, 0, 100, true], ['reps', 'reps', null, 0, 10_000, true], ['loadKg', 'load_kg', 'kg', 0, 1_000],
    ['durationMinutes', 'duration_minutes', 'min', 0, 1_440], ['pain', 'pain', null, 0, 10], ['rpe', 'rpe', null, 0, 10],
  ]
  for (const [key, suffix, unit, min, max, integer] of fields) add(output, `health.fitness.${suffix}`, optionalNumber(record, key, min, max, integer), unit)
  if (record.intensity !== undefined) add(output, 'health.fitness.intensity', boundedIdentifier(record.intensity, 'intensity', 30))
  if (record.muscles !== undefined) {
    if (!Array.isArray(record.muscles) || record.muscles.length > 32) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'muscles is invalid')
    add(output, 'health.fitness.muscles', [...new Set(record.muscles.map((muscle, index) => boundedIdentifier(muscle, `muscles[${index}]`, 50)!))].sort())
  }
  add(output, 'health.fitness.completed', optionalBoolean(record, 'completed'))
  return output
}

function normalizeSleep(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.startedAt !== undefined) add(output, 'health.sleep.started_at', strictTimestamp(record.startedAt, 'startedAt'))
  if (record.endedAt !== undefined) add(output, 'health.sleep.ended_at', strictTimestamp(record.endedAt, 'endedAt'))
  add(output, 'health.sleep.duration_minutes', optionalNumber(record, 'durationMinutes', 0, 1_440), 'min')
  add(output, 'health.sleep.interruptions', optionalNumber(record, 'interruptions', 0, 100, true))
  if (record.stages !== undefined) {
    const stages = plainRecord(record.stages, 'stages'); const normalized: Record<string, number> = {}
    for (const key of ['deepMinutes', 'remMinutes', 'lightMinutes', 'awakeMinutes']) { const value = optionalNumber(stages, key, 0, 1_440); if (value !== undefined) normalized[key] = value }
    if (Object.keys(normalized).length) add(output, 'health.sleep.stages', normalized, 'min')
  }
  add(output, 'health.sleep.resting_heart_rate_bpm', optionalNumber(record, 'restingHeartRateBpm', 20, 250), 'bpm')
  add(output, 'health.sleep.recovery_score', optionalNumber(record, 'recoveryScore', 0, 100))
  return output
}

function normalizeInternal(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.markers !== undefined) {
    if (!Array.isArray(record.markers) || record.markers.length < 1 || record.markers.length > 128) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'markers is invalid')
    add(output, 'health.internal_health.markers', record.markers.map((item, index) => {
      const marker = plainRecord(item, `markers[${index}]`)
      const normalized: Record<string, unknown> = {
        name: boundedIdentifier(marker.name, 'marker.name', 80), value: number(marker.value, 'marker.value', -1e12, 1e12), unit: text(marker.unit, 'marker.unit', 40),
      }
      const low = optionalNumber(marker, 'referenceLow', -1e12, 1e12); const high = optionalNumber(marker, 'referenceHigh', -1e12, 1e12)
      if (low !== undefined) normalized.referenceLow = low
      if (high !== undefined) normalized.referenceHigh = high
      if (low !== undefined && high !== undefined && low > high) fail('HEALTH_INGESTION_INVALID_NUMBER', 'marker reference range is invalid')
      if (marker.providerFlag !== undefined) normalized.providerFlag = boundedIdentifier(marker.providerFlag, 'marker.providerFlag', 40)
      return normalized
    }))
  }
  if (record.reportDate !== undefined) add(output, 'health.internal_health.report_date', dateOnly(record.reportDate, 'reportDate'))
  if (record.institution !== undefined) add(output, 'health.internal_health.institution', text(record.institution, 'institution', 160))
  if (record.reportArtifactId !== undefined) {
    if (typeof record.reportArtifactId !== 'string' || !ARTIFACT_ID.test(record.reportArtifactId)) fail('HEALTH_INGESTION_INVALID_ARTIFACT_ID', 'reportArtifactId is invalid')
    add(output, 'health.internal_health.report_artifact_id', record.reportArtifactId)
  }
  add(output, 'health.internal_health.pending_confirmation', true)
  return output
}

const NORMALIZERS: Record<HealthDomain, (payload: Record<string, unknown>) => NormalizedHealthObservation[]> = {
  body_composition: normalizeBody, measurements: normalizeMeasurements, posture: normalizePosture, skin: normalizeSkin,
  diet: normalizeDiet, fitness: normalizeFitness, sleep: normalizeSleep, internal_health: normalizeInternal,
}

const CONFIRMATION: Record<HealthEvidenceClass, NormalizedHealthIngestion['confirmationState']> = {
  measured: 'observed', reported: 'reported', inferred: 'inferred', derived: 'inferred',
}

export function normalizeHealthIngestionEnvelope(input: HealthIngestionEnvelope): NormalizedHealthIngestion {
  canonicalSafeJson(input)
  if (!input || typeof input !== 'object' || !HEALTH_DOMAINS.includes(input.domain)) fail('HEALTH_INGESTION_INVALID_ENVELOPE', 'domain is invalid')
  const source = boundedIdentifier(input.source, 'source', 64)!
  const sourceId = boundedIdentifier(input.sourceId, 'sourceId', 200)!
  const parserVersion = boundedIdentifier(input.parserVersion, 'parserVersion', 64, true)
  const observedAt = strictTimestamp(input.observedAt, 'observedAt')
  if (!['measured', 'reported', 'inferred', 'derived'].includes(input.evidenceClass)) fail('HEALTH_INGESTION_INVALID_ENVELOPE', 'evidenceClass is invalid')
  const confidence = number(input.confidence, 'confidence', 0, 1)
  const payload = plainRecord(input.payload)
  if (input.artifactIds !== undefined && !Array.isArray(input.artifactIds)) fail('HEALTH_INGESTION_INVALID_ARTIFACT_ID', 'artifactIds must be an array')
  const artifactIds = [...new Set((input.artifactIds ?? []).map(id => {
    if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) fail('HEALTH_INGESTION_INVALID_ARTIFACT_ID', 'artifact ID is invalid')
    return id
  }))].sort()
  if (artifactIds.length > 32) fail('HEALTH_INGESTION_INVALID_ARTIFACT_ID', 'too many artifact IDs')
  const observations = NORMALIZERS[input.domain](payload).sort((left, right) => left.metric.localeCompare(right.metric))
  if (observations.length === 0) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'payload contains no supported facts')
  const material = { domain: input.domain, observedAt, evidenceClass: input.evidenceClass, confidence, artifactIds, parserVersion: parserVersion ?? null, observations }
  const materialDigest = createHash('sha256').update(canonicalSafeJson(material)).digest('hex')
  const evidence: Array<Record<string, unknown>> = [{ evidenceClass: input.evidenceClass, ...(artifactIds.length ? { artifactIds } : {}), ...(parserVersion ? { parserVersion } : {}) }]
  const pendingConfirmation = input.domain === 'internal_health'
  return {
    domain: input.domain, source, sourceId, observedAt, confidence,
    confirmationState: pendingConfirmation ? 'inferred' : CONFIRMATION[input.evidenceClass],
    artifactIds, evidence, observations, materialDigest,
    eventPayload: { domain: input.domain, materialDigest, observationCount: observations.length, artifactIds, ...(parserVersion ? { parserVersion } : {}), ...(pendingConfirmation ? { pendingConfirmation: true } : {}) },
  }
}
