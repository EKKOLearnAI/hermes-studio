import { generateKeyPairSync } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ANDROID_APP_LAUNCH_PERMISSIONS,
  ANDROID_APP_LAUNCH_VERIFICATION,
  ANDROID_COMPANION_PACKAGE,
  ANDROID_SCREEN_CAPTURE_PERMISSIONS,
  ANDROID_SCREEN_CAPTURE_VERIFICATION,
  AndroidCompanionCommandBridge,
  AndroidCompanionStore,
  androidScreenArtifactId,
  createAndroidCompanionExecutorAdapter,
  digestAndroidCapabilityReport,
  initAndroidCompanionSchema,
  type AndroidCapabilityReportItem,
  type AndroidCommandTransport,
  type AndroidCompanionGatewayMessage,
  type AndroidCompanionGatewayReply,
} from '../../packages/server/src/services/hermes/android-companion'
import type { FabricExecutionContext } from '../../packages/server/src/services/hermes/action-fabric'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

describe('Android Action Fabric executor', () => {
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
    bridge = new AndroidCompanionCommandBridge({ store, transport, resultTimeoutMs: 500 })
  })
  afterEach(() => {
    bridge.shutdown()
    database.close()
  })

  it('prepares, executes once, performs a fresh foreground verification, and replays the durable receipt', async () => {
    const executor = createAndroidCompanionExecutorAdapter({
      id: 'android-test-app-launch', deviceId, capabilityId: 'android.app.launch', store, bridge,
    })
    const executeContext = appContext('execute-token-launch')
    const prepared = await executor.prepare(executeContext)
    expect(prepared).toMatchObject({ outcome: 'prepared', output: {
      materialDigest: expect.stringMatching(/^[a-f0-9]{64}$/), deviceId, capabilityId: 'android.app.launch',
    } })

    const execution = executor.execute({ ...executeContext, preparedOutput: prepared.output })
    await eventually(() => transport.sent.length === 1)
    const launchCommand = commandPayload(transport.sent[0]!.reply)
    expect(launchCommand).toMatchObject({ kind: 'app_launch', payload: executeContext.input })
    const firstOutput = launchOutput(new Date(Date.now() - 1_000).toISOString())
    bridge.handleMessage(resultMessage(deviceId, launchCommand, firstOutput, 'succeeded', null))
    await expect(execution).resolves.toMatchObject({ outcome: 'succeeded', output: firstOutput })

    const verifyContext = {
      ...executeContext,
      executionToken: 'verify-token-launch',
      preparedOutput: prepared.output,
      executionOutput: firstOutput,
    }
    const verification = executor.verify(verifyContext)
    await eventually(() => transport.sent.length === 2)
    const verifyCommand = commandPayload(transport.sent[1]!.reply)
    expect(verifyCommand).toMatchObject({
      kind: 'foreground_verify',
      payload: { appBinding: executeContext.input.appBinding, observedAfter: firstOutput.observedAt },
    })
    const freshOutput = launchOutput(new Date().toISOString())
    bridge.handleMessage(resultMessage(deviceId, verifyCommand, freshOutput, 'succeeded', null))
    await expect(verification).resolves.toMatchObject({ outcome: 'verified', output: firstOutput })
    expect(store.getReceipt(executeContext.workflowId)).toMatchObject({
      status: 'verified', result: firstOutput,
      verification: freshOutput,
    })

    await expect(executor.execute({ ...executeContext, preparedOutput: prepared.output }))
      .resolves.toMatchObject({ outcome: 'succeeded', output: firstOutput })
    expect(transport.sent).toHaveLength(2)
  })

  it('verifies a fresh permission-bound screen artifact without taking a second screenshot', async () => {
    const executor = createAndroidCompanionExecutorAdapter({
      id: 'android-test-screen-capture', deviceId, capabilityId: 'android.screen.capture', store, bridge,
    })
    const context = screenContext('execute-token-capture')
    const prepared = await executor.prepare(context)
    const execution = executor.execute({ ...context, preparedOutput: prepared.output })
    await eventually(() => transport.sent.length === 1)
    const command = commandPayload(transport.sent[0]!.reply)
    const output = captureOutput(new Date().toISOString())
    const artifactId = androidScreenArtifactId({ deviceId, workflowId: context.workflowId,
      commandId: command.commandId, captureId: output.captureId, digest: output.digest, capturedAt: output.capturedAt })
    store.recordScreenArtifact({
      id: artifactId,
      deviceId,
      workflowId: context.workflowId,
      commandId: command.commandId,
      digest: output.digest,
      mimeType: output.mimeType,
      width: output.width,
      height: output.height,
      byteSize: output.byteSize,
      encryptionContextDigest: 'e'.repeat(64),
      capturedAt: output.capturedAt,
    })
    bridge.handleMessage(resultMessage(deviceId, command, output, 'succeeded', null))
    await expect(execution).resolves.toMatchObject({ outcome: 'succeeded', output })
    await expect(executor.verify({
      ...context,
      executionToken: 'verify-token-capture',
      preparedOutput: prepared.output,
      executionOutput: output,
    })).resolves.toMatchObject({ outcome: 'verified', output })
    expect(transport.sent).toHaveLength(1)
    expect(store.getReceipt(context.workflowId)).toMatchObject({
      status: 'verified',
      verification: { strategy: ANDROID_SCREEN_CAPTURE_VERIFICATION, artifactId,
        captureId: output.captureId, digest: output.digest },
    })
  })

  it('fails closed on target substitution and leaves no receipt or command', async () => {
    const executor = createAndroidCompanionExecutorAdapter({
      id: 'android-test-app-launch', deviceId, capabilityId: 'android.app.launch', store, bridge,
    })
    const context = appContext('execute-token-substitution')
    const prepared = await executor.prepare({
      ...context,
      target: { ...context.target, packageFingerprint: 'f'.repeat(64) },
    })
    expect(prepared).toMatchObject({ outcome: 'failed', errorCode: 'ANDROID_CONTEXT_INVALID' })
    expect(store.getReceipt(context.workflowId)).toBeNull()
    expect(store.listCommands()).toEqual([])
  })

  it('cannot verify a screen result without its separately bound encrypted artifact metadata', async () => {
    const executor = createAndroidCompanionExecutorAdapter({
      id: 'android-test-screen-capture', deviceId, capabilityId: 'android.screen.capture', store, bridge,
    })
    const context = screenContext('execute-token-capture-missing-artifact')
    const prepared = await executor.prepare(context)
    const execution = executor.execute({ ...context, preparedOutput: prepared.output })
    await eventually(() => transport.sent.length === 1)
    const command = commandPayload(transport.sent[0]!.reply)
    const output = captureOutput(new Date().toISOString())
    bridge.handleMessage(resultMessage(deviceId, command, output, 'succeeded', null))
    await execution
    await expect(executor.verify({
      ...context,
      executionToken: 'verify-token-capture-missing-artifact',
      preparedOutput: prepared.output,
      executionOutput: output,
    })).resolves.toMatchObject({ outcome: 'mismatch', errorCode: 'ANDROID_CAPTURE_ARTIFACT_MISMATCH' })
  })

  it('resumes a waiting-user command from its late result and verifies the same receipt', async () => {
    const executor = createAndroidCompanionExecutorAdapter({
      id: 'android-test-app-launch', deviceId, capabilityId: 'android.app.launch', store, bridge,
    })
    const context = appContext('execute-token-takeover')
    const prepared = await executor.prepare(context)
    const execution = executor.execute({ ...context, preparedOutput: prepared.output })
    await eventually(() => transport.sent.length === 1)
    const command = commandPayload(transport.sent[0]!.reply)
    bridge.handleMessage(resultMessage(deviceId, command, null, 'waiting_user', 'CHALLENGE_REQUIRED'))
    await expect(execution).resolves.toMatchObject({ outcome: 'unknown', errorCode: 'CHALLENGE_REQUIRED' })
    expect(store.getReceipt(context.workflowId)).toMatchObject({ status: 'waiting_user', result: null })

    const completedOutput = launchOutput(new Date().toISOString())
    bridge.handleMessage(resultMessage(deviceId, command, completedOutput, 'succeeded', null))
    const verification = executor.verify({
      ...context,
      executionToken: 'verify-token-takeover',
      preparedOutput: prepared.output,
      executionOutput: {},
    })
    await eventually(() => transport.sent.length === 2)
    const verificationCommand = commandPayload(transport.sent[1]!.reply)
    const freshOutput = launchOutput(new Date(Date.now() + 1_000).toISOString())
    bridge.handleMessage(resultMessage(deviceId, verificationCommand, freshOutput, 'succeeded', null))
    await expect(verification).resolves.toMatchObject({ outcome: 'verified', output: completedOutput })
    expect(store.getReceipt(context.workflowId)).toMatchObject({ status: 'verified', result: completedOutput })
  })

  it('returns a retryable offline outcome without claiming device execution', async () => {
    const executor = createAndroidCompanionExecutorAdapter({
      id: 'android-test-app-launch', deviceId, capabilityId: 'android.app.launch', store, bridge,
    })
    const context = appContext('execute-token-offline')
    const prepared = await executor.prepare(context)
    transport.connected = false
    await expect(executor.execute({ ...context, preparedOutput: prepared.output })).resolves.toMatchObject({
      outcome: 'temporary_failure', errorCode: 'ANDROID_COMPANION_OFFLINE', safeToRetry: true,
    })
    expect(store.listCommands()).toEqual([expect.objectContaining({ status: 'queued', deliveryAttempts: 0 })])
    expect(store.getReceipt(context.workflowId)).toMatchObject({ status: 'unknown' })
  })

  it('interrupts an in-flight device command only after encrypted cancellation is confirmed', async () => {
    const executor = createAndroidCompanionExecutorAdapter({
      id: 'android-test-app-launch', deviceId, capabilityId: 'android.app.launch', store, bridge,
    })
    const context = appContext('execute-token-interrupt')
    const prepared = await executor.prepare(context)
    const execution = executor.execute({ ...context, preparedOutput: prepared.output })
    await eventually(() => transport.sent.length === 1)
    const command = commandPayload(transport.sent[0]!.reply)
    const interruption = executor.interrupt({ ...context, preparedOutput: prepared.output })
    await eventually(() => transport.sent.length === 2)
    expect(transport.sent[1]?.reply).toMatchObject({
      messageType: 'command.cancel', payload: { commandId: command.commandId, materialDigest: command.materialDigest },
    })
    bridge.handleMessage(resultMessage(deviceId, command, null, 'cancelled', null))
    await expect(interruption).resolves.toMatchObject({ outcome: 'interrupted' })
    await expect(execution).resolves.toMatchObject({ outcome: 'permanent_failure', errorCode: 'ANDROID_COMMAND_CANCELLED' })
  })

  function appContext(executionToken: string): FabricExecutionContext {
    return {
      intentId: 'intent-android-executor-launch',
      workflowId: 'workflow-android-executor-launch',
      stepId: `step-${executionToken}`,
      executorId: 'android-test-app-launch',
      executorType: 'android',
      capabilityId: 'android.app.launch',
      capabilityVersion: 1,
      contractDigest: 'c'.repeat(64),
      policyEvaluationToken: 'policy-android-executor-launch',
      executionToken,
      input: {
        schemaVersion: 1,
        appBinding: 'tv.danmaku.bili',
        packageFingerprint: 'e'.repeat(64),
        reasonCode: 'user_requested',
      },
      target: {
        kind: 'android_app',
        deviceId,
        appBinding: 'tv.danmaku.bili',
        packageFingerprint: 'e'.repeat(64),
      },
      now: new Date().toISOString(),
    }
  }

  function screenContext(executionToken: string): FabricExecutionContext {
    return {
      intentId: 'intent-android-executor-capture',
      workflowId: 'workflow-android-executor-capture',
      stepId: `step-${executionToken}`,
      executorId: 'android-test-screen-capture',
      executorType: 'android',
      capabilityId: 'android.screen.capture',
      capabilityVersion: 1,
      contractDigest: 'd'.repeat(64),
      policyEvaluationToken: 'policy-android-executor-capture',
      executionToken,
      input: { schemaVersion: 1, captureClass: 'workflow_evidence', reasonCode: 'user_requested' },
      target: { kind: 'android_device', deviceId },
      now: new Date().toISOString(),
    }
  }
})

