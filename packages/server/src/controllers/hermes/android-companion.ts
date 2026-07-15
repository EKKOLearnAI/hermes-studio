import { isProxy } from 'node:util/types'
import type { Context } from 'koa'
import { getFabricControlState } from '../../services/hermes/action-fabric'
import {
  ANDROID_COMMAND_STATUSES,
  ANDROID_RECEIPT_STATUSES,
  ANDROID_TAKEOVER_STATUSES,
  AndroidCompanionAuthenticationError,
  AndroidCompanionIdentityConflictError,
  AndroidCompanionNotFoundError,
  AndroidCompanionReplayError,
  AndroidCompanionValidationError,
  AndroidCompanionVersionConflictError,
  getAndroidCompanionRuntime,
  type AndroidCompanionCapability,
  type AndroidCompanionCommand,
  type AndroidCompanionDevice,
  type AndroidExecutionReceipt,
  type AndroidNotificationObservation,
  type AndroidScreenArtifact,
  type AndroidTakeover,
  type SignedAndroidPairingTranscript,
} from '../../services/hermes/android-companion'

class AndroidApiRequestError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const MAX_BODY_BYTES = 64 * 1024

/** @openapi-default-errors 400:AndroidApiError,401:AuthError,403:AndroidApiError,404:AndroidApiError,409:AndroidApiError,500:AndroidApiError,503:AndroidApiError */

/** @openapi-response AndroidOverviewResponse */
export async function overview(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    noQuery(ctx)
    const runtime = getAndroidCompanionRuntime()
    runtime.store.expireTakeovers()
    const devices = runtime.store.listDevices(100)
    const capabilities = devices.flatMap(device => runtime.store.listCapabilities(device.id))
    const commands = runtime.store.listCommands({ limit: 200 })
    const receipts = runtime.store.listReceipts({ limit: 200 })
    const notifications = runtime.store.listNotifications({ limit: 200 })
    const artifacts = runtime.store.listScreenArtifacts({ limit: 200 })
    const takeovers = runtime.store.listTakeovers({ limit: 200 })
    const connections = new Set(runtime.gateway.listConnections().map(item => item.deviceId))
    const control = getFabricControlState()
    return {
      devices: devices.map(device => publicDevice(device, connections.has(device.id))),
      capabilities: capabilities.map(publicCapability),
      summary: {
        pairedDeviceCount: devices.filter(device => device.state === 'paired').length,
        connectedDeviceCount: connections.size,
        healthyCapabilityCount: capabilities.filter(item => item.enabled && item.health === 'healthy').length,
        activeCommandCount: commands.filter(item => !['succeeded', 'failed', 'cancelled'].includes(item.status)).length,
        verifiedReceiptCount: receipts.filter(item => item.status === 'verified').length,
        notificationCount: notifications.length,
        artifactCount: artifacts.length,
        pendingTakeoverCount: takeovers.filter(item => ['requested', 'claimed'].includes(item.status)).length,
      },
      emergencyStop: { level: control.level, version: control.version },
    }
  })
}

/** @openapi-response AndroidPairingOfferResponse */
export async function issuePairingOffer(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    emptyBody(ctx)
    const offer = await getAndroidCompanionRuntime().pairing.issue()
    ctx.status = 201
    return {
      offer: {
        challengeId: offer.challenge.challengeId,
        nonce: offer.challenge.nonce,
        code: offer.challenge.code,
        studioDeviceId: offer.challenge.studioDeviceId,
        expiresAt: offer.challenge.expiresAt,
        studio: { ...offer.studio },
      },
    }
  })
}

/** @openapi-response AndroidPairingRevocationResponse */
export async function revokePairingOffer(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    noQuery(ctx)
    emptyBody(ctx)
    const challengeId = pathId(ctx, 'challengeId')
    return { challengeId, revoked: getAndroidCompanionRuntime().pairing.revokeOffer(challengeId) }
  })
}

/** @openapi-response AndroidPairingCompletionResponse */
export async function completePairing(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['challengeId', 'code', 'signedTranscript', 'approved']))
    if (body.approved !== true || !plain(body.signedTranscript)) throw new AndroidApiRequestError('Invalid approval')
    const result = await getAndroidCompanionRuntime().pairing.complete({
      challengeId: requiredId(body.challengeId),
      code: requiredString(body.code, 128),
      signedTranscript: body.signedTranscript as unknown as SignedAndroidPairingTranscript,
      approvedByUser: true,
    })
    ctx.status = result.disposition === 'created' ? 201 : 200
    return { disposition: result.disposition, device: publicDevice(result.device, false) }
  })
}

