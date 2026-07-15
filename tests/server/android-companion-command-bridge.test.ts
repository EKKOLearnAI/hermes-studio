import { generateKeyPairSync } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ANDROID_APP_LAUNCH_PERMISSIONS,
  ANDROID_APP_LAUNCH_VERIFICATION,
  ANDROID_COMPANION_PACKAGE,
  AndroidCompanionCommandBridge,
  AndroidCompanionStore,
  AndroidCompanionValidationError,
  digestAndroidCapabilityReport,
  initAndroidCompanionSchema,
  type AndroidCompanionGatewayMessage,
  type AndroidCompanionGatewayReply,
  type AndroidCapabilityReportItem,
  type AndroidCommandTransport,
} from '../../packages/server/src/services/hermes/android-companion'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

describe('Android durable command bridge', () => {
  let database: DatabaseSync
  let store: AndroidCompanionStore
  let transport: FakeTransport
  let bridge: AndroidCompanionCommandBridge
  let deviceId: string

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(database)
    store = new AndroidCompanionStore(database)
    deviceId = pairAndReport(store)
    transport = new FakeTransport()
    bridge = new AndroidCompanionCommandBridge({ store, transport, resultTimeoutMs: 100 })
  })
  afterEach(() => {
    bridge.shutdown()
    database.close()
  })

  it('delivers one workflow-bound command, persists acknowledgement/result, and replays terminal output', async () => {
    const command = queue(store, deviceId)
    const pending = bridge.execute(command.id)
    await eventually(() => transport.sent.length === 1)
    expect(transport.sent[0]).toMatchObject({
      deviceId,
      reply: {
        messageType: 'command.execute',
        bindingId: command.workflowId,
        payload: {
          commandId: command.id,
          workflowId: command.workflowId,
          executionToken: command.executionToken,
          materialDigest: command.materialDigest,
          capabilityId: 'android.app.launch',
          kind: 'app_launch',
          deliveryAttempt: 1,
        },
      },
    })
    expect(bridge.handleMessage(message('ack', {
      commandId: command.id, deliveryAttempt: 1,
    }))).toMatchObject({ messageType: 'ack', payload: { commandId: command.id } })
    expect(store.getCommand(command.id)).toMatchObject({ status: 'acknowledged', deliverySequence: 1 })
    const output = launchOutput()
    expect(bridge.handleMessage(message('command.result', result(command, 1, 'succeeded', output, null))))
      .toMatchObject({ messageType: 'ack', payload: { commandId: command.id } })
    await expect(pending).resolves.toMatchObject({ outcome: 'succeeded', output })
    expect(store.getCommand(command.id)).toMatchObject({
      status: 'succeeded', response: output, deliveryAttempts: 1,
    })

    await expect(bridge.execute(command.id)).resolves.toMatchObject({ outcome: 'succeeded', output })
    expect(transport.sent).toHaveLength(1)
    expect(bridge.handleMessage(message('command.result', result(command, 1, 'succeeded', output, null))))
      .toMatchObject({ messageType: 'ack' })
  })

  it('keeps an offline command queued and marks uncertain transport safe for same-ID redelivery', async () => {
    const command = queue(store, deviceId)
    transport.connected = false
    await expect(bridge.execute(command.id)).resolves.toMatchObject({
      outcome: 'temporary_failure', errorCode: 'ANDROID_COMPANION_OFFLINE', safeToRetry: true,
    })
    expect(store.getCommand(command.id)).toMatchObject({ status: 'queued', deliveryAttempts: 0 })

    transport.connected = true
    transport.failNext = true
    await expect(bridge.execute(command.id)).resolves.toMatchObject({
      outcome: 'temporary_failure', errorCode: 'ANDROID_COMMAND_TRANSPORT_UNCERTAIN', safeToRetry: true,
    })
    expect(store.getCommand(command.id)).toMatchObject({
      status: 'unknown', deliverySequence: 1, deliveryAttempts: 1,
    })
    const retried = bridge.execute(command.id)
    await eventually(() => transport.sent.length === 2)
    expect(transport.sent[1]?.reply).toMatchObject({ payload: { commandId: command.id, deliveryAttempt: 2 } })
    bridge.handleMessage(message('command.result', result(command, 2, 'succeeded', launchOutput(), null)))
    await expect(retried).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(store.getCommand(command.id)).toMatchObject({ deliveryAttempts: 2, deliverySequence: 2 })
  })

  it('persists result timeout as unknown and permits a later device result to settle it', async () => {
    const command = queue(store, deviceId)
    await expect(bridge.execute(command.id)).resolves.toMatchObject({
      outcome: 'temporary_failure', errorCode: 'ANDROID_COMMAND_RESULT_TIMEOUT', safeToRetry: true,
    })
    expect(store.getCommand(command.id)).toMatchObject({ status: 'unknown', deliverySequence: 1 })
    const output = launchOutput()
    bridge.handleMessage(message('command.result', result(command, 1, 'succeeded', output, null)))
    expect(store.getCommand(command.id)).toMatchObject({ status: 'succeeded', response: output })
  })

  it('rejects changed workflow identity and preserves the durable command', async () => {
    const command = queue(store, deviceId)
    const pending = bridge.execute(command.id)
    await eventually(() => transport.sent.length === 1)
    expect(() => bridge.handleMessage(message('command.result', {
      ...result(command, 1, 'succeeded', launchOutput(), null),
      materialDigest: 'f'.repeat(64),
    }))).toThrow(AndroidCompanionValidationError)
    expect(store.getCommand(command.id)).toMatchObject({ status: 'delivered', materialDigest: command.materialDigest })
    bridge.handleMessage(message('command.result', result(command, 1, 'succeeded', launchOutput(), null)))
    await pending
  })

  it('redelivers the same durable command after bridge restart without changing material', async () => {
    const command = queue(store, deviceId)
    const first = bridge.execute(command.id)
    await eventually(() => transport.sent.length === 1)
    bridge.shutdown()
    await expect(first).resolves.toMatchObject({ outcome: 'unknown', errorCode: 'ANDROID_COMMAND_BRIDGE_STOPPED' })

    const restarted = new AndroidCompanionCommandBridge({ store, transport, resultTimeoutMs: 100 })
    bridge = restarted
    const pending = restarted.execute(command.id)
    await eventually(() => transport.sent.length === 2)
    expect(transport.sent.map(item => item.reply)).toMatchObject([
      { payload: { commandId: command.id, materialDigest: command.materialDigest, deliveryAttempt: 1 } },
      { payload: { commandId: command.id, materialDigest: command.materialDigest, deliveryAttempt: 2 } },
    ])
    restarted.handleMessage(message('command.result', result(command, 2, 'succeeded', launchOutput(), null)))
    await expect(pending).resolves.toMatchObject({ outcome: 'succeeded' })
  })

  function message(messageType: 'ack' | 'command.result', payload: unknown): AndroidCompanionGatewayMessage {
    return {
      deviceId,
      sessionId: 'android-session-command-test',
      messageType,
      bindingId: 'workflow-android-command-bridge',
      sequence: 2,
      payload,
      receivedAt: new Date().toISOString(),
    }
  }
})