class FakeTransport implements AndroidCommandTransport {
  connected = true
  sent: Array<{ deviceId: string; reply: AndroidCompanionGatewayReply }> = []
  isConnected(): boolean { return this.connected }
  async send(deviceId: string, reply: AndroidCompanionGatewayReply): Promise<void> {
    this.sent.push({ deviceId, reply })
  }
}

function pairAndReport(store: AndroidCompanionStore): string {
  const signing = generateKeyPairSync('ed25519', keyOptions)
  const exchange = generateKeyPairSync('x25519', keyOptions)
  const deviceId = deviceIdFromPublicKey(signing.publicKey)
  const capabilities = capabilityItems()
  const paired = store.pairDevice({
    deviceId,
    installationId: 'android-installation-executor',
    signingPublicKey: signing.publicKey,
    exchangePublicKey: exchange.publicKey,
    label: 'Executor Pixel',
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
  return [
    {
      capabilityId: 'android.app.launch', capabilityVersion: 1,
      packageBinding: ANDROID_COMPANION_PACKAGE, packageFingerprint: 'a'.repeat(64), driverVersion: '1.0.0',
      permissions: [...ANDROID_APP_LAUNCH_PERMISSIONS], verificationStrategy: ANDROID_APP_LAUNCH_VERIFICATION,
      health: 'healthy', enabled: true,
    },
    {
      capabilityId: 'android.screen.capture', capabilityVersion: 1,
      packageBinding: ANDROID_COMPANION_PACKAGE, packageFingerprint: 'b'.repeat(64), driverVersion: '1.0.0',
      permissions: [...ANDROID_SCREEN_CAPTURE_PERMISSIONS], verificationStrategy: ANDROID_SCREEN_CAPTURE_VERIFICATION,
      health: 'healthy', enabled: true,
    },
  ]
}

function commandPayload(reply: AndroidCompanionGatewayReply): Record<string, any> {
  return reply.payload as Record<string, any>
}

function resultMessage(
  deviceId: string,
  command: Record<string, any>,
  output: Record<string, unknown> | null,
  status: 'succeeded' | 'waiting_user' | 'cancelled',
  errorCode: string | null,
): AndroidCompanionGatewayMessage {
  return {
    deviceId,
    sessionId: 'android-session-executor-test',
    messageType: 'command.result',
    bindingId: String(command.workflowId),
    sequence: 2,
    receivedAt: new Date().toISOString(),
    payload: {
      commandId: command.commandId,
      workflowId: command.workflowId,
      executionToken: command.executionToken,
      materialDigest: command.materialDigest,
      deliveryAttempt: command.deliveryAttempt,
      status,
      result: output,
      errorCode,
    },
  }
}

function launchOutput(observedAt: string) {
  return {
    schemaVersion: 1,
    status: 'succeeded',
    foregroundPackage: 'tv.danmaku.bili',
    foregroundPackageFingerprint: 'e'.repeat(64),
    observedAt,
  }
}

function captureOutput(capturedAt: string) {
  return {
    schemaVersion: 1,
    status: 'succeeded',
    captureId: 'capture-android-executor-1',
    digest: 'f'.repeat(64),
    mimeType: 'image/png',
    width: 1080,
    height: 2400,
    byteSize: 1024,
    permissionGrantActive: true,
    capturedAt,
  }
}

const keyOptions = {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
} as const

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('condition was not reached')
}
