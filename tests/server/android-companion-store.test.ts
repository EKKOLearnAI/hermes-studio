import { generateKeyPairSync } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AndroidCompanionIdentityConflictError,
  AndroidCompanionStore,
  AndroidCompanionValidationError,
  AndroidCompanionVersionConflictError,
  initAndroidCompanionSchema,
} from '../../packages/server/src/services/hermes/android-companion'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

describe('Android companion store', () => {
  let db: DatabaseSync
  let store: AndroidCompanionStore

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(db)
    store = new AndroidCompanionStore(db)
  })
  afterEach(() => db.close())

  it('pairs canonical public trust once and makes revocation permanent', () => {
    const first = store.pairDevice(pairing())
    expect(first).toMatchObject({ disposition: 'created', device: {
      id: deviceId, installationId: 'android-installation-1', state: 'paired', version: 1,
      signingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      exchangeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    } })
    expect(store.pairDevice(pairing()).disposition).toBe('replayed')
    const replacement = generateKeyPairSync('x25519', keyOptions)
    expect(() => store.pairDevice(pairing({ exchangePublicKey: replacement.publicKey })))
      .toThrow(AndroidCompanionIdentityConflictError)
    expect(JSON.stringify(store.listDevices())).not.toMatch(/PRIVATE KEY|pairing.?code|session.?key/i)

    const revoked = store.revokeDevice(deviceId, 1, 'USER_REVOKED')
    expect(revoked).toMatchObject({ state: 'revoked', version: 2, revocationReason: 'USER_REVOKED' })
    expect(store.revokeDevice(deviceId, 1, 'USER_REVOKED')).toEqual(revoked)
    expect(() => store.pairDevice(pairing())).toThrow(/cannot be paired again/i)
    expect(() => store.revokeDevice(deviceId, 2, 'KEY_COMPROMISED'))
      .toThrow(AndroidCompanionIdentityConflictError)
  })

  it('replaces monotonic semantic capability reports and rejects raw UI primitives', () => {
    const device = store.pairDevice(pairing()).device
    const report = capabilityReport(device.version)
    const updated = store.replaceCapabilityReport(report)
    expect(updated).toMatchObject({ disposition: 'updated', device: {
      version: 2, capabilitiesRevision: 1, capabilitiesDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    } })
    expect(updated.capabilities.map(item => item.capabilityId))
      .toEqual(['android.app.launch', 'android.screen.capture'])
    expect(store.replaceCapabilityReport(report)).toMatchObject({ disposition: 'replayed' })
    expect(() => store.replaceCapabilityReport({ ...report, capabilities: [
      { ...report.capabilities[0]!, capabilityId: 'android.raw.tap' },
    ] })).toThrow(/raw android ui primitives/i)
    expect(() => store.replaceCapabilityReport({ ...report, revision: 2, capabilities: report.capabilities }))
      .toThrow(AndroidCompanionVersionConflictError)
  })

  it('queues canonical workflow commands, replays identity, and enforces legal delivery transitions', () => {
    const device = store.pairDevice(pairing()).device
    store.replaceCapabilityReport(capabilityReport(device.version))
    const request = command()
    const first = store.queueCommand(request)
    expect(first).toMatchObject({ disposition: 'created', command: {
      id: 'command-android-launch-1', status: 'queued', version: 1, payload: {
        appBinding: 'tv.danmaku.bili', reason: 'Open the approved app',
      },
    } })
    expect(db.prepare("SELECT payload_json FROM android_companion_commands WHERE id='command-android-launch-1'").get())
      .toEqual({ payload_json: '{"appBinding":"tv.danmaku.bili","reason":"Open the approved app"}' })
    expect(store.queueCommand(request).disposition).toBe('replayed')
    expect(() => store.queueCommand({ ...request, payload: { appBinding: 'com.changed.app' } }))
      .toThrow(AndroidCompanionIdentityConflictError)
    expect(() => store.queueCommand(command({ id: 'command-sensitive-1', executionToken: 'execution-sensitive-1',
      payload: { accessToken: 'must-not-persist' } }))).toThrow(AndroidCompanionValidationError)

    let current = store.transitionCommand({
      id: first.command.id, expectedVersion: 1, status: 'delivered', deliverySequence: 1,
    })
    expect(current).toMatchObject({ status: 'delivered', version: 2, deliverySequence: 1, deliveryAttempts: 1 })
    current = store.transitionCommand({ id: current.id, expectedVersion: 2, status: 'acknowledged' })
    current = store.transitionCommand({ id: current.id, expectedVersion: 3, status: 'succeeded',
      response: { foregroundPackage: 'tv.danmaku.bili' } })
    expect(current).toMatchObject({ status: 'succeeded', version: 4, completedAt: expect.any(String) })
    expect(() => store.transitionCommand({ id: current.id, expectedVersion: 4, status: 'failed',
      errorCode: 'LATE_FAILURE' })).toThrow(AndroidCompanionValidationError)
  })

  it('binds receipts to one command and preserves result plus fresh verification', () => {
    const device = store.pairDevice(pairing()).device
    store.replaceCapabilityReport(capabilityReport(device.version))
    const queued = store.queueCommand(command()).command
    const prepared = store.prepareReceipt(receipt()).receipt
    expect(store.prepareReceipt(receipt()).disposition).toBe('replayed')

    let current = store.transitionReceipt({ workflowId: prepared.workflowId, materialDigest,
      expectedVersion: 1, status: 'executing', commandId: queued.id })
    current = store.transitionReceipt({ workflowId: current.workflowId, materialDigest,
      expectedVersion: 2, status: 'executed', commandId: queued.id,
      result: { foregroundPackage: 'tv.danmaku.bili' } })
    current = store.transitionReceipt({ workflowId: current.workflowId, materialDigest,
      expectedVersion: 3, status: 'verifying', commandId: queued.id })
    current = store.transitionReceipt({ workflowId: current.workflowId, materialDigest,
      expectedVersion: 4, status: 'verified', commandId: queued.id,
      result: { foregroundPackage: 'tv.danmaku.bili' },
      verification: { observedPackage: 'tv.danmaku.bili', fresh: true } })
    expect(current).toMatchObject({ status: 'verified', version: 5, commandId: queued.id,
      result: { foregroundPackage: 'tv.danmaku.bili' },
      verification: { observedPackage: 'tv.danmaku.bili', fresh: true }, completedAt: expect.any(String) })
    expect(() => store.transitionReceipt({ workflowId: current.workflowId, materialDigest,
      expectedVersion: 4, status: 'failed', errorCode: 'STALE' }))
      .toThrow(AndroidCompanionVersionConflictError)
    expect(() => store.prepareReceipt(receipt({ target: { appBinding: 'com.changed.app' } })))
      .toThrow(AndroidCompanionIdentityConflictError)
  })

  it('fails closed on accessors, noncanonical keys, unavailable bindings, and revoked devices', () => {
    const device = store.pairDevice(pairing()).device
    const report = capabilityReport(device.version)
    store.replaceCapabilityReport(report)
    const getter = Object.defineProperty({}, 'appBinding', { enumerable: true, get: () => 'tv.danmaku.bili' })
    expect(() => store.queueCommand(command({ id: 'command-getter-1', executionToken: 'execution-getter-1', payload: getter })))
      .toThrow(AndroidCompanionValidationError)
    expect(() => store.replaceCapabilityReport({ ...report, revision: 2, expectedDeviceVersion: 2,
      capabilities: [{ ...report.capabilities[0]!, packageBinding: 'HTTPS://example.com' }] }))
      .toThrow(AndroidCompanionValidationError)
    store.revokeDevice(deviceId, 2, 'USER_REVOKED')
    expect(() => store.queueCommand(command({ id: 'command-after-revoke', executionToken: 'execution-revoked-1' })))
      .toThrow(/unavailable/i)
  })
})

