import { isProxy } from 'node:util/types'
import type { FabricCapabilityInput } from '../action-fabric/registry'
import type { FabricJsonObject } from '../action-fabric/types'

export const ANDROID_APP_LAUNCH_CAPABILITY = 'android.app.launch'
export const ANDROID_SCREEN_CAPTURE_CAPABILITY = 'android.screen.capture'
export const ANDROID_COMPANION_PACKAGE = 'ai.hermes.companion'
export const ANDROID_APP_LAUNCH_VERIFICATION = 'fresh_foreground_package_and_signature'
export const ANDROID_SCREEN_CAPTURE_VERIFICATION = 'fresh_capture_digest_dimensions_and_grant'
export const ANDROID_APP_LAUNCH_PERMISSIONS = ['android.permission.PACKAGE_USAGE_STATS'] as const
export const ANDROID_SCREEN_CAPTURE_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
] as const

function objectSchema(properties: Record<string, unknown>, required: string[]): FabricJsonObject {
  return { type: 'object', additionalProperties: false, properties, required }
}

const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const identifier = {
  type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
}
const packageName = {
  type: 'string', minLength: 3, maxLength: 255,
  pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+$',
}

export const ANDROID_FABRIC_CAPABILITIES: FabricCapabilityInput[] = [
  {
    id: ANDROID_APP_LAUNCH_CAPABILITY,
    version: 1,
    description: 'Launch one exact server-approved Android application binding',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 },
      appBinding: packageName,
      packageFingerprint: digest,
      reasonCode: identifier,
    }, ['schemaVersion', 'appBinding', 'packageFingerprint', 'reasonCode']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 },
      status: { const: 'succeeded' },
      foregroundPackage: packageName,
      foregroundPackageFingerprint: digest,
      observedAt: { type: 'string', format: 'date-time', maxLength: 64 },
    }, ['schemaVersion', 'status', 'foregroundPackage', 'foregroundPackageFingerprint', 'observedAt']),
    risk: 'low',
    sideEffect: true,
    idempotency: 'required',
    reversible: false,
    compensationCapabilityId: null,
    verificationStrategy: ANDROID_APP_LAUNCH_VERIFICATION,
    authentication: ['android_companion:paired', 'android_session:encrypted'],
    targetRestrictions: ['android:device', 'android:package', 'android:package_fingerprint'],
    cost: { currency: null, estimatedMinor: 0 },
    enabled: true,
  },
  {
    id: ANDROID_SCREEN_CAPTURE_CAPABILITY,
    version: 1,
    description: 'Capture one bounded Android screen artifact with an active user-granted projection',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 },
      captureClass: { enum: ['workflow_evidence', 'user_requested'] },
      reasonCode: identifier,
    }, ['schemaVersion', 'captureClass', 'reasonCode']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 },
      status: { const: 'succeeded' },
      captureId: identifier,
      digest,
      mimeType: { enum: ['image/png', 'image/webp'] },
      width: { type: 'integer', minimum: 1, maximum: 16_384 },
      height: { type: 'integer', minimum: 1, maximum: 16_384 },
      byteSize: { type: 'integer', minimum: 1, maximum: 52_428_800 },
      permissionGrantActive: { const: true },
      capturedAt: { type: 'string', format: 'date-time', maxLength: 64 },
    }, ['schemaVersion', 'status', 'captureId', 'digest', 'mimeType', 'width', 'height', 'byteSize',
      'permissionGrantActive', 'capturedAt']),
    risk: 'medium',
    sideEffect: true,
    idempotency: 'required',
    reversible: false,
    compensationCapabilityId: null,
    verificationStrategy: ANDROID_SCREEN_CAPTURE_VERIFICATION,
    authentication: [
      'android_companion:paired', 'android_session:encrypted', 'android_media_projection:active_grant',
    ],
    targetRestrictions: ['android:device', 'android:workflow'],
    cost: { currency: null, estimatedMinor: 0 },
    enabled: true,
  },
]

export function isAndroidFabricCapability(
  capabilityId: string,
): capabilityId is typeof ANDROID_APP_LAUNCH_CAPABILITY | typeof ANDROID_SCREEN_CAPTURE_CAPABILITY {
  return capabilityId === ANDROID_APP_LAUNCH_CAPABILITY || capabilityId === ANDROID_SCREEN_CAPTURE_CAPABILITY
}

export function validateAndroidSemantics(capabilityId: string, input: FabricJsonObject): boolean {
  if (!isAndroidFabricCapability(capabilityId) || !plainObject(input)) return false
  if (capabilityId === ANDROID_APP_LAUNCH_CAPABILITY) {
    return exactKeys(input, ['appBinding', 'packageFingerprint', 'reasonCode', 'schemaVersion'])
      && input.schemaVersion === 1 && packageBinding(input.appBinding) && sha256(input.packageFingerprint)
      && semanticReason(input.reasonCode)
  }
  return exactKeys(input, ['captureClass', 'reasonCode', 'schemaVersion'])
    && input.schemaVersion === 1 && ['workflow_evidence', 'user_requested'].includes(String(input.captureClass))
    && semanticReason(input.reasonCode)
}

export function androidTargetAtoms(
  capabilityId: string,
  target: FabricJsonObject,
  input: FabricJsonObject,
): string[] | null {
  if (!validateAndroidSemantics(capabilityId, input) || !plainObject(target)
    || typeof target.deviceId !== 'string' || !/^hwui_[A-Za-z0-9_-]{32}$/.test(target.deviceId)) return null
  if (capabilityId === ANDROID_APP_LAUNCH_CAPABILITY) {
    if (!exactKeys(target, ['appBinding', 'deviceId', 'kind', 'packageFingerprint'])
      || target.kind !== 'android_app' || target.appBinding !== input.appBinding
      || target.packageFingerprint !== input.packageFingerprint) return null
    return [`android:device:${target.deviceId}`, `android:package:${target.appBinding}`,
      `android:package_fingerprint:${target.packageFingerprint}`]
  }
  if (!exactKeys(target, ['deviceId', 'kind']) || target.kind !== 'android_device') return null
  return [`android:device:${target.deviceId}`]
}

export function validateAndroidOutputSemantics(
  capabilityId: string,
  input: FabricJsonObject,
  output: FabricJsonObject,
): boolean {
  if (!isAndroidFabricCapability(capabilityId)) return true
  if (!validateAndroidSemantics(capabilityId, input) || !plainObject(output)) return false
  if (capabilityId === ANDROID_APP_LAUNCH_CAPABILITY) {
    return output.status === 'succeeded' && output.foregroundPackage === input.appBinding
      && output.foregroundPackageFingerprint === input.packageFingerprint && canonicalTimestamp(output.observedAt)
  }
  return output.status === 'succeeded' && typeof output.captureId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(output.captureId)
    && sha256(output.digest) && ['image/png', 'image/webp'].includes(String(output.mimeType))
    && Number.isSafeInteger(output.width) && Number(output.width) >= 1 && Number(output.width) <= 16_384
    && Number.isSafeInteger(output.height) && Number(output.height) >= 1 && Number(output.height) <= 16_384
    && Number.isSafeInteger(output.byteSize) && Number(output.byteSize) >= 1 && Number(output.byteSize) <= 52_428_800
    && output.permissionGrantActive === true && canonicalTimestamp(output.capturedAt)
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function packageBinding(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(value)
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function semanticReason(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}
