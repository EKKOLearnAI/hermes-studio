import type { FabricJsonObject } from '../action-fabric'

export const ANDROID_COMPANION_PROTOCOL_VERSION = 1 as const
export const ANDROID_DEVICE_STATES = ['paired', 'revoked'] as const
export const ANDROID_CAPABILITY_HEALTH = ['healthy', 'degraded', 'unavailable'] as const
export const ANDROID_COMMAND_KINDS = ['app_launch', 'screen_capture', 'foreground_verify', 'cancel'] as const
export const ANDROID_COMMAND_STATUSES = [
  'queued', 'delivered', 'acknowledged', 'succeeded', 'failed', 'unknown', 'waiting_user', 'cancelled',
] as const
export const ANDROID_RECEIPT_STATUSES = [
  'prepared', 'executing', 'executed', 'verifying', 'verified', 'unknown', 'mismatch', 'failed', 'waiting_user',
] as const
export const ANDROID_NOTIFICATION_SENSITIVITY = ['metadata', 'minimized', 'standard'] as const
export const ANDROID_TAKEOVER_STATUSES = ['requested', 'claimed', 'completed', 'expired', 'cancelled'] as const

export type AndroidDeviceState = typeof ANDROID_DEVICE_STATES[number]
export type AndroidCapabilityHealth = typeof ANDROID_CAPABILITY_HEALTH[number]
export type AndroidCommandKind = typeof ANDROID_COMMAND_KINDS[number]
export type AndroidCommandStatus = typeof ANDROID_COMMAND_STATUSES[number]
export type AndroidReceiptStatus = typeof ANDROID_RECEIPT_STATUSES[number]
export type AndroidNotificationSensitivity = typeof ANDROID_NOTIFICATION_SENSITIVITY[number]
export type AndroidTakeoverStatus = typeof ANDROID_TAKEOVER_STATUSES[number]

export interface AndroidCompanionDevice {
  id: string
  installationId: string
  signingPublicKey: string
  exchangePublicKey: string
  signingFingerprint: string
  exchangeFingerprint: string
  label: string
  androidVersion: string
  appVersion: string
  state: AndroidDeviceState
  capabilitiesRevision: number
  capabilitiesDigest: string | null
  lastReceivedSequence: number
  lastSentSequence: number
  version: number
  pairedAt: string
  revokedAt: string | null
  revocationReason: string | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AndroidCapabilityReportItem {
  capabilityId: string
  capabilityVersion: number
  packageBinding: string
  packageFingerprint: string
  driverVersion: string
  permissions: string[]
  verificationStrategy: string
  health: AndroidCapabilityHealth
  enabled: boolean
}

export interface AndroidCompanionCapability extends AndroidCapabilityReportItem {
  deviceId: string
  reportRevision: number
  createdAt: string
  updatedAt: string
}

export interface AndroidCompanionCommand {
  id: string
  workflowId: string
  executionToken: string
  materialDigest: string
  deviceId: string
  capabilityId: string
  capabilityVersion: number
  kind: AndroidCommandKind
  payload: FabricJsonObject
  status: AndroidCommandStatus
  deliverySequence: number | null
  deliveryAttempts: number
  response: FabricJsonObject | null
  errorCode: string | null
  version: number
  expiresAt: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface AndroidExecutionReceipt {
  workflowId: string
  intentId: string
  materialDigest: string
  deviceId: string
  capabilityId: string
  capabilityVersion: number
  target: FabricJsonObject
  status: AndroidReceiptStatus
  commandId: string | null
  result: FabricJsonObject | null
  verification: FabricJsonObject | null
  errorCode: string | null
  version: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface AndroidNotificationObservation {
  id: string
  deviceId: string
  packageBinding: string
  notificationKeyHash: string
  category: string
  channelHash: string | null
  titleSummary: string
  textSummary: string
  sensitivity: AndroidNotificationSensitivity
  sourceSequence: number
  provenanceDigest: string
  postedAt: string
  removedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface AndroidScreenArtifact {
  id: string
  deviceId: string
  workflowId: string
  commandId: string
  digest: string
  mimeType: 'image/png' | 'image/webp'
  width: number
  height: number
  byteSize: number
  encryptionContextDigest: string
  capturedAt: string
  createdAt: string
}

export interface AndroidTakeover {
  id: string
  workflowId: string
  commandId: string
  deviceId: string
  capabilityId: string
  reasonCode: string
  generation: number
  status: AndroidTakeoverStatus
  claimDigest: string | null
  version: number
  requestedAt: string
  claimedAt: string | null
  completedAt: string | null
  expiresAt: string
  updatedAt: string
}

export class AndroidCompanionValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'AndroidCompanionValidationError' }
}

export class AndroidCompanionNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'AndroidCompanionNotFoundError' }
}

export class AndroidCompanionIdentityConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'AndroidCompanionIdentityConflictError' }
}

export class AndroidCompanionVersionConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'AndroidCompanionVersionConflictError' }
}
