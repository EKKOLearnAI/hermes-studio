import { isProxy } from 'node:util/types'
import { createHash } from 'crypto'
import { normalizeHealthIngestionEnvelope } from './normalizers'
import type { HealthIngestionEnvelope } from './types'
import { getHealthCaptureProtocol, type HealthCapturePurpose } from './capture-protocols'

export type HealthAnalysisErrorCode =
  | 'HEALTH_ANALYSIS_INVALID_REQUEST'
  | 'HEALTH_ANALYSIS_INVALID_INPUT'
  | 'HEALTH_ANALYSIS_INVALID_OUTPUT'
  | 'HEALTH_ANALYSIS_CONSENT_DENIED'
  | 'HEALTH_ANALYSIS_ARTIFACT_DENIED'
  | 'HEALTH_ANALYSIS_TIMEOUT'
  | 'HEALTH_ANALYSIS_PROCESSOR_FAILED'

export class HealthAnalysisError extends Error {
  constructor(public readonly code: HealthAnalysisErrorCode) {
    super(code)
    this.name = 'HealthAnalysisError'
  }
}

export interface HealthAnalysisRequest {
  schemaVersion: 'health-analysis-request/v1'
  profile: string
  purpose: HealthCapturePurpose
  sourceId: string
  observedAt: string
  artifactIds: string[]
  selectedRegions: string[]
  requestedFields: string[]
  manifest?: import('./consent').HealthProcessingManifest
  consentToken?: string
}

export interface HealthAnalysisEvidence {
  artifactId: string
  region?: string
  page?: number
}

export interface HealthAnalysisField {
  field: string
  value: unknown
  unit?: string
  confidence: number
  evidence: HealthAnalysisEvidence
}

export interface HealthAnalyzerOutput {
  schemaVersion: 'health-analyzer-output/v1'
  modelVersion: string
  parserVersion: string
  overallConfidence: number
  captureQuality: { score: number; reasons: string[] }
  fields: HealthAnalysisField[]
}

export interface HealthAnalysisResult {
  schemaVersion: 'health-analysis-result/v1'
  purpose: HealthCapturePurpose
  status: 'completed' | 'recapture_required' | 'pending_confirmation'
  modelVersion: string
  parserVersion: string
  overallConfidence: number
  captureQuality: { score: number; reasons: string[] }
  fields: HealthAnalysisField[]
  recaptureGuidance?: string[]
  envelope?: HealthIngestionEnvelope
}

export interface HealthAnalysisProcessorIdentity {
  processor: string
  locality: 'local' | 'remote'
}

export type HealthAnalysisSemanticType = 'number' | 'string' | 'boolean' | 'record' | 'array'
export interface HealthAnalysisFieldSpec {
  unit: string | null
  semanticType: HealthAnalysisSemanticType
}

const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ARTIFACT_ID = /^artifact-[0-9a-f]{64}$/
const CONSENT_TOKEN = /^[0-9a-f]{64}$/
const SEMANTIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const REGION = /^[\p{L}\p{N}._:/-]+$/u
const QUALITY_REASONS = new Set(['blur', 'glare', 'low_light', 'framing', 'missing_view', 'distance', 'scale_reference', 'region_mismatch'])
const QUALITY_GUIDANCE: Record<string, string> = {
  blur: 'Recapture with the image in sharp focus.', glare: 'Recapture without glare on the subject.',
  low_light: 'Recapture using the required even lighting.', framing: 'Recapture with the full required area in frame.',
  missing_view: 'Capture every required view.', distance: 'Recapture within the required distance range.',
  scale_reference: 'Include the required scale reference.', region_mismatch: 'Recapture the selected body region.',
}

const spec = (semanticType: HealthAnalysisSemanticType, unit: string | null = null): HealthAnalysisFieldSpec => Object.freeze({ semanticType, unit })
const measurementUnits = Object.fromEntries(['chestCm', 'waistCm', 'hipCm', 'leftArmCm', 'rightArmCm', 'leftThighCm', 'rightThighCm', 'leftCalfCm', 'rightCalfCm']
  .map(field => [field, spec('number', 'cm')]))

