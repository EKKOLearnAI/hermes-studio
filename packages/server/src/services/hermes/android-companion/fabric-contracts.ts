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
      capturedAt: { type: 'string', format: 'date-time', maxLength: 64 },
    }, ['schemaVersion', 'status', 'captureId', 'digest', 'mimeType', 'width', 'height', 'byteSize', 'capturedAt']),
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

export function isAndroidFabricCapability(capabilityId: string): boolean {
  return capabilityId === ANDROID_APP_LAUNCH_CAPABILITY || capabilityId === ANDROID_SCREEN_CAPTURE_CAPABILITY
}