/** @openapi-response AndroidDeviceListResponse */
export async function devices(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    queryKeys(ctx, new Set(['limit']))
    const runtime = getAndroidCompanionRuntime()
    const connections = new Set(runtime.gateway.listConnections().map(item => item.deviceId))
    return { devices: runtime.store.listDevices(queryLimit(ctx, 100))
      .map(device => publicDevice(device, connections.has(device.id))) }
  })
}

/** @openapi-response AndroidDeviceResponse */
export async function revokeDevice(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['expectedVersion', 'reason']))
    const runtime = getAndroidCompanionRuntime()
    const device = runtime.store.revokeDevice(pathId(ctx, 'deviceId'),
      requiredInteger(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER), requiredErrorCode(body.reason))
    runtime.capabilities.disableDevice(device.id)
    runtime.gateway.disconnectDevice(device.id)
    return { device: publicDevice(device, false) }
  })
}

/** @openapi-response AndroidCapabilityListResponse */
export async function capabilities(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    queryKeys(ctx, new Set(['deviceId']))
    const deviceId = optionalQueryId(ctx, 'deviceId')
    const store = getAndroidCompanionRuntime().store
    const values = deviceId ? store.listCapabilities(deviceId)
      : store.listDevices(100).flatMap(device => store.listCapabilities(device.id))
    return { capabilities: values.map(publicCapability) }
  })
}

/** @openapi-response AndroidCommandListResponse */
export async function commands(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    queryKeys(ctx, new Set(['deviceId', 'workflowId', 'status', 'limit']))
    const deviceId = optionalQueryId(ctx, 'deviceId')
    const workflowId = optionalQueryId(ctx, 'workflowId')
    const status = queryEnum(ctx, 'status', ANDROID_COMMAND_STATUSES)
    return { commands: getAndroidCompanionRuntime().store.listCommands({
      ...(deviceId ? { deviceId } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(status ? { status } : {}),
      limit: queryLimit(ctx, 100),
    }).map(publicCommand) }
  })
}

/** @openapi-response AndroidReceiptListResponse */
export async function receipts(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    queryKeys(ctx, new Set(['deviceId', 'status', 'limit']))
    const store = getAndroidCompanionRuntime().store
    const deviceId = optionalQueryId(ctx, 'deviceId')
    const status = queryEnum(ctx, 'status', ANDROID_RECEIPT_STATUSES)
    return { receipts: store.listReceipts({ ...(deviceId ? { deviceId } : {}), ...(status ? { status } : {}),
      limit: queryLimit(ctx, 100) }).map(receipt => publicReceipt(store, receipt)) }
  })
}

/** @openapi-response AndroidNotificationListResponse */
export async function notifications(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    queryKeys(ctx, new Set(['deviceId', 'limit']))
    const deviceId = optionalQueryId(ctx, 'deviceId')
    return { notifications: getAndroidCompanionRuntime().store.listNotifications({
      ...(deviceId ? { deviceId } : {}), limit: queryLimit(ctx, 100),
    }).map(publicNotification) }
  })
}

/** @openapi-response AndroidArtifactListResponse */
export async function artifacts(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    queryKeys(ctx, new Set(['workflowId', 'limit']))
    const workflowId = optionalQueryId(ctx, 'workflowId')
    return { artifacts: getAndroidCompanionRuntime().store.listScreenArtifacts({
      ...(workflowId ? { workflowId } : {}), limit: queryLimit(ctx, 100),
    }).map(publicArtifact) }
  })
}

/** @openapi-response AndroidTakeoverListResponse */
export async function takeovers(ctx: Context): Promise<void> {
  await respond(ctx, () => {
    queryKeys(ctx, new Set(['workflowId', 'status', 'limit']))
    const store = getAndroidCompanionRuntime().store
    store.expireTakeovers()
    const workflowId = optionalQueryId(ctx, 'workflowId')
    const status = queryEnum(ctx, 'status', ANDROID_TAKEOVER_STATUSES)
    return { takeovers: store.listTakeovers({ ...(workflowId ? { workflowId } : {}),
      ...(status ? { status } : {}), limit: queryLimit(ctx, 100) }).map(publicTakeover) }
  })
}