const keyOptions = {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
} as const
const signing = generateKeyPairSync('ed25519', keyOptions)
const exchange = generateKeyPairSync('x25519', keyOptions)
const deviceId = deviceIdFromPublicKey(signing.publicKey)
const materialDigest = 'a'.repeat(64)

function pairing(overrides: Record<string, unknown> = {}) {
  return {
    deviceId,
    installationId: 'android-installation-1',
    signingPublicKey: signing.publicKey,
    exchangePublicKey: exchange.publicKey,
    label: 'Xiaomi Companion',
    androidVersion: '15',
    appVersion: '1.0.0',
    pairedAt: '2026-07-15T05:00:00.000Z',
    ...overrides,
  } as any
}

function capabilityReport(expectedDeviceVersion: number) {
  return {
    deviceId,
    expectedDeviceVersion,
    revision: 1,
    reportedAt: '2026-07-15T05:01:00.000Z',
    capabilities: [
      {
        capabilityId: 'android.screen.capture', capabilityVersion: 1,
        packageBinding: 'ai.hermes.companion', packageFingerprint: 'c'.repeat(64), driverVersion: '1.0.0',
        permissions: ['android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION'],
        verificationStrategy: 'fresh encrypted capture digest', health: 'degraded', enabled: false,
      },
      {
        capabilityId: 'android.app.launch', capabilityVersion: 1,
        packageBinding: 'tv.danmaku.bili', packageFingerprint: 'b'.repeat(64), driverVersion: '1.0.0',
        permissions: ['android.permission.QUERY_ALL_PACKAGES'],
        verificationStrategy: 'fresh foreground package observation', health: 'healthy', enabled: true,
      },
    ],
  } as const
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    id: 'command-android-launch-1', workflowId: 'workflow-android-launch-1',
    executionToken: 'execution-android-launch-1', materialDigest, deviceId,
    capabilityId: 'android.app.launch', capabilityVersion: 1, kind: 'app_launch',
    payload: { reason: 'Open the approved app', appBinding: 'tv.danmaku.bili' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  } as any
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'workflow-android-launch-1', intentId: 'intent-android-launch-1', materialDigest, deviceId,
    capabilityId: 'android.app.launch', capabilityVersion: 1, target: { appBinding: 'tv.danmaku.bili' },
    ...overrides,
  } as never
}
