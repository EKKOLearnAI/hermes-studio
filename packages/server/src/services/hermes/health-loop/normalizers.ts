import { createHash } from 'crypto'
import { isProxy } from 'node:util/types'
import {
  HEALTH_DOMAINS, HealthDomain, HealthEvidenceClass, HealthIngestionEnvelope, HealthIngestionError,
  NormalizedHealthIngestion, NormalizedHealthObservation,
} from './types'

const MAX_JSON_DEPTH = 8
const MAX_JSON_NODES = 512
const MAX_JSON_BYTES = 65_536
const MAX_JSON_KEY_BYTES = 256
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const ARTIFACT_ID = /^artifact-[0-9a-f]{64}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function fail(code: ConstructorParameters<typeof HealthIngestionError>[0], detail: string): never {
  throw new HealthIngestionError(code, detail)
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function rawUtf8Length(value: string, limit = Number.POSITIVE_INFINITY): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index += 1
    } else bytes += 3
    if (bytes > limit) return bytes
  }
  return bytes
}

function validateSafeJson(value: unknown): void {
  let nodes = 0
  let bytes = 0
  const seen = new Set<object>()
  const addBytes = (count: number): void => {
    bytes += count
    if (bytes > MAX_JSON_BYTES) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON byte limit exceeded')
  }
  const addStringBytes = (valueToMeasure: string): void => {
    addBytes(2)
    for (let index = 0; index < valueToMeasure.length; index += 1) {
      const code = valueToMeasure.charCodeAt(index)
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) addBytes(2)
      else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff
        && !(code <= 0xdbff && index + 1 < valueToMeasure.length && valueToMeasure.charCodeAt(index + 1) >= 0xdc00 && valueToMeasure.charCodeAt(index + 1) <= 0xdfff))) addBytes(6)
      else if (code <= 0x7f) addBytes(1)
      else if (code <= 0x7ff) addBytes(2)
      else if (code >= 0xd800 && code <= 0xdbff) { addBytes(4); index += 1 }
      else addBytes(3)
    }
  }
  const visit = (item: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON structural limits exceeded')
    if (item === null) { addBytes(4); return }
    if (typeof item === 'boolean') { addBytes(item ? 4 : 5); return }
    if (typeof item === 'string') { addStringBytes(item); return }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON numbers must be finite')
      addBytes(String(item).length); return
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
        addBytes(1)
        for (let index = 0; index < item.length; index += 1) {
          if (index > 0) addBytes(1)
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON accessors are not allowed')
          visit(descriptor.value, depth + 1)
        }
        addBytes(1); return
      }
      const keys = Reflect.ownKeys(item)
      if (keys.some(key => typeof key !== 'string')) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON symbol keys are not allowed')
      if (keys.length > MAX_JSON_NODES) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON structural limits exceeded')
      addBytes(1)
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index] as string
        if (index > 0) addBytes(1)
        if (POISON_KEYS.has(key)) fail('HEALTH_INGESTION_INVALID_JSON', 'prototype keys are not allowed')
        if (rawUtf8Length(key, MAX_JSON_KEY_BYTES) > MAX_JSON_KEY_BYTES) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON key byte limit exceeded')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) fail('HEALTH_INGESTION_INVALID_JSON', 'JSON accessors are not allowed')
        addStringBytes(key); addBytes(1); visit(descriptor.value, depth + 1)
      }
      addBytes(1)
    } finally {
      seen.delete(item)
    }
  }
  visit(value, 0)
}