export const HEALTH_ANALYSIS_FIELD_SPECS: Readonly<Record<HealthCapturePurpose, Readonly<Record<string, HealthAnalysisFieldSpec>>>> = Object.freeze({
  measurement: Object.freeze({ ...measurementUnits, method: spec('string'), calibrationMethod: spec('string'), calibrationId: spec('string'), captureConditions: spec('record') }),
  posture: Object.freeze({ findings: spec('array'), angles: spec('record', 'degree'), landmarks: spec('array'), capture: spec('record') }),
  skin: Object.freeze({ region: spec('string'), appearances: spec('array'), trend: spec('string'), lightingProfile: spec('string'), distanceCm: spec('number', 'cm'), device: spec('string'), comparisonBaseline: spec('string') }),
  diet: Object.freeze({ foods: spec('array'), supplements: spec('array'), mealTime: spec('string'), caloriesKcal: spec('number', 'kcal'), proteinG: spec('number', 'g'), carbsG: spec('number', 'g'), fatG: spec('number', 'g'), waterMl: spec('number', 'mL'), micros: spec('record'), portionConfirmed: spec('boolean'), confirmationStatus: spec('string') }),
  internal_health: Object.freeze({ markers: spec('array'), reportDate: spec('string'), institution: spec('string') }),
})

const REQUESTED_FIELDS: Readonly<Record<HealthCapturePurpose, readonly string[]>> = Object.freeze(Object.fromEntries(
  Object.entries(HEALTH_ANALYSIS_FIELD_SPECS).map(([purpose, fields]) => [purpose, Object.freeze(Object.keys(fields))]),
) as Record<HealthCapturePurpose, readonly string[]>)

const PAYLOAD_NESTED_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  captureConditions: Object.freeze(['lightingProfile', 'distanceCm', 'deviceModel', 'view', 'scaleReference', 'ambientLux']),
  finding: Object.freeze(['code', 'severity', 'confidence']),
  angles: Object.freeze(['headForwardDeg', 'shoulderTiltDeg', 'scapularAsymmetryDeg', 'thoracicKyphosisDeg', 'lumbarLordosisDeg', 'pelvicTiltDeg', 'pelvicObliquityDeg', 'spineLeanDeg', 'kneeValgusLeftDeg', 'kneeValgusRightDeg']),
  landmark: Object.freeze(['name', 'x', 'y', 'z', 'confidence']), capture: Object.freeze(['views', 'quality']),
  appearance: Object.freeze(['type', 'severity']), food: Object.freeze(['name', 'portionGrams']),
  supplement: Object.freeze(['name', 'amount', 'unit']), micros: Object.freeze(['fiberG', 'sodiumMg', 'potassiumMg', 'calciumMg', 'ironMg']),
  marker: Object.freeze(['key', 'name', 'displayLabel', 'value', 'unit', 'referenceLow', 'referenceHigh', 'referenceInterval', 'providerAbnormalFlag', 'providerFlag', 'measuredAt', 'page', 'region', 'evidence']),
  referenceInterval: Object.freeze(['low', 'high']), evidence: Object.freeze(['page', 'region']),
  box: Object.freeze(['x', 'y', 'width', 'height']),
})

function fail(code: HealthAnalysisErrorCode): never { throw new HealthAnalysisError(code) }

function ownRecord(value: unknown, code: HealthAnalysisErrorCode): { values: Record<string, unknown>; keys: string[] } {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail(code)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail(code)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.some(key => typeof key !== 'string' || POISON_KEYS.has(key)
      || !('value' in descriptors[key as string]) || !descriptors[key as string].enumerable)) fail(code)
    const keys = ownKeys as string[]
    return { values: Object.fromEntries(keys.map(key => [key, descriptors[key].value])), keys }
  } catch (error) {
    if (error instanceof HealthAnalysisError) throw error
    return fail(code)
  }
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], code: HealthAnalysisErrorCode): Record<string, unknown> {
  const record = ownRecord(value, code)
  if (required.some(key => !record.keys.includes(key)) || record.keys.some(key => !required.includes(key) && !optional.includes(key))) fail(code)
  return record.values
}

