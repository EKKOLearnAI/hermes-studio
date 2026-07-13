import { isProxy } from 'node:util/types'

export const HEALTH_CAPTURE_PURPOSES = ['measurement', 'posture', 'skin', 'diet', 'internal_health'] as const
export type HealthCapturePurpose = typeof HEALTH_CAPTURE_PURPOSES[number]

export type HealthCaptureErrorCode = 'HEALTH_CAPTURE_INVALID'

export class HealthCaptureError extends Error {
  constructor(public readonly code: HealthCaptureErrorCode) {
    super(code)
    this.name = 'HealthCaptureError'
  }
}

export interface HealthCaptureProtocol {
  schemaVersion: 'health-capture-protocol/v1'
  purpose: HealthCapturePurpose
  lighting: readonly string[]
  views: readonly string[]
  distance: { unit: 'cm'; minimum: number; maximum: number }
  scaleReference: { requirement: 'required' | 'optional' | 'none'; allowed: readonly string[] }
  bodyRegions: readonly string[]
  minimumImageSet: number
  qualityThreshold: number
}

export interface HealthCaptureSubmission {
  schemaVersion: 'health-capture-submission/v1'
  purpose: HealthCapturePurpose
  lighting: string
  captures: Array<{
    artifactId: string
    view: string
    bodyRegion: string
    distance: { value: number; unit: 'cm' }
    scaleReference?: string
  }>
}

export interface HealthCaptureValidation {
  status: 'accepted' | 'recapture_required'
  score: number
  reasons: string[]
  recaptureGuidance: string[]
}

const ARTIFACT_ID = /^artifact-[0-9a-f]{64}$/
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const PROTOCOLS: Readonly<Record<HealthCapturePurpose, HealthCaptureProtocol>> = Object.freeze({
  measurement: Object.freeze({
    schemaVersion: 'health-capture-protocol/v1', purpose: 'measurement', lighting: Object.freeze(['neutral_diffuse']),
    views: Object.freeze(['front', 'side']), distance: Object.freeze({ unit: 'cm', minimum: 180, maximum: 300 }),
    scaleReference: Object.freeze({ requirement: 'required', allowed: Object.freeze(['a4_sheet']) }),
    bodyRegions: Object.freeze(['full_body']), minimumImageSet: 2, qualityThreshold: 0.7,
  }),
  posture: Object.freeze({
    schemaVersion: 'health-capture-protocol/v1', purpose: 'posture', lighting: Object.freeze(['neutral_diffuse']),
    views: Object.freeze(['front', 'left_side', 'back']), distance: Object.freeze({ unit: 'cm', minimum: 200, maximum: 400 }),
    scaleReference: Object.freeze({ requirement: 'none', allowed: Object.freeze([]) }), bodyRegions: Object.freeze(['full_body']),
    minimumImageSet: 3, qualityThreshold: 0.7,
  }),
  skin: Object.freeze({
    schemaVersion: 'health-capture-protocol/v1', purpose: 'skin', lighting: Object.freeze(['standardized_neutral']),
    views: Object.freeze(['close_up']), distance: Object.freeze({ unit: 'cm', minimum: 30, maximum: 60 }),
    scaleReference: Object.freeze({ requirement: 'none', allowed: Object.freeze([]) }),
    bodyRegions: Object.freeze(['face', 'torso', 'back', 'left_arm', 'right_arm', 'left_leg', 'right_leg']),
    minimumImageSet: 1, qualityThreshold: 0.75,
  }),
  diet: Object.freeze({
    schemaVersion: 'health-capture-protocol/v1', purpose: 'diet', lighting: Object.freeze(['natural_even']),
    views: Object.freeze(['top']), distance: Object.freeze({ unit: 'cm', minimum: 30, maximum: 80 }),
    scaleReference: Object.freeze({ requirement: 'optional', allowed: Object.freeze(['standard_plate']) }),
    bodyRegions: Object.freeze(['meal']), minimumImageSet: 1, qualityThreshold: 0.7,
  }),
  internal_health: Object.freeze({
    schemaVersion: 'health-capture-protocol/v1', purpose: 'internal_health', lighting: Object.freeze(['even_no_glare']),
    views: Object.freeze(['page']), distance: Object.freeze({ unit: 'cm', minimum: 25, maximum: 60 }),
    scaleReference: Object.freeze({ requirement: 'none', allowed: Object.freeze([]) }),
    bodyRegions: Object.freeze(['document']), minimumImageSet: 1, qualityThreshold: 0.8,
  }),
})