function canonicalSafeJson(value: unknown): string {
  validateSafeJson(value)
  const visit = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number') return JSON.stringify(item)
    if (Array.isArray(item)) return `[${item.map(visit).join(',')}]`
    const record = item as Record<string, unknown>
    return `{${Object.keys(record).sort(compareUtf8).map(key => `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`
  }
  return visit(value)
}

function plainRecord(value: unknown, field = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('HEALTH_INGESTION_INVALID_PAYLOAD', `${field} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('HEALTH_INGESTION_INVALID_PAYLOAD', `${field} must be an object`)
  return value as Record<string, unknown>
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
  const offsetSign = match[9] === '-' ? -1 : 1
  const offsetSeconds = match[8] === 'Z' ? 0 : offsetSign * (offsetHour * 60 + offsetMinute) * 60
  const epochSeconds = daysFromCivil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second - offsetSeconds
  const utc = new Date(epochSeconds * 1_000).toISOString()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(utc)) {
    fail('HEALTH_INGESTION_INVALID_TIMESTAMP', `${field} UTC instant is outside the supported range`)
  }
  const nanoseconds = (match[7] ?? '').padEnd(9, '0')
  const canonicalFraction = nanoseconds.replace(/0+$/, '')
  return `${utc.slice(0, 19)}${canonicalFraction ? `.${canonicalFraction}` : ''}Z`
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
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
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

function optionalAliasedNumber(record: Record<string, unknown>, keys: string[], min: number, max: number, integer = false): number | undefined {
  const supplied = keys.filter(key => record[key] !== undefined).map(key => number(record[key], key, min, max, integer))
  if (supplied.length > 1 && supplied.some(value => value !== supplied[0])) {
    fail('HEALTH_INGESTION_INVALID_PAYLOAD', `${keys[0]} aliases conflict`)
  }
  return supplied[0]
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

function unorderedUnique<T>(values: T[]): T[] {
  const byCanonical = new Map(values.map(value => [canonicalSafeJson(value), value]))
  return [...byCanonical.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([, value]) => value)
}

function unorderedBag<T>(values: T[]): T[] {
  return values.map(value => ({ canonical: canonicalSafeJson(value), value }))
    .sort((left, right) => compareUtf8(left.canonical, right.canonical)).map(item => item.value)
}

function normalizeBody(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  const fields: Array<[string[], string, string | null, number, number]> = [
    [['weightKg'], 'weight_kg', 'kg', 0.1, 500], [['bmi'], 'bmi', null, 5, 100], [['bodyFatPercent'], 'body_fat_percent', '%', 0, 80],
    [['muscleMassKg'], 'muscle_mass_kg', 'kg', 0, 300], [['boneSaltKg', 'boneMassKg'], 'bone_mass_kg', 'kg', 0, 30],
    [['bodyWaterPercent', 'waterPercent'], 'water_percent', '%', 0, 100], [['visceralFatLevel'], 'visceral_fat_level', null, 0, 100],
    [['basalMetabolismKcal', 'bmrKcal'], 'bmr_kcal', 'kcal/day', 100, 10_000], [['bodyAgeYears', 'metabolicAgeYears'], 'metabolic_age_years', 'year', 1, 150],
    [['proteinPercent'], 'protein_percent', '%', 0, 100], [['subcutaneousFatPercent'], 'subcutaneous_fat_percent', '%', 0, 80],
    [['fatMassKg'], 'fat_mass_kg', 'kg', 0, 300], [['leanMassKg', 'leanBodyMassKg'], 'lean_body_mass_kg', 'kg', 0, 300],
    [['skeletalMusclePercent'], 'skeletal_muscle_percent', '%', 0, 100], [['bodyScore'], 'body_score', null, 0, 100],
    [['idealWeightKg'], 'ideal_weight_kg', 'kg', 0.1, 500], [['waistHipRatio'], 'waist_hip_ratio', null, 0.2, 3],
  ]
  for (const field of fields) {
    const [keys, suffix, unit, min, max] = field
    add(output, `health.body_composition.${suffix}`, optionalAliasedNumber(record, keys, min, max), unit)
  }
  if (record.deviceModel !== undefined) add(output, 'health.body_composition.device_model', text(record.deviceModel, 'deviceModel', 100))
  return output
}

function normalizeMeasurements(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  for (const key of ['chestCm', 'waistCm', 'hipCm', 'leftArmCm', 'rightArmCm', 'leftThighCm', 'rightThighCm', 'leftCalfCm', 'rightCalfCm']) {
    add(output, `health.measurements.${key.replace(/Cm$/, '').replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}_cm`, optionalNumber(record, key, 1, 300), 'cm')
  }
  if (record.method !== undefined) add(output, 'health.measurements.method', boundedIdentifier(record.method, 'method', 40))
  if (record.calibrationMethod !== undefined) add(output, 'health.measurements.calibration_method', boundedIdentifier(record.calibrationMethod, 'calibrationMethod', 60))
  if (record.calibrationId !== undefined) add(output, 'health.measurements.calibration_id', boundedIdentifier(record.calibrationId, 'calibrationId', 80))
  if (record.captureConditions !== undefined) {
    const capture = plainRecord(record.captureConditions, 'captureConditions')
    const normalized: Record<string, unknown> = {}
    if (capture.lightingProfile !== undefined) normalized.lightingProfile = boundedIdentifier(capture.lightingProfile, 'captureConditions.lightingProfile', 60)
    const distanceCm = optionalNumber(capture, 'distanceCm', 1, 1_000); if (distanceCm !== undefined) normalized.distanceCm = distanceCm
    if (capture.deviceModel !== undefined) normalized.deviceModel = text(capture.deviceModel, 'captureConditions.deviceModel', 100)
    if (capture.view !== undefined) normalized.view = boundedIdentifier(capture.view, 'captureConditions.view', 30)
    if (capture.scaleReference !== undefined) normalized.scaleReference = boundedIdentifier(capture.scaleReference, 'captureConditions.scaleReference', 80)
    const ambientLux = optionalNumber(capture, 'ambientLux', 0, 200_000); if (ambientLux !== undefined) normalized.ambientLux = ambientLux
    if (Object.keys(normalized).length === 0) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'captureConditions contains no supported fields')
    add(output, 'health.measurements.capture_conditions', normalized)
  }
  if (record.modelVersion !== undefined) add(output, 'health.measurements.model_version', boundedIdentifier(record.modelVersion, 'modelVersion', 64))
  add(output, 'health.measurements.model_confidence', optionalNumber(record, 'modelConfidence', 0, 1))
  return output
}