function assertSafeGraph(value: unknown, code: HealthAnalysisErrorCode): void {
  const seen = new Set<object>(); let nodes = 0; let bytes = 0
  const visit = (item: unknown, depth: number): void => {
    nodes += 1
    if (nodes > 2048 || depth > 10) fail(code)
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(code); return }
    if (typeof item === 'string') { bytes += Buffer.byteLength(item, 'utf8'); if (bytes > 256 * 1024 || /[\ud800-\udfff]/u.test(item.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) fail(code); return }
    if (!item || typeof item !== 'object' || isProxy(item) || seen.has(item)) fail(code)
    const prototype = Object.getPrototypeOf(item)
    if (Array.isArray(item)) { if (prototype !== Array.prototype || item.length > 256) fail(code) }
    else if (prototype !== Object.prototype && prototype !== null) fail(code)
    seen.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      if (Array.isArray(item)) {
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== item.length + 1 || !Object.hasOwn(descriptors, 'length')) fail(code)
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = descriptors[String(index)]
          if (!descriptor?.enumerable || !('value' in descriptor)) fail(code)
        }
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || POISON_KEYS.has(key) || !('value' in descriptors[key])) fail(code)
        if (key !== 'length') visit(descriptors[key].value, depth + 1)
      }
    } catch (error) {
      if (error instanceof HealthAnalysisError) throw error
      fail(code)
    } finally { seen.delete(item) }
  }
  visit(value, 0)
}

function semantic(value: unknown, max: number, code: HealthAnalysisErrorCode): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !SEMANTIC_ID.test(value)) fail(code)
  return value
}

function boundedString(value: unknown, max: number, pattern: RegExp, code: HealthAnalysisErrorCode): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) fail(code)
  return value
}

function confidence(value: unknown, code: HealthAnalysisErrorCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(code)
  return value
}

function canonicalSet(value: unknown, pattern: RegExp, maxItems: number, code: HealthAnalysisErrorCode): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) fail(code)
  const result = value.map(item => boundedString(item, 180, pattern, code))
  if (new Set(result).size !== result.length) fail(code)
  return [...result].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

function strictObservedAt(value: unknown, code: HealthAnalysisErrorCode): string {
  try {
    return normalizeHealthIngestionEnvelope({
      domain: 'measurements', source: 'analysis.validation', sourceId: 'timestamp-validation', observedAt: value as string,
      evidenceClass: 'inferred', confidence: 1, payload: { waistCm: 1 },
    }).observedAt
  } catch { return fail(code) }
}