function publicDevice(device: AndroidCompanionDevice, connected: boolean) {
  return {
    id: device.id,
    label: device.label,
    androidVersion: device.androidVersion,
    appVersion: device.appVersion,
    state: device.state,
    connected,
    signingFingerprint: device.signingFingerprint,
    exchangeFingerprint: device.exchangeFingerprint,
    capabilitiesRevision: device.capabilitiesRevision,
    version: device.version,
    pairedAt: device.pairedAt,
    revokedAt: device.revokedAt,
    revocationReason: device.revocationReason,
    lastSeenAt: device.lastSeenAt,
    updatedAt: device.updatedAt,
  }
}

function publicCapability(value: AndroidCompanionCapability) {
  return {
    deviceId: value.deviceId,
    capabilityId: value.capabilityId,
    capabilityVersion: value.capabilityVersion,
    packageBinding: value.packageBinding,
    packageFingerprint: value.packageFingerprint,
    driverVersion: value.driverVersion,
    permissions: [...value.permissions],
    verificationStrategy: value.verificationStrategy,
    health: value.health,
    enabled: value.enabled,
    reportRevision: value.reportRevision,
    updatedAt: value.updatedAt,
  }
}

function publicCommand(value: AndroidCompanionCommand) {
  return {
    id: value.id,
    workflowId: value.workflowId,
    deviceId: value.deviceId,
    capabilityId: value.capabilityId,
    capabilityVersion: value.capabilityVersion,
    kind: value.kind,
    status: value.status,
    deliveryAttempts: value.deliveryAttempts,
    errorCode: value.errorCode,
    version: value.version,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  }
}

function publicReceipt(store: ReturnType<typeof getAndroidCompanionRuntime>['store'], value: AndroidExecutionReceipt) {
  const command = value.commandId ? store.getCommand(value.commandId) : null
  return {
    workflowId: value.workflowId,
    intentId: value.intentId,
    deviceId: value.deviceId,
    capabilityId: value.capabilityId,
    capabilityVersion: value.capabilityVersion,
    status: value.status,
    commandId: value.commandId,
    result: publicResult(value, command),
    errorCode: value.errorCode,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  }
}

function publicResult(receipt: AndroidExecutionReceipt, command: AndroidCompanionCommand | null): Record<string, unknown> | null {
  if (!receipt.result || !command || command.id !== receipt.commandId || command.response === null) return null
  const result = receipt.result
  if (receipt.capabilityId === 'android.app.launch'
    && result.status === 'succeeded' && typeof result.foregroundPackage === 'string'
    && typeof result.observedAt === 'string') {
    return { status: 'succeeded', foregroundPackage: result.foregroundPackage, observedAt: result.observedAt }
  }
  if (receipt.capabilityId === 'android.screen.capture' && result.status === 'succeeded'
    && typeof result.captureId === 'string' && typeof result.digest === 'string') {
    return {
      status: 'succeeded', captureId: result.captureId, digest: result.digest, mimeType: result.mimeType,
      width: result.width, height: result.height, byteSize: result.byteSize, capturedAt: result.capturedAt,
    }
  }
  return null
}

function publicNotification(value: AndroidNotificationObservation) {
  return {
    id: value.id,
    deviceId: value.deviceId,
    packageBinding: value.packageBinding,
    category: value.category,
    titleSummary: value.titleSummary,
    textSummary: value.textSummary,
    sensitivity: value.sensitivity,
    postedAt: value.postedAt,
    removedAt: value.removedAt,
    updatedAt: value.updatedAt,
  }
}

function publicArtifact(value: AndroidScreenArtifact) {
  return {
    id: value.id,
    deviceId: value.deviceId,
    workflowId: value.workflowId,
    commandId: value.commandId,
    digest: value.digest,
    mimeType: value.mimeType,
    width: value.width,
    height: value.height,
    byteSize: value.byteSize,
    capturedAt: value.capturedAt,
    createdAt: value.createdAt,
  }
}

function publicTakeover(value: AndroidTakeover) {
  return {
    id: value.id,
    workflowId: value.workflowId,
    commandId: value.commandId,
    deviceId: value.deviceId,
    capabilityId: value.capabilityId,
    reasonCode: value.reasonCode,
    generation: value.generation,
    status: value.status,
    version: value.version,
    requestedAt: value.requestedAt,
    claimedAt: value.claimedAt,
    completedAt: value.completedAt,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
  }
}