function normalizePosture(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.findings !== undefined) {
    if (!Array.isArray(record.findings) || record.findings.length > 32) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'findings is invalid')
    add(output, 'health.posture.findings', unorderedUnique(record.findings.map((item, index) => {
      const finding = plainRecord(item, `findings[${index}]`)
      return { code: boundedIdentifier(finding.code, 'finding.code', 60), severity: number(finding.severity, 'finding.severity', 0, 1), confidence: number(finding.confidence, 'finding.confidence', 0, 1) }
    })))
  }
  if (record.angles !== undefined) {
    const angles = plainRecord(record.angles, 'angles'); const normalized: Record<string, number> = {}
    const allowed: Array<[string, number, number]> = [
      ['headForwardDeg', -90, 90], ['shoulderTiltDeg', -45, 45], ['scapularAsymmetryDeg', -45, 45],
      ['thoracicKyphosisDeg', -180, 180], ['lumbarLordosisDeg', -180, 180], ['pelvicTiltDeg', -45, 45],
      ['pelvicObliquityDeg', -45, 45], ['spineLeanDeg', -45, 45], ['kneeValgusLeftDeg', -90, 90], ['kneeValgusRightDeg', -90, 90],
    ]
    for (const [key, min, max] of allowed) { const value = optionalNumber(angles, key, min, max); if (value !== undefined) normalized[key] = value }
    if (Object.keys(normalized).length) add(output, 'health.posture.angles', normalized, 'degree')
  }
  if (record.landmarks !== undefined) {
    if (!Array.isArray(record.landmarks) || record.landmarks.length > 128) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'landmarks is invalid')
    add(output, 'health.posture.landmarks', unorderedUnique(record.landmarks.map((item, index) => {
      const landmark = plainRecord(item, `landmarks[${index}]`)
      const normalized: Record<string, unknown> = {
        name: boundedIdentifier(landmark.name, 'landmark.name', 60), x: number(landmark.x, 'landmark.x', -10, 10),
        y: number(landmark.y, 'landmark.y', -10, 10), confidence: number(landmark.confidence, 'landmark.confidence', 0, 1),
      }
      if (landmark.z !== undefined) normalized.z = number(landmark.z, 'landmark.z', -10, 10)
      return normalized
    })))
  }
  if (record.capture !== undefined) {
    const capture = plainRecord(record.capture, 'capture')
    if (!Array.isArray(capture.views) || capture.views.length < 1 || capture.views.length > 4) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'capture.views is invalid')
    add(output, 'health.posture.capture', { views: [...new Set(capture.views.map((view, index) => text(view, `capture.views[${index}]`, 20)))].sort(compareUtf8), quality: number(capture.quality, 'capture.quality', 0, 1) })
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
    add(output, 'health.skin.appearances', unorderedUnique(record.appearances.map((item, index) => {
      const appearance = plainRecord(item, `appearances[${index}]`)
      return { type: boundedIdentifier(appearance.type, 'appearance.type', 60), severity: number(appearance.severity, 'appearance.severity', 0, 1) }
    })))
  }
  if (record.trend !== undefined) {
    const trend = boundedIdentifier(record.trend, 'trend', 20)
    if (!['improving', 'stable', 'worsening', 'unknown'].includes(trend!)) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'trend is invalid')
    add(output, 'health.skin.trend', trend)
  }
  add(output, 'health.skin.capture_quality', optionalNumber(record, 'captureQuality', 0, 1))
  if (record.lightingProfile !== undefined) add(output, 'health.skin.lighting_profile', boundedIdentifier(record.lightingProfile, 'lightingProfile', 60))
  add(output, 'health.skin.distance_cm', optionalNumber(record, 'distanceCm', 1, 1_000), 'cm')
  if (record.device !== undefined) add(output, 'health.skin.device', text(record.device, 'device', 100))
  if (record.comparisonBaseline !== undefined) add(output, 'health.skin.comparison_baseline', boundedIdentifier(record.comparisonBaseline, 'comparisonBaseline', 120))
  return output
}

