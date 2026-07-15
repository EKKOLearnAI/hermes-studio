import { generateKeyPairSync } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ANDROID_APP_LAUNCH_CAPABILITY,
  ANDROID_APP_LAUNCH_PERMISSIONS,
  ANDROID_APP_LAUNCH_VERIFICATION,
  ANDROID_COMPANION_PACKAGE,
  ANDROID_SCREEN_CAPTURE_CAPABILITY,
  ANDROID_SCREEN_CAPTURE_PERMISSIONS,
  ANDROID_SCREEN_CAPTURE_VERIFICATION,
  AndroidCompanionCapabilityService,
  AndroidCompanionIdentityConflictError,
  AndroidCompanionStore,
  AndroidCompanionValidationError,
  digestAndroidCapabilityReport,
  initAndroidCompanionSchema,
  type AndroidCapabilityReportItem,
} from '../../packages/server/src/services/hermes/android-companion'
import {
  getFabricControlState,
  listFabricCapabilities,
  listFabricExecutors,
  resolveFabricExecutor,
  setFabricEmergencyStop,
} from '../../packages/server/src/services/hermes/action-fabric'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

const now = new Date('2026-07-15T06:00:00.000Z')

describe('Android semantic capability reconciliation', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''
  let database: DatabaseSync
  let store: AndroidCompanionStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-android-capabilities-'))
    process.env.HERMES_HOME = home
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(database)
    store = new AndroidCompanionStore(database)
  })

  afterEach(() => {
    database.close()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('registers only exact allowlisted semantic bindings and keeps degraded capabilities unavailable', () => {
    const device = pair(reportItems())
    const service = new AndroidCompanionCapabilityService({ store, now: () => now })
    const result = service.applyReport(device.id, 'capabilities.report', report(1))
    expect(result).toMatchObject({ disposition: 'updated', device: {
      capabilitiesRevision: 1, version: 2,
    }, executors: [
      { capabilityId: ANDROID_APP_LAUNCH_CAPABILITY, enabled: true, health: 'healthy' },
      { capabilityId: ANDROID_SCREEN_CAPTURE_CAPABILITY, enabled: false, health: 'degraded' },
    ] })
    expect(listFabricCapabilities().filter(item => item.id.startsWith('android.')).map(item => ({
      id: item.id, version: item.version, risk: item.risk, verification: item.verificationStrategy,
    }))).toEqual([
      { id: ANDROID_APP_LAUNCH_CAPABILITY, version: 1, risk: 'low',
        verification: ANDROID_APP_LAUNCH_VERIFICATION },
      { id: ANDROID_SCREEN_CAPTURE_CAPABILITY, version: 1, risk: 'medium',
        verification: ANDROID_SCREEN_CAPTURE_VERIFICATION },
    ])
    const executors = listFabricExecutors().filter(item => item.type === 'android')
    expect(executors).toHaveLength(2)
    expect(executors[0]?.configuration).toMatchObject({
      externalWrite: true, interruptible: true, managedAvailability: true,
      deviceId: device.id, packageBinding: ANDROID_COMPANION_PACKAGE,
    })
    expect(resolveFabricExecutor(ANDROID_APP_LAUNCH_CAPABILITY, { environments: ['production'] })?.executor.type)
      .toBe('android')
    expect(resolveFabricExecutor(ANDROID_SCREEN_CAPTURE_CAPABILITY, { environments: ['production'] })).toBeNull()
    const beforeReplay = listFabricExecutors().filter(item => item.type === 'android')
    expect(service.applyReport(device.id, 'capabilities.report', report(1)).disposition).toBe('replayed')
    expect(listFabricExecutors().filter(item => item.type === 'android')).toEqual(beforeReplay)
  })

  it('rejects unknown capabilities, package drift, permission expansion, and stale reports before persistence', () => {
    const device = pair(reportItems())
    const service = new AndroidCompanionCapabilityService({ store, now: () => now })
    const cases: AndroidCapabilityReportItem[][] = [
      reportItems().map((item, index) => index === 0 ? { ...item, capabilityId: 'android.raw.tap' } : item),
      reportItems().map((item, index) => index === 0 ? { ...item, packageBinding: 'com.attacker.driver' } : item),
      reportItems().map((item, index) => index === 0
        ? { ...item, permissions: [...item.permissions, 'android.permission.READ_SMS'] } : item),
    ]
    for (const capabilities of cases) {
      expect(() => service.applyReport(device.id, 'capabilities.report', {
        revision: 1, reportedAt: now.toISOString(), capabilities,
      })).toThrow(AndroidCompanionValidationError)
    }
    expect(() => service.applyReport(device.id, 'capabilities.report', {
      ...report(1), reportedAt: new Date(now.getTime() - 300_001).toISOString(),
    })).toThrow(/stale/i)
    expect(store.getDevice(device.id)).toMatchObject({ capabilitiesRevision: 0, version: 1 })
    expect(listFabricExecutors().filter(item => item.type === 'android')).toEqual([])
  })

  it('binds the first report to the locally approved enrollment digest', () => {
    const approved = reportItems()
    const device = pair(approved)
    const changed = reportItems().map((item, index) => index === 0
      ? { ...item, packageFingerprint: 'f'.repeat(64) } : item)
    const service = new AndroidCompanionCapabilityService({ store, now: () => now })
    expect(() => service.applyReport(device.id, 'permissions.report', {
      revision: 1, reportedAt: now.toISOString(), capabilities: changed,
    })).toThrow(AndroidCompanionIdentityConflictError)
    expect(store.getDevice(device.id)).toMatchObject({ capabilitiesRevision: 0 })
  })

  it('cannot re-enable Android executors while emergency stop level three is active', () => {
    const device = pair(reportItems())
    const service = new AndroidCompanionCapabilityService({ store, now: () => now })
    service.applyReport(device.id, 'capabilities.report', report(1))
    const control = getFabricControlState()
    setFabricEmergencyStop(3, 'android-capability-test', 'test emergency stop', control.version)
    const result = service.applyReport(device.id, 'permissions.report', report(2))
    expect(result.executors).toEqual([
      expect.objectContaining({ enabled: false, health: 'degraded' }),
      expect.objectContaining({ enabled: false, health: 'degraded' }),
    ])
    expect(listFabricExecutors().filter(item => item.type === 'android')).toEqual([
      expect.objectContaining({ enabled: false, health: 'degraded', healthDetails: expect.objectContaining({
        lifecycle: 'emergency_stopped',
      }) }),
      expect.objectContaining({ enabled: false, health: 'degraded', healthDetails: expect.objectContaining({
        lifecycle: 'emergency_stopped',
      }) }),
    ])
  })

  function pair(approvedCapabilities: AndroidCapabilityReportItem[]) {
    const signing = generateKeyPairSync('ed25519', keyOptions)
    const exchange = generateKeyPairSync('x25519', keyOptions)
    return store.pairDevice({
      deviceId: deviceIdFromPublicKey(signing.publicKey),
      installationId: `android-installation-${Math.random().toString(16).slice(2)}`,
      signingPublicKey: signing.publicKey,
      exchangePublicKey: exchange.publicKey,
      label: 'Semantic Pixel',
      androidVersion: '16',
      appVersion: '1.0.0',
      initialCapabilitiesDigest: digestAndroidCapabilityReport(approvedCapabilities),
      pairedAt: now.toISOString(),
    }).device
  }
})

const keyOptions = {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
} as const

function report(revision: number) {
  return { revision, reportedAt: now.toISOString(), capabilities: reportItems() }
}

function reportItems(): AndroidCapabilityReportItem[] {
  return [
    {
      capabilityId: ANDROID_APP_LAUNCH_CAPABILITY,
      capabilityVersion: 1,
      packageBinding: ANDROID_COMPANION_PACKAGE,
      packageFingerprint: 'a'.repeat(64),
      driverVersion: '1.0.0',
      permissions: [...ANDROID_APP_LAUNCH_PERMISSIONS],
      verificationStrategy: ANDROID_APP_LAUNCH_VERIFICATION,
      health: 'healthy',
      enabled: true,
    },
    {
      capabilityId: ANDROID_SCREEN_CAPTURE_CAPABILITY,
      capabilityVersion: 1,
      packageBinding: ANDROID_COMPANION_PACKAGE,
      packageFingerprint: 'b'.repeat(64),
      driverVersion: '1.0.0',
      permissions: [...ANDROID_SCREEN_CAPTURE_PERMISSIONS],
      verificationStrategy: ANDROID_SCREEN_CAPTURE_VERIFICATION,
      health: 'degraded',
      enabled: true,
    },
  ]
}