class FakeTransport implements AndroidCommandTransport {
  connected = true
  failNext = false
  sent: Array<{ deviceId: string; reply: AndroidCompanionGatewayReply }> = []

  isConnected(): boolean { return this.connected }

  async send(deviceId: string, reply: AndroidCompanionGatewayReply): Promise<void> {
    this.sent.push({ deviceId, reply })
    if (this.failNext) {
      this.failNext = false
      throw new Error('socket failed after delivery reservation')
    }
  }
}

function pairAndReport(store: AndroidCompanionStore): string {
  const signing = generateKeyPairSync('ed25519', keyOptions)
  const exchange = generateKeyPairSync('x25519', keyOptions)
  const deviceId = deviceIdFromPublicKey(signing.publicKey)
  const capabilities = capabilityItems()
  const paired = store.pairDevice({
    deviceId,
    installationId: 'android-installation-command-bridge',
    signingPublicKey: signing.publicKey,
    exchangePublicKey: exchange.publicKey,
    label: 'Command Pixel',
    androidVersion: '16',
    appVersion: '1.0.0',
    initialCapabilitiesDigest: digestAndroidCapabilityReport(capabilities),
  }).device
  store.replaceCapabilityReport({
    deviceId,
    expectedDeviceVersion: paired.version,
    revision: 1,
    reportedAt: new Date().toISOString(),
    capabilities,
  })
  return deviceId
}

function capabilityItems(): AndroidCapabilityReportItem[] {
  return [{
    capabilityId: 'android.app.launch',
    capabilityVersion: 1,
    packageBinding: ANDROID_COMPANION_PACKAGE,
    packageFingerprint: 'a'.repeat(64),
    driverVersion: '1.0.0',
    permissions: [...ANDROID_APP_LAUNCH_PERMISSIONS],
    verificationStrategy: ANDROID_APP_LAUNCH_VERIFICATION,
    health: 'healthy',
    enabled: true,
  }]
}

function queue(store: AndroidCompanionStore, deviceId: string) {
  return store.queueCommand({
    id: 'command-android-bridge-launch',
    workflowId: 'workflow-android-command-bridge',
    executionToken: 'execution-android-command-bridge',
    materialDigest: 'd'.repeat(64),
    deviceId,
    capabilityId: 'android.app.launch',
    capabilityVersion: 1,
    kind: 'app_launch',
    payload: { appBinding: 'tv.danmaku.bili', packageFingerprint: 'e'.repeat(64), reasonCode: 'user_requested' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }).command
}

function result(
  command: ReturnType<typeof queue>,
  deliveryAttempt: number,
  status: 'succeeded' | 'failed' | 'unknown' | 'waiting_user' | 'cancelled',
  output: Record<string, unknown> | null,
  errorCode: string | null,
) {
  return {
    commandId: command.id,
    workflowId: command.workflowId,
    executionToken: command.executionToken,
    materialDigest: command.materialDigest,
    deliveryAttempt,
    status,
    result: output,
    errorCode,
  }
}

function launchOutput() {
  return {
    schemaVersion: 1,
    status: 'succeeded',
    foregroundPackage: 'tv.danmaku.bili',
    foregroundPackageFingerprint: 'e'.repeat(64),
    observedAt: new Date().toISOString(),
  }
}

const keyOptions = {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
} as const

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('condition was not reached')
}