function normalizeDiet(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.foods !== undefined) {
    if (!Array.isArray(record.foods) || record.foods.length > 64) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'foods is invalid')
    add(output, 'health.diet.foods', unorderedBag(record.foods.map((item, index) => {
      const food = plainRecord(item, `foods[${index}]`)
      return { name: text(food.name, 'food.name', 100), portionGrams: number(food.portionGrams, 'food.portionGrams', 0.1, 10_000) }
    })))
  }
  if (record.supplements !== undefined) {
    if (!Array.isArray(record.supplements) || record.supplements.length > 32) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'supplements is invalid')
    add(output, 'health.diet.supplements', unorderedBag(record.supplements.map((item, index) => {
      const supplement = plainRecord(item, `supplements[${index}]`)
      return {
        name: text(supplement.name, 'supplement.name', 100), amount: number(supplement.amount, 'supplement.amount', 0.0001, 100_000),
        unit: text(supplement.unit, 'supplement.unit', 30),
      }
    })))
  }
  if (record.mealTime !== undefined) add(output, 'health.diet.meal_time', strictTimestamp(record.mealTime, 'mealTime'))
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
  add(output, 'health.diet.parser_confidence', optionalNumber(record, 'parserConfidence', 0, 1))
  add(output, 'health.diet.portion_confirmed', optionalBoolean(record, 'portionConfirmed'))
  if (record.confirmationStatus !== undefined) {
    const status = boundedIdentifier(record.confirmationStatus, 'confirmationStatus', 30)
    if (!['estimated', 'unconfirmed', 'pending_confirmation', 'confirmed'].includes(status!)) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'confirmationStatus is invalid')
    add(output, 'health.diet.confirmation_status', status)
  }
  return output
}

