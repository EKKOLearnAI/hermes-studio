import { request } from '@/api/client'

export type AndroidDeviceState = 'paired' | 'revoked'
export type AndroidCapabilityId = 'android.app.launch' | 'android.screen.capture'
export type AndroidCapabilityHealth = 'healthy' | 'degraded' | 'unavailable'
export type AndroidCommandStatus = 'queued' | 'delivered' | 'acknowledged' | 'succeeded' | 'failed'
  | 'unknown' | 'waiting_user' | 'cancelled'
export type AndroidReceiptStatus = 'prepared' | 'executing' | 'executed' | 'verifying' | 'verified'
  | 'unknown' | 'mismatch' | 'failed' | 'waiting_user'
export type AndroidTakeoverStatus = 'requested' | 'claimed' | 'completed' | 'expired' | 'cancelled'

export interface AndroidDeviceDto {
  id: string; label: string; androidVersion: string; appVersion: string; state: AndroidDeviceState
  connected: boolean; signingFingerprint: string; exchangeFingerprint: string; capabilitiesRevision: number
  version: number; pairedAt: string; revokedAt: string | null; revocationReason: string | null
  lastSeenAt: string | null; updatedAt: string
}
export interface AndroidCapabilityDto {
  deviceId: string; capabilityId: AndroidCapabilityId; capabilityVersion: number; packageBinding: string
  packageFingerprint: string; driverVersion: string; permissions: string[]; verificationStrategy: string
  health: AndroidCapabilityHealth; enabled: boolean; reportRevision: number; updatedAt: string
}
export interface AndroidOverviewDto {
  devices: AndroidDeviceDto[]; capabilities: AndroidCapabilityDto[]
  summary: {
    pairedDeviceCount: number; connectedDeviceCount: number; healthyCapabilityCount: number
    activeCommandCount: number; verifiedReceiptCount: number; notificationCount: number
    artifactCount: number; pendingTakeoverCount: number
  }
  emergencyStop: { level: number; version: number }
}
export interface AndroidCommandDto {
  id: string; workflowId: string; deviceId: string; capabilityId: AndroidCapabilityId
  capabilityVersion: number; kind: 'app_launch' | 'screen_capture' | 'foreground_verify' | 'cancel'
  status: AndroidCommandStatus; deliveryAttempts: number; errorCode: string | null; version: number
  expiresAt: string; createdAt: string; updatedAt: string; completedAt: string | null
}
export type AndroidExecutionResultDto = {
  status: 'succeeded'; foregroundPackage: string; observedAt: string
} | {
  status: 'succeeded'; captureId: string; digest: string; mimeType: 'image/png' | 'image/webp'
  width: number; height: number; byteSize: number; capturedAt: string
}
export interface AndroidReceiptDto {
  workflowId: string; intentId: string; deviceId: string; capabilityId: AndroidCapabilityId
  capabilityVersion: number; status: AndroidReceiptStatus; commandId: string | null
  result: AndroidExecutionResultDto | null; errorCode: string | null; version: number
  createdAt: string; updatedAt: string; completedAt: string | null
}
export interface AndroidNotificationDto {
  id: string; deviceId: string; packageBinding: string; category: string; titleSummary: string
  textSummary: string; sensitivity: 'metadata' | 'minimized' | 'standard'; postedAt: string
  removedAt: string | null; updatedAt: string
}
export interface AndroidArtifactDto {
  id: string; deviceId: string; workflowId: string; commandId: string; digest: string
  mimeType: 'image/png' | 'image/webp'; width: number; height: number; byteSize: number
  capturedAt: string; createdAt: string
}
export interface AndroidTakeoverDto {
  id: string; workflowId: string; commandId: string; deviceId: string; capabilityId: AndroidCapabilityId
  reasonCode: string; generation: number; status: AndroidTakeoverStatus; version: number
  requestedAt: string; claimedAt: string | null; completedAt: string | null; expiresAt: string; updatedAt: string
}
export interface AndroidPublicIdentityDto {
  deviceId: string; signingPublicKey: string; exchangePublicKey: string
}
export interface AndroidPairingOfferDto {
  challengeId: string; nonce: string; code: string; studioDeviceId: string; expiresAt: string
  studio: AndroidPublicIdentityDto
}
export interface SignedAndroidPairingTranscriptDto {
  transcript: {
    protocolVersion: 1; challengeId: string; challengeNonce: string; expiresAt: string
    studio: AndroidPublicIdentityDto
    companion: AndroidPublicIdentityDto & {
      installationId: string; label: string; androidVersion: string; appVersion: string
    }
    initialCapabilitiesDigest: string
  }
  companionSignature: string
}