async function respond(ctx: Context, operation: () => unknown | Promise<unknown>): Promise<void> {
  try { ctx.body = await operation() } catch (error) { mapError(ctx, error) }
}

function mapError(ctx: Context, error: unknown): void {
  if (error instanceof AndroidApiRequestError || error instanceof AndroidCompanionValidationError
    || error instanceof AndroidCompanionReplayError) {
    ctx.status = 400; ctx.body = { error: 'Invalid Android companion request', code: 'ANDROID_REQUEST_INVALID' }; return
  }
  if (error instanceof AndroidCompanionAuthenticationError) {
    ctx.status = 403; ctx.body = { error: 'Android companion authorization failed', code: 'ANDROID_AUTHORIZATION_FAILED' }; return
  }
  if (error instanceof AndroidCompanionNotFoundError) {
    ctx.status = 404; ctx.body = { error: 'Android companion record not found', code: 'ANDROID_RECORD_NOT_FOUND' }; return
  }
  if (error instanceof AndroidCompanionIdentityConflictError || error instanceof AndroidCompanionVersionConflictError) {
    ctx.status = 409; ctx.body = { error: 'Android companion state conflict', code: 'ANDROID_STATE_CONFLICT' }; return
  }
  ctx.status = 503
  ctx.body = { error: 'Android companion operation failed', code: 'ANDROID_OPERATION_FAILED' }
}

function exactBody(ctx: Context, allowed: ReadonlySet<string>): Record<string, unknown> {
  const request = ctx.request as { body?: unknown; type?: string }
  if (request.type !== undefined && request.type !== 'application/json') throw new AndroidApiRequestError('JSON required')
  assertPlainJson(request.body)
  if (!plain(request.body) || Buffer.byteLength(JSON.stringify(request.body), 'utf8') > MAX_BODY_BYTES
    || Object.keys(request.body).some(key => !allowed.has(key))) throw new AndroidApiRequestError('Invalid JSON body')
  return request.body
}

function emptyBody(ctx: Context): void {
  const request = ctx.request as { body?: unknown }
  if (request.body !== undefined && request.body !== null
    && (!plain(request.body) || Object.keys(request.body).length !== 0)) throw new AndroidApiRequestError('Body must be empty')
}

function assertPlainJson(value: unknown, depth = 0, counter = { value: 0 }): void {
  counter.value += 1
  if (counter.value > 256 || depth > 8) throw new AndroidApiRequestError('JSON body is too complex')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (value.length > 8_192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new AndroidApiRequestError('Invalid string')
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AndroidApiRequestError('Invalid number')
    return
  }
  if (!plain(value)) throw new AndroidApiRequestError('Invalid JSON value')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new AndroidApiRequestError('Invalid JSON key')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new AndroidApiRequestError('Invalid JSON property')
    assertPlainJson(descriptor.value, depth + 1, counter)
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new AndroidApiRequestError('Invalid identifier')
  return value
}

function requiredString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw new AndroidApiRequestError('Invalid string')
  return value
}

function requiredInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new AndroidApiRequestError('Invalid integer')
  }
  return Number(value)
}

function requiredErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !ERROR_CODE.test(value)) throw new AndroidApiRequestError('Invalid reason')
  return value
}

function pathId(ctx: Context, key: string): string {
  let value = String(ctx.params[key] ?? '')
  try { value = decodeURIComponent(value) } catch { throw new AndroidApiRequestError('Invalid path identifier') }
  return requiredId(value)
}

function noQuery(ctx: Context): void { queryKeys(ctx, new Set()) }

function queryKeys(ctx: Context, allowed: ReadonlySet<string>): void {
  if (!plain(ctx.query) || Object.keys(ctx.query).some(key => !allowed.has(key))) throw new AndroidApiRequestError('Invalid query')
  for (const value of Object.values(ctx.query)) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 200) throw new AndroidApiRequestError('Invalid query')
  }
}

function optionalQueryId(ctx: Context, key: string): string | undefined {
  const value = ctx.query[key]
  return value === undefined ? undefined : requiredId(value)
}

function queryLimit(ctx: Context, fallback: number): number {
  const value = ctx.query.limit
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value)) throw new AndroidApiRequestError('Invalid limit')
  return Math.min(Number(value), 200)
}

function queryEnum<T extends string>(ctx: Context, key: string, values: readonly T[]): T | undefined {
  const value = ctx.query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !values.includes(value as T)) throw new AndroidApiRequestError('Invalid enum')
  return value as T
}