function normalizeFitness(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.exercise !== undefined) add(output, 'health.fitness.exercise', text(record.exercise, 'exercise', 100))
  if (record.exercises !== undefined) {
    if (!Array.isArray(record.exercises) || record.exercises.length < 1 || record.exercises.length > 64) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'exercises is invalid')
    add(output, 'health.fitness.exercises', record.exercises.map((item, exerciseIndex) => {
      const exercise = plainRecord(item, `exercises[${exerciseIndex}]`)
      const normalized: Record<string, unknown> = { name: text(exercise.name, 'exercise.name', 100) }
      if (exercise.sets !== undefined) {
        if (!Array.isArray(exercise.sets) || exercise.sets.length > 100) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'exercise.sets is invalid')
        normalized.sets = exercise.sets.map((itemSet, setIndex) => {
          const set = plainRecord(itemSet, `exercises[${exerciseIndex}].sets[${setIndex}]`)
          const normalizedSet: Record<string, unknown> = {}
          const reps = optionalNumber(set, 'reps', 0, 10_000, true); if (reps !== undefined) normalizedSet.reps = reps
          const loadKg = optionalNumber(set, 'loadKg', 0, 1_000); if (loadKg !== undefined) normalizedSet.loadKg = loadKg
          const durationSeconds = optionalNumber(set, 'durationSeconds', 0, 86_400); if (durationSeconds !== undefined) normalizedSet.durationSeconds = durationSeconds
          const rpe = optionalNumber(set, 'rpe', 0, 10); if (rpe !== undefined) normalizedSet.rpe = rpe
          const completed = optionalBoolean(set, 'completed'); if (completed !== undefined) normalizedSet.completed = completed
          if (Object.keys(normalizedSet).length === 0) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'exercise set contains no supported fields')
          return normalizedSet
        })
      }
      const durationMinutes = optionalNumber(exercise, 'durationMinutes', 0, 1_440); if (durationMinutes !== undefined) normalized.durationMinutes = durationMinutes
      if (exercise.intensity !== undefined) normalized.intensity = boundedIdentifier(exercise.intensity, 'exercise.intensity', 30)
      if (exercise.muscles !== undefined) {
        if (!Array.isArray(exercise.muscles) || exercise.muscles.length > 32) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'exercise.muscles is invalid')
        normalized.muscles = [...new Set(exercise.muscles.map((muscle, index) => boundedIdentifier(muscle, `exercise.muscles[${index}]`, 50) as string))].sort(compareUtf8)
      }
      const pain = optionalNumber(exercise, 'pain', 0, 10); if (pain !== undefined) normalized.pain = pain
      const rpe = optionalNumber(exercise, 'rpe', 0, 10); if (rpe !== undefined) normalized.rpe = rpe
      const completed = optionalBoolean(exercise, 'completed'); if (completed !== undefined) normalized.completed = completed
      return normalized
    }))
  }
  const fields: Array<[string, string, string | null, number, number, boolean?]> = [
    ['sets', 'sets', null, 0, 100, true], ['reps', 'reps', null, 0, 10_000, true], ['loadKg', 'load_kg', 'kg', 0, 1_000],
    ['durationMinutes', 'duration_minutes', 'min', 0, 1_440], ['pain', 'pain', null, 0, 10], ['rpe', 'rpe', null, 0, 10],
  ]
  for (const [key, suffix, unit, min, max, integer] of fields) add(output, `health.fitness.${suffix}`, optionalNumber(record, key, min, max, integer), unit)
  add(output, 'health.fitness.training_load', optionalNumber(record, 'trainingLoad', 0, 1e9))
  if (record.intensity !== undefined) add(output, 'health.fitness.intensity', boundedIdentifier(record.intensity, 'intensity', 30))
  if (record.muscles !== undefined) {
    if (!Array.isArray(record.muscles) || record.muscles.length > 32) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'muscles is invalid')
    add(output, 'health.fitness.muscles', [...new Set(record.muscles.map((muscle, index) => boundedIdentifier(muscle, `muscles[${index}]`, 50)!))].sort(compareUtf8))
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
  add(output, 'health.sleep.resting_respiratory_rate_brpm', optionalNumber(record, 'restingRespiratoryRateBrpm', 1, 100), 'breath/min')
  add(output, 'health.sleep.resting_spo2_percent', optionalNumber(record, 'restingSpo2Percent', 0, 100), '%')
  add(output, 'health.sleep.freshness_minutes', optionalNumber(record, 'freshnessMinutes', 0, 525_600), 'min')
  add(output, 'health.sleep.subjective_recovery', optionalNumber(record, 'subjectiveRecovery', 0, 10))
  add(output, 'health.sleep.recovery_score', optionalNumber(record, 'recoveryScore', 0, 100))
  return output
}