type ListQuery = { limit?: number }
export type AndroidCommandQuery = ListQuery & { deviceId?: string; workflowId?: string; status?: AndroidCommandStatus }
export type AndroidReceiptQuery = ListQuery & { deviceId?: string; status?: AndroidReceiptStatus }
export type AndroidNotificationQuery = ListQuery & { deviceId?: string }
export type AndroidArtifactQuery = ListQuery & { workflowId?: string }
export type AndroidTakeoverQuery = ListQuery & { workflowId?: string; status?: AndroidTakeoverStatus }

const BASE = '/api/hermes/android-companion'
const id = (value: string) => encodeURIComponent(value)
const json = (method: 'POST' | 'DELETE', body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
function withQuery(path: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}
async function list<T>(path: string, query: Record<string, unknown>, key: string): Promise<T[]> {
  return (await request<Record<string, T[]>>(withQuery(path, query)))[key] ?? []
}

export function fetchAndroidOverview(): Promise<AndroidOverviewDto> { return request(`${BASE}/overview`) }
export async function issueAndroidPairingOffer(): Promise<AndroidPairingOfferDto> {
  return (await request<{ offer: AndroidPairingOfferDto }>(`${BASE}/pairing/offers`, json('POST', {}))).offer
}
export function revokeAndroidPairingOffer(challengeId: string): Promise<{ challengeId: string; revoked: boolean }> {
  return request(`${BASE}/pairing/offers/${id(challengeId)}`, json('DELETE'))
}
export function completeAndroidPairing(input: {
  challengeId: string; code: string; signedTranscript: SignedAndroidPairingTranscriptDto; approved: true
}): Promise<{ disposition: 'created' | 'replayed'; device: AndroidDeviceDto }> {
  return request(`${BASE}/pairing/complete`, json('POST', input))
}
export function fetchAndroidDevices(query: ListQuery = {}): Promise<AndroidDeviceDto[]> {
  return list(`${BASE}/devices`, query, 'devices')
}
export function revokeAndroidDevice(deviceId: string, expectedVersion: number, reason: string): Promise<AndroidDeviceDto> {
  return request<{ device: AndroidDeviceDto }>(`${BASE}/devices/${id(deviceId)}/revoke`,
    json('POST', { expectedVersion, reason })).then(value => value.device)
}
export function fetchAndroidCapabilities(deviceId?: string): Promise<AndroidCapabilityDto[]> {
  return list(`${BASE}/capabilities`, { deviceId }, 'capabilities')
}
export function fetchAndroidCommands(query: AndroidCommandQuery = {}): Promise<AndroidCommandDto[]> {
  return list(`${BASE}/commands`, query, 'commands')
}
export function fetchAndroidReceipts(query: AndroidReceiptQuery = {}): Promise<AndroidReceiptDto[]> {
  return list(`${BASE}/receipts`, query, 'receipts')
}
export function fetchAndroidNotifications(query: AndroidNotificationQuery = {}): Promise<AndroidNotificationDto[]> {
  return list(`${BASE}/notifications`, query, 'notifications')
}
export function fetchAndroidArtifacts(query: AndroidArtifactQuery = {}): Promise<AndroidArtifactDto[]> {
  return list(`${BASE}/artifacts`, query, 'artifacts')
}
export function fetchAndroidTakeovers(query: AndroidTakeoverQuery = {}): Promise<AndroidTakeoverDto[]> {
  return list(`${BASE}/takeovers`, query, 'takeovers')
}