export function validateHealthAnalysisRequest(
  input: HealthAnalysisRequest,
  locality?: HealthAnalysisProcessorIdentity['locality'],
): HealthAnalysisRequest {
  assertSafeGraph(input, 'HEALTH_ANALYSIS_INVALID_REQUEST')
  const record = exactRecord(input,
    ['schemaVersion', 'profile', 'purpose', 'sourceId', 'observedAt', 'artifactIds', 'selectedRegions', 'requestedFields'],
    ['manifest', 'consentToken'], 'HEALTH_ANALYSIS_INVALID_REQUEST')
  if (record.schemaVersion !== 'health-analysis-request/v1' || !Object.hasOwn(REQUESTED_FIELDS, record.purpose as PropertyKey)) fail('HEALTH_ANALYSIS_INVALID_REQUEST')
  const purpose = record.purpose as HealthCapturePurpose
  const profile = semantic(record.profile, 80, 'HEALTH_ANALYSIS_INVALID_REQUEST')
  const sourceId = semantic(record.sourceId, 120, 'HEALTH_ANALYSIS_INVALID_REQUEST')
  const artifactIds = canonicalSet(record.artifactIds, ARTIFACT_ID, 16, 'HEALTH_ANALYSIS_INVALID_REQUEST')
  const selectedRegions = canonicalSet(record.selectedRegions, REGION, 64, 'HEALTH_ANALYSIS_INVALID_REQUEST')
  const requestedFields = canonicalSet(record.requestedFields, SEMANTIC_ID, 64, 'HEALTH_ANALYSIS_INVALID_REQUEST')
  if (requestedFields.some(field => !REQUESTED_FIELDS[purpose].includes(field))) fail('HEALTH_ANALYSIS_INVALID_REQUEST')
  if (record.consentToken !== undefined && typeof record.consentToken !== 'string') fail('HEALTH_ANALYSIS_INVALID_REQUEST')
  const hasManifest = Object.hasOwn(record, 'manifest')
  const hasConsentToken = Object.hasOwn(record, 'consentToken')
  if (locality === 'local' && (hasManifest || hasConsentToken)) fail('HEALTH_ANALYSIS_INVALID_REQUEST')
  if (locality === 'remote' && (!hasManifest || !hasConsentToken)) fail('HEALTH_ANALYSIS_INVALID_REQUEST')
  if (locality === 'remote' && (typeof record.consentToken !== 'string' || !CONSENT_TOKEN.test(record.consentToken))) {
    fail('HEALTH_ANALYSIS_INVALID_REQUEST')
  }
  return {
    schemaVersion: 'health-analysis-request/v1', profile, purpose, sourceId,
    observedAt: strictObservedAt(record.observedAt, 'HEALTH_ANALYSIS_INVALID_REQUEST'), artifactIds, selectedRegions, requestedFields,
    ...(record.manifest !== undefined ? { manifest: record.manifest as HealthAnalysisRequest['manifest'] } : {}),
    ...(record.consentToken !== undefined ? { consentToken: record.consentToken } : {}),
  }
}

function assertOnlyKeys(value: unknown, allowed: readonly string[], code: HealthAnalysisErrorCode): Record<string, unknown> {
  const record = ownRecord(value, code)
  if (record.keys.some(key => !allowed.includes(key))) fail(code)
  return record.values
}

function assertPayloadShape(purpose: HealthCapturePurpose, payload: Record<string, unknown>): void {
  const code = 'HEALTH_ANALYSIS_INVALID_OUTPUT' as const
  if (purpose === 'measurement' && payload.captureConditions !== undefined) assertOnlyKeys(payload.captureConditions, PAYLOAD_NESTED_KEYS.captureConditions, code)
  if (purpose === 'posture') {
    if (payload.findings !== undefined) {
      if (!Array.isArray(payload.findings)) fail(code)
      payload.findings.forEach(value => assertOnlyKeys(value, PAYLOAD_NESTED_KEYS.finding, code))
    }
    if (payload.angles !== undefined) assertOnlyKeys(payload.angles, PAYLOAD_NESTED_KEYS.angles, code)
    if (payload.landmarks !== undefined) {
      if (!Array.isArray(payload.landmarks)) fail(code)
      payload.landmarks.forEach(value => assertOnlyKeys(value, PAYLOAD_NESTED_KEYS.landmark, code))
    }
    if (payload.capture !== undefined) assertOnlyKeys(payload.capture, PAYLOAD_NESTED_KEYS.capture, code)
  }
  if (purpose === 'skin' && payload.appearances !== undefined) {
    if (!Array.isArray(payload.appearances)) fail(code)
    payload.appearances.forEach(value => assertOnlyKeys(value, PAYLOAD_NESTED_KEYS.appearance, code))
  }
  if (purpose === 'diet') {
    if (payload.foods !== undefined) {
      if (!Array.isArray(payload.foods)) fail(code)
      payload.foods.forEach(value => assertOnlyKeys(value, PAYLOAD_NESTED_KEYS.food, code))
    }
    if (payload.supplements !== undefined) {
      if (!Array.isArray(payload.supplements)) fail(code)
      payload.supplements.forEach(value => assertOnlyKeys(value, PAYLOAD_NESTED_KEYS.supplement, code))
    }
    if (payload.micros !== undefined) assertOnlyKeys(payload.micros, PAYLOAD_NESTED_KEYS.micros, code)
  }
  if (purpose === 'internal_health' && payload.markers !== undefined) {
    if (!Array.isArray(payload.markers)) fail(code)
    payload.markers.forEach(value => {
      const marker = assertOnlyKeys(value, PAYLOAD_NESTED_KEYS.marker, code)
      if (marker.referenceInterval !== undefined) assertOnlyKeys(marker.referenceInterval, PAYLOAD_NESTED_KEYS.referenceInterval, code)
      if (marker.evidence !== undefined) {
        const evidence = assertOnlyKeys(marker.evidence, PAYLOAD_NESTED_KEYS.evidence, code)
        if (evidence.region !== undefined && typeof evidence.region !== 'string') assertOnlyKeys(evidence.region, PAYLOAD_NESTED_KEYS.box, code)
      }
      if (marker.region !== undefined && typeof marker.region !== 'string') assertOnlyKeys(marker.region, PAYLOAD_NESTED_KEYS.box, code)
    })
  }
}