function normalizeInternal(record: Record<string, unknown>): NormalizedHealthObservation[] {
  const output: NormalizedHealthObservation[] = []
  if (record.markers !== undefined) {
    if (!Array.isArray(record.markers) || record.markers.length < 1 || record.markers.length > 128) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'markers is invalid')
    add(output, 'health.internal_health.markers', unorderedUnique(record.markers.map((item, index) => {
      const marker = plainRecord(item, `markers[${index}]`)
      const key = marker.key ?? marker.name
      const normalized: Record<string, unknown> = {
        key: boundedIdentifier(key, 'marker.key', 80), value: number(marker.value, 'marker.value', -1e12, 1e12), unit: text(marker.unit, 'marker.unit', 40),
      }
      if (marker.key !== undefined && marker.name !== undefined && marker.key !== marker.name) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'marker key aliases conflict')
      if (marker.displayLabel !== undefined) normalized.displayLabel = text(marker.displayLabel, 'marker.displayLabel', 160)
      const interval = marker.referenceInterval === undefined ? undefined : plainRecord(marker.referenceInterval, 'marker.referenceInterval')
      const low = optionalAliasedNumber({ low: marker.referenceLow, intervalLow: interval?.low }, ['low', 'intervalLow'], -1e12, 1e12)
      const high = optionalAliasedNumber({ high: marker.referenceHigh, intervalHigh: interval?.high }, ['high', 'intervalHigh'], -1e12, 1e12)
      if (low !== undefined && high !== undefined && low > high) fail('HEALTH_INGESTION_INVALID_NUMBER', 'marker reference range is invalid')
      if (low !== undefined || high !== undefined) normalized.referenceInterval = { ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}) }
      const providerFlag = marker.providerAbnormalFlag ?? marker.providerFlag
      if (marker.providerAbnormalFlag !== undefined && marker.providerFlag !== undefined && marker.providerAbnormalFlag !== marker.providerFlag) {
        fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'marker provider flag aliases conflict')
      }
      if (providerFlag !== undefined) normalized.providerFlag = boundedIdentifier(providerFlag, 'marker.providerFlag', 40)
      if (marker.measuredAt !== undefined) normalized.measuredAt = strictTimestamp(marker.measuredAt, 'marker.measuredAt')
      const evidence = marker.evidence === undefined ? undefined : plainRecord(marker.evidence, 'marker.evidence')
      const pageValues = [marker.page, evidence?.page].filter(value => value !== undefined).map(value => number(value, 'marker.evidence.page', 1, 10_000, true))
      if (pageValues.length > 1 && pageValues[0] !== pageValues[1]) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'marker evidence page aliases conflict')
      const regionValues = [marker.region, evidence?.region].filter(value => value !== undefined).map(value => {
        if (typeof value === 'string') return text(value, 'marker.evidence.region', 160)
        const region = plainRecord(value, 'marker.evidence.region')
        return {
          x: number(region.x, 'marker.evidence.region.x', 0, 1), y: number(region.y, 'marker.evidence.region.y', 0, 1),
          width: number(region.width, 'marker.evidence.region.width', 0, 1), height: number(region.height, 'marker.evidence.region.height', 0, 1),
        }
      })
      if (regionValues.length > 1 && canonicalSafeJson(regionValues[0]) !== canonicalSafeJson(regionValues[1])) fail('HEALTH_INGESTION_INVALID_PAYLOAD', 'marker evidence region aliases conflict')
      if (pageValues.length || regionValues.length) normalized.evidence = { ...(pageValues.length ? { page: pageValues[0] } : {}), ...(regionValues.length ? { region: regionValues[0] } : {}) }
      return normalized
    })))
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
  validateSafeJson(input)
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
  }))].sort(compareUtf8)
  if (artifactIds.length > 32) fail('HEALTH_INGESTION_INVALID_ARTIFACT_ID', 'too many artifact IDs')
  const observations = NORMALIZERS[input.domain](payload).sort((left, right) => compareUtf8(left.metric, right.metric))
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