function invalid(): never { throw new HealthCaptureError('HEALTH_CAPTURE_INVALID') }

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.some(key => typeof key !== 'string' || POISON_KEYS.has(key) || !('value' in descriptors[key as string]))) invalid()
    const names = actual as string[]
    if (names.length !== keys.length || keys.some(key => !names.includes(key))) invalid()
    return Object.fromEntries(names.map(key => [key, descriptors[key].value]))
  } catch (error) {
    if (error instanceof HealthCaptureError) throw error
    return invalid()
  }
}

function exactArray(value: unknown, maximum: number): unknown[] {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > maximum) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) invalid()
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
    }
    return value
  } catch (error) {
    if (error instanceof HealthCaptureError) throw error
    return invalid()
  }
}

export function getHealthCaptureProtocol(purpose: HealthCapturePurpose): HealthCaptureProtocol {
  if (!(HEALTH_CAPTURE_PURPOSES as readonly unknown[]).includes(purpose)) invalid()
  return PROTOCOLS[purpose]
}

export function validateHealthCapture(input: HealthCaptureSubmission): HealthCaptureValidation {
  const root = exactRecord(input, ['schemaVersion', 'purpose', 'lighting', 'captures'])
  if (root.schemaVersion !== 'health-capture-submission/v1'
    || !(HEALTH_CAPTURE_PURPOSES as readonly unknown[]).includes(root.purpose)) invalid()
  const protocol = getHealthCaptureProtocol(root.purpose as HealthCapturePurpose)
  if (typeof root.lighting !== 'string' || !protocol.lighting.includes(root.lighting)) invalid()
  const inputCaptures = exactArray(root.captures, 8)

  const captures = inputCaptures.map(value => {
    const suppliedKeys = value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value)
      ? Object.getOwnPropertyNames(value) : []
    const hasScale = suppliedKeys.includes('scaleReference')
    const item = exactRecord(value, hasScale
      ? ['artifactId', 'view', 'bodyRegion', 'distance', 'scaleReference']
      : ['artifactId', 'view', 'bodyRegion', 'distance'])
    const distance = exactRecord(item.distance, ['value', 'unit'])
    if (typeof item.artifactId !== 'string' || !ARTIFACT_ID.test(item.artifactId)
      || typeof item.view !== 'string' || !protocol.views.includes(item.view)
      || typeof item.bodyRegion !== 'string' || !protocol.bodyRegions.includes(item.bodyRegion)
      || distance.unit !== 'cm' || typeof distance.value !== 'number' || !Number.isFinite(distance.value)
      || distance.value < protocol.distance.minimum || distance.value > protocol.distance.maximum) invalid()
    if (protocol.scaleReference.requirement === 'required'
      && (typeof item.scaleReference !== 'string' || !protocol.scaleReference.allowed.includes(item.scaleReference))) invalid()
    if (protocol.scaleReference.requirement === 'none' && item.scaleReference !== undefined) invalid()
    if (protocol.scaleReference.requirement === 'optional' && item.scaleReference !== undefined
      && (typeof item.scaleReference !== 'string' || !protocol.scaleReference.allowed.includes(item.scaleReference))) invalid()
    return { artifactId: item.artifactId, view: item.view }
  })
  if (new Set(captures.map(item => item.artifactId)).size !== captures.length
    || new Set(captures.map(item => item.view)).size !== captures.length) invalid()

  const presentViews = new Set(captures.map(item => item.view))
  const missingViews = protocol.views.filter(view => !presentViews.has(view))
  if (captures.length < protocol.minimumImageSet || missingViews.length > 0) {
    return {
      status: 'recapture_required', score: 0,
      reasons: missingViews.map(view => `missing_view:${view}`),
      recaptureGuidance: missingViews.map(view => `Capture the required ${view.replace('_', ' ')} view.`),
    }
  }
  return { status: 'accepted', score: 1, reasons: [], recaptureGuidance: [] }
}