function pageInScope(page: number, selectedRegions: string[]): boolean {
  return selectedRegions.some(region => region === `page:${page}` || region.startsWith(`page:${page}/`))
}

function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneValue)
  const result: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) result[key] = cloneValue(descriptor.value)
  return result
}

function validateFieldSemantics(purpose: HealthCapturePurpose, field: Record<string, unknown>): void {
  const fieldName = field.field as string
  const fieldSpec = HEALTH_ANALYSIS_FIELD_SPECS[purpose][fieldName]
  if (!fieldSpec) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  if (fieldSpec.unit === null ? field.unit !== undefined : field.unit !== fieldSpec.unit) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  const value = field.value
  const valid = fieldSpec.semanticType === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : fieldSpec.semanticType === 'string' ? typeof value === 'string'
      : fieldSpec.semanticType === 'boolean' ? typeof value === 'boolean'
        : fieldSpec.semanticType === 'array' ? Array.isArray(value)
          : !!value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value)
  if (!valid) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
}

function digestSuffix(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16) }

export function finalizeHealthAnalysis(
  inputRequest: HealthAnalysisRequest,
  inputOutput: unknown,
  identity: HealthAnalysisProcessorIdentity,
): HealthAnalysisResult {
  if (!identity || !['local', 'remote'].includes(identity.locality)) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  const request = validateHealthAnalysisRequest(inputRequest, identity.locality)
  assertSafeGraph(inputOutput, 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  const output = exactRecord(inputOutput,
    ['schemaVersion', 'modelVersion', 'parserVersion', 'overallConfidence', 'captureQuality', 'fields'], [], 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  if (output.schemaVersion !== 'health-analyzer-output/v1') fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  semantic(identity.processor, 80, 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  const modelVersion = semantic(output.modelVersion, 64, 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  const parserVersion = semantic(output.parserVersion, 64, 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  const overallConfidence = confidence(output.overallConfidence, 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  const quality = exactRecord(output.captureQuality, ['score', 'reasons'], [], 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  const score = confidence(quality.score, 'HEALTH_ANALYSIS_INVALID_OUTPUT')
  if (!Array.isArray(quality.reasons) || quality.reasons.length > 8) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  const reasons = quality.reasons.map(reason => {
    if (typeof reason !== 'string' || !QUALITY_REASONS.has(reason)) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    return reason
  })
  if (new Set(reasons).size !== reasons.length) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  if (!Array.isArray(output.fields) || output.fields.length < 1 || output.fields.length > request.requestedFields.length) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  const seenFields = new Set<string>()
  const fields: HealthAnalysisField[] = output.fields.map(item => {
    const field = exactRecord(item, ['field', 'value', 'confidence', 'evidence'], ['unit'], 'HEALTH_ANALYSIS_INVALID_OUTPUT')
    const fieldName = semantic(field.field, 100, 'HEALTH_ANALYSIS_INVALID_OUTPUT')
    if (!request.requestedFields.includes(fieldName) || seenFields.has(fieldName)) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    seenFields.add(fieldName)
    validateFieldSemantics(request.purpose, field)
    const evidence = exactRecord(field.evidence, ['artifactId'], ['region', 'page'], 'HEALTH_ANALYSIS_INVALID_OUTPUT')
    if (typeof evidence.artifactId !== 'string' || !request.artifactIds.includes(evidence.artifactId)) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    if (evidence.region !== undefined && (typeof evidence.region !== 'string' || !request.selectedRegions.includes(evidence.region))) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    if (evidence.page !== undefined && (!Number.isSafeInteger(evidence.page) || (evidence.page as number) < 1
      || (evidence.page as number) > 10_000 || !pageInScope(evidence.page as number, request.selectedRegions))) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    if (field.unit !== undefined && (typeof field.unit !== 'string' || field.unit.length < 1 || field.unit.length > 40)) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    return {
      field: fieldName, value: cloneValue(field.value), ...(field.unit !== undefined ? { unit: field.unit as string } : {}),
      confidence: confidence(field.confidence, 'HEALTH_ANALYSIS_INVALID_OUTPUT'),
      evidence: { artifactId: evidence.artifactId, ...(evidence.region !== undefined ? { region: evidence.region as string } : {}), ...(evidence.page !== undefined ? { page: evidence.page as number } : {}) },
    }
  })

  const baseResult = {
    schemaVersion: 'health-analysis-result/v1' as const, purpose: request.purpose, modelVersion, parserVersion, overallConfidence,
    captureQuality: { score, reasons },
  }
  const qualityThreshold = getHealthCaptureProtocol(request.purpose).qualityThreshold
  if (score < qualityThreshold && reasons.length === 0) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  if (score < qualityThreshold) {
    return { ...baseResult, status: 'recapture_required', fields: [], recaptureGuidance: reasons.map(reason => QUALITY_GUIDANCE[reason]) }
  }

  const payload = Object.fromEntries(fields.map(field => [field.field, cloneValue(field.value)]))
  assertPayloadShape(request.purpose, payload)
  const averageConfidence = fields.reduce((sum, field) => sum + field.confidence, 0) / fields.length
  if (request.purpose === 'measurement') Object.assign(payload, { modelVersion, modelConfidence: averageConfidence })
  if (request.purpose === 'posture') Object.assign(payload, { modelVersion, modelConfidence: averageConfidence })
  if (request.purpose === 'skin') Object.assign(payload, { captureQuality: score })
  if (request.purpose === 'diet') Object.assign(payload, { parserConfidence: averageConfidence })
  const domain = request.purpose === 'measurement' ? 'measurements' : request.purpose
  let stableSourceId = `${request.sourceId}:${modelVersion}:${parserVersion}`
  if (stableSourceId.length > 200) stableSourceId = `${request.sourceId.slice(0, 160)}:${digestSuffix(`${modelVersion}:${parserVersion}`)}`
  const envelope: HealthIngestionEnvelope = {
    domain, source: `analysis.${identity.locality}`, sourceId: stableSourceId, observedAt: request.observedAt,
    evidenceClass: 'inferred', confidence: overallConfidence, payload, artifactIds: request.artifactIds, parserVersion,
  }
  try { normalizeHealthIngestionEnvelope(envelope) } catch { fail('HEALTH_ANALYSIS_INVALID_OUTPUT') }
  return {
    ...baseResult, status: request.purpose === 'internal_health' ? 'pending_confirmation' : 'completed', fields, envelope,
  }
}
