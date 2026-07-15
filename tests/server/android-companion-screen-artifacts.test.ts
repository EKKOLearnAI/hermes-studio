import { generateKeyPairSync } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AndroidCompanionScreenArtifactService,
  AndroidCompanionStore,
  digestAndroidCapabilityReport,
  initAndroidCompanionSchema,
  type AndroidCapabilityReportItem,
  type AndroidCompanionGatewayMessage,
} from '../../packages/server/src/services/hermes/android-companion'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

const now = new Date('2026-07-15T08:00:00.000Z')
const workflowId = 'workflow-android-screen-artifact'
const commandId = 'command-android-screen-artifact'
const executionToken = 'execution-android-screen-artifact'
const materialDigest = 'a'.repeat(64)

describe('Android screen artifact boundary', () => {
  let database: DatabaseSync
  let store: AndroidCompanionStore
  let service: AndroidCompanionScreenArtifactService

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(database)
    store = new AndroidCompanionStore(database)
    pairAndReport(store)
    const queued = store.queueCommand({
      id: commandId, workflowId, executionToken, materialDigest, deviceId,
      capabilityId: 'android.screen.capture', capabilityVersion: 1, kind: 'screen_capture',
      payload: { schemaVersion: 1, captureClass: 'workflow_evidence', reasonCode: 'WORKFLOW_EVIDENCE' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).command
    store.transitionCommand({ id: queued.id, expectedVersion: queued.version, status: 'delivered', deliverySequence: 1 })
    service = new AndroidCompanionScreenArtifactService({ store, now: () => now })
  })

  afterEach(() => database.close())

  it('hashes and discards the opaque encrypted reference while persisting bounded metadata', () => {
    const reply = service.handleMessage(captureMessage())!
    expect(reply.payload).toMatchObject({ disposition: 'created', artifactId: expect.stringMatching(/^screen-artifact-/) })
    const artifact = store.listScreenArtifacts()[0]!
    expect(artifact).toMatchObject({
      deviceId, workflowId, commandId, digest: 'b'.repeat(64), mimeType: 'image/png',
      width: 1080, height: 2400, byteSize: 12_345,
      encryptionContextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const serialized = JSON.stringify({ reply, artifact,
      row: database.prepare('SELECT * FROM android_screen_artifacts').get() })
    expect(serialized).not.toContain('R'.repeat(43))
    expect(serialized).not.toMatch(/encryptedArtifactRef|local.?path|file.?path/i)
  })

  it('replays the exact artifact and rejects reference or command substitution', () => {
    service.handleMessage(captureMessage())
    expect(service.handleMessage(captureMessage())!.payload).toMatchObject({ disposition: 'replayed' })
    expect(() => service.handleMessage(captureMessage({ encryptedArtifactRef: 'S'.repeat(43) })))
      .toThrow(/changed material/i)
    expect(() => service.handleMessage({ ...captureMessage(), bindingId: 'workflow-unrelated-screen' }))
      .toThrow(/route binding/i)
    expect(store.listScreenArtifacts()).toHaveLength(1)
  })

  it('requires a fresh active grant and exact bounded metadata', () => {
    expect(() => service.handleMessage(captureMessage({ permissionGrantActive: false })))
      .toThrow(/permission/i)
    expect(() => service.handleMessage(captureMessage({ capturedAt: '2026-07-15T07:50:00.000Z' })))
      .toThrow(/not fresh/i)
    expect(() => service.handleMessage(captureMessage({ width: 20_000 }))).toThrow(/width/i)
    expect(() => service.handleMessage(captureMessage({ commandId: 'command-unrelated-screen' })))
      .toThrow(/command binding/i)
    expect(store.listScreenArtifacts()).toEqual([])
  })
})

function captureMessage(overrides: Record<string, unknown> = {}): AndroidCompanionGatewayMessage {
  return {
    deviceId,
    sessionId: 'session-screen-artifact',
    messageType: 'screen.capture.result',
    bindingId: workflowId,
    sequence: 2,
    receivedAt: now.toISOString(),
    payload: {
      commandId,
      workflowId,
      executionToken,
      materialDigest,
      captureId: 'capture-screen-artifact-1',
      digest: 'b'.repeat(64),
      mimeType: 'image/png',
      width: 1080,
      height: 2400,
      byteSize: 12_345,
      permissionGrantActive: true,
      capturedAt: '2026-07-15T07:59:30.000Z',
      encryptedArtifactRef: 'R'.repeat(43),
      ...overrides,
    },
  }
}

const keyOptions = {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
} as const
const signing = generateKeyPairSync('ed25519', keyOptions)
const exchange = generateKeyPairSync('x25519', keyOptions)
const deviceId = deviceIdFromPublicKey(signing.publicKey)

function pairAndReport(store: AndroidCompanionStore): void {
  const capabilities = capabilityItems()
  const device = store.pairDevice({
    deviceId,
    installationId: 'android-screen-artifact-installation',
    signingPublicKey: signing.publicKey,
    exchangePublicKey: exchange.publicKey,
    label: 'Screen Companion',
    androidVersion: '15',
    appVersion: '1.0.0',
    initialCapabilitiesDigest: digestAndroidCapabilityReport(capabilities),
    pairedAt: '2026-07-15T07:00:00.000Z',
  }).device
  store.replaceCapabilityReport({
    deviceId,
    expectedDeviceVersion: device.version,
    revision: 1,
    capabilities,
    reportedAt: '2026-07-15T07:01:00.000Z',
  })
}

function capabilityItems(): AndroidCapabilityReportItem[] {
  return [
    {
      capabilityId: 'android.app.launch', capabilityVersion: 1, packageBinding: 'ai.hermes.companion',
      packageFingerprint: 'c'.repeat(64), driverVersion: '1.0.0',
      permissions: ['android.permission.PACKAGE_USAGE_STATS'],
      verificationStrategy: 'fresh_foreground_package_and_signature', health: 'healthy', enabled: true,
    },
    {
      capabilityId: 'android.screen.capture', capabilityVersion: 1, packageBinding: 'ai.hermes.companion',
      packageFingerprint: 'c'.repeat(64), driverVersion: '1.0.0',
      permissions: ['android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION'],
      verificationStrategy: 'fresh_capture_digest_dimensions_and_grant', health: 'healthy', enabled: true,
    },
  ]
}
