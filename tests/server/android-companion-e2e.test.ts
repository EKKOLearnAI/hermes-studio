import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket, { type RawData } from 'ws'
import { describe, expect, it } from 'vitest'
import {
  ANDROID_APP_LAUNCH_PERMISSIONS,
  ANDROID_APP_LAUNCH_VERIFICATION,
  ANDROID_COMPANION_PACKAGE,
  ANDROID_COMPANION_PROTOCOL_VERSION,
  ANDROID_SCREEN_CAPTURE_PERMISSIONS,
  ANDROID_SCREEN_CAPTURE_VERIFICATION,
  AndroidCompanionCapabilityService,
  AndroidCompanionCommandBridge,
  AndroidCompanionGateway,
  AndroidCompanionHandshakeInitiator,
  AndroidCompanionNotificationService,
  AndroidCompanionPairingService,
  AndroidCompanionScreenArtifactService,
  AndroidCompanionStore,
  createAndroidCompanionExecutorAdapter,
  digestAndroidCapabilityReport,
  initAndroidCompanionSchema,
  signAndroidPairingTranscript,
  type AndroidCapabilityReportItem,
  type AndroidCompanionGatewayMessage,
  type AndroidCompanionGatewayReply,
  type AndroidCompanionPrivateIdentity,
  type AndroidCompanionSecureSession,
  type AndroidEncryptedEnvelope,
  type AndroidPairingTranscript,
  type AndroidSessionAccept,
} from '../../packages/server/src/services/hermes/android-companion'
import type { FabricExecutionContext, FabricJsonObject } from '../../packages/server/src/services/hermes/action-fabric'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

describe('Android companion virtual-device end to end', () => {
  it('runs encrypted observations and semantic workflows through replay, offline recovery, tamper, and revocation', async () => {
    const originalHome = process.env.HERMES_HOME
    const home = mkdtempSync(join(tmpdir(), 'hermes-android-e2e-'))
    process.env.HERMES_HOME = home
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(database)
    const store = new AndroidCompanionStore(database)
    const studio = identity()
    const companion = identity()
    let clock = new Date()
    const now = () => new Date(clock)
    const capabilities = capabilityItems()
    const projected: unknown[] = []
    const notificationService = new AndroidCompanionNotificationService({
      store, now,
      projector: { project(event) { projected.push(event); return 'created' } },
    })
    const artifactService = new AndroidCompanionScreenArtifactService({ store, now })
    const capabilityService = new AndroidCompanionCapabilityService({ store, now })
    let gateway!: AndroidCompanionGateway
    let bridge = new AndroidCompanionCommandBridge({
      store,
      transport: { send: (deviceId, reply) => gateway.send(deviceId, reply),
        isConnected: deviceId => gateway.isConnected(deviceId) },
      resultTimeoutMs: 2_000,
      now,
    })
    gateway = new AndroidCompanionGateway({
      store, studioIdentity: async () => studio, heartbeatMs: 0, now,
      onMessage(message): AndroidCompanionGatewayReply | undefined {
        if (message.messageType === 'capabilities.report' || message.messageType === 'permissions.report') {
          const result = capabilityService.applyReport(message.deviceId, message.messageType, message.payload as any)
          return { messageType: 'ack', bindingId: message.bindingId, payload: {
            acknowledgedSequence: message.sequence, capabilitiesRevision: result.device.capabilitiesRevision,
            capabilitiesDigest: result.device.capabilitiesDigest,
          } }
        }
        return notificationService.handleMessage(message) ?? artifactService.handleMessage(message)
          ?? bridge.handleMessage(message)
      },
    })
    const server = createServer()
    let virtual: VirtualCompanion | null = null
    try {
      const pairing = new AndroidCompanionPairingService({ store, studioIdentity: async () => studio })
      const offer = await pairing.issue(clock, 30_000)
      const signedTranscript = signAndroidPairingTranscript(
        pairingTranscript(offer.challenge, studio, companion, digestAndroidCapabilityReport(capabilities)),
        companion.signingPrivateKey,
      )
      await expect(pairing.complete({ challengeId: offer.challenge.challengeId, code: offer.challenge.code,
        signedTranscript, approvedByUser: true, now: clock })).resolves.toMatchObject({ disposition: 'created' })
      expect(JSON.stringify(store.listDevices())).not.toMatch(/PRIVATE KEY|pairing.?code|session.?key/i)

      gateway.setupServer(server)
      const port = await listen(server)
      virtual = await VirtualCompanion.connect(port, companion, studio, now)
      await virtual.send('capabilities.report', 'capabilities:e2e:1', {
        revision: 1, reportedAt: clock.toISOString(), capabilities,
      })
      expect(await virtual.receive('capability ack')).toMatchObject({ messageType: 'ack', payload: { capabilitiesRevision: 1 } })
      expect(store.listCapabilities(companion.deviceId)).toHaveLength(2)

      await virtual.send('notification.observed', 'notification:e2e:1', {
        packageBinding: ANDROID_COMPANION_PACKAGE,
        notificationKeyHash: 'a'.repeat(64),
        category: 'auth.otp',
        channelHash: 'b'.repeat(64),
        title: 'Verification code 381921',
        text: 'Use 381921 to sign in',
        visibility: 'private',
        postedAt: clock.toISOString(),
        sourceSequence: 1,
      })
      expect(await virtual.receive('notification ack')).toMatchObject({ messageType: 'ack' })
      expect(store.listNotifications()).toEqual([expect.objectContaining({
        sensitivity: 'metadata', titleSummary: '', textSummary: '',
      })])
      expect(JSON.stringify(projected)).not.toContain('381921')

      const launchContext = appContext(companion.deviceId, 'online')
      let launchExecutor = createAndroidCompanionExecutorAdapter({
        id: launchContext.executorId, deviceId: companion.deviceId,
        capabilityId: 'android.app.launch', store, bridge, now,
      })
      const launchPrepared = await launchExecutor.prepare(launchContext)
      expect(launchPrepared).toMatchObject({ outcome: 'prepared' })
      const launchExecution = launchExecutor.execute({ ...launchContext, preparedOutput: launchPrepared.output })
      expect(await Promise.race([launchExecution, new Promise(resolve => setTimeout(() => resolve(null), 50))]))
        .toBeNull()
      expect(gateway.isConnected(companion.deviceId)).toBe(true)
      await eventually(() => store.listCommands({ workflowId: launchContext.workflowId })[0]?.status === 'delivered')
      const launchOutput = await completeLaunch(virtual, clock)
      await expect(launchExecution).resolves.toMatchObject({ outcome: 'succeeded', output: launchOutput })
      clock = new Date(clock.getTime() + 1_000)
      const launchVerification = launchExecutor.verify({ ...launchContext, executionToken: 'verify-e2e-online',
        preparedOutput: launchPrepared.output, executionOutput: launchOutput })
      await completeLaunch(virtual, clock)
      await expect(launchVerification).resolves.toMatchObject({ outcome: 'verified' })

      bridge.shutdown()
      bridge = new AndroidCompanionCommandBridge({
        store,
        transport: { send: (deviceId, reply) => gateway.send(deviceId, reply),
          isConnected: deviceId => gateway.isConnected(deviceId) },
        resultTimeoutMs: 2_000,
        now,
      })
      launchExecutor = createAndroidCompanionExecutorAdapter({
        id: launchContext.executorId, deviceId: companion.deviceId,
        capabilityId: 'android.app.launch', store, bridge, now,
      })
      await expect(launchExecutor.execute({ ...launchContext, preparedOutput: launchPrepared.output }))
        .resolves.toMatchObject({ outcome: 'succeeded', output: launchOutput })
      expect(virtual.pendingMessages).toBe(0)

      const captureContext = screenContext(companion.deviceId)
      const captureExecutor = createAndroidCompanionExecutorAdapter({
        id: captureContext.executorId, deviceId: companion.deviceId,
        capabilityId: 'android.screen.capture', store, bridge, now,
      })
      const capturePrepared = await captureExecutor.prepare(captureContext)
      expect(capturePrepared).toMatchObject({ outcome: 'prepared' })
      const captureExecution = captureExecutor.execute({ ...captureContext, preparedOutput: capturePrepared.output })
      const captureOutput = await completeCapture(virtual, clock)
      await expect(captureExecution).resolves.toMatchObject({ outcome: 'succeeded', output: captureOutput })
      await expect(captureExecutor.verify({ ...captureContext, executionToken: 'verify-e2e-capture',
        preparedOutput: capturePrepared.output, executionOutput: captureOutput }))
        .resolves.toMatchObject({ outcome: 'verified' })
      expect(store.listScreenArtifacts()).toEqual([expect.objectContaining({
        digest: captureOutput.digest, width: 1080, height: 2400,
      })])
      expect(JSON.stringify(store.listScreenArtifacts())).not.toContain('R'.repeat(43))

      await virtual.close()
      virtual = null
      await eventually(() => !gateway.isConnected(companion.deviceId))
      const offlineContext = appContext(companion.deviceId, 'offline')
      const offlineExecutor = createAndroidCompanionExecutorAdapter({
        id: offlineContext.executorId, deviceId: companion.deviceId,
        capabilityId: 'android.app.launch', store, bridge, now,
      })
      const offlinePrepared = await offlineExecutor.prepare(offlineContext)
      expect(offlinePrepared).toMatchObject({ outcome: 'prepared' })
      await expect(offlineExecutor.execute({ ...offlineContext, preparedOutput: offlinePrepared.output }))
        .resolves.toMatchObject({ outcome: 'temporary_failure', errorCode: 'ANDROID_COMPANION_OFFLINE' })
      const offlineCommandId = store.listCommands({ workflowId: offlineContext.workflowId })[0]!.id

      virtual = await VirtualCompanion.connect(port, companion, studio, now)
      const recoveredExecution = offlineExecutor.execute({ ...offlineContext, preparedOutput: offlinePrepared.output })
      const recoveredOutput = await completeLaunch(virtual, clock)
      await expect(recoveredExecution).resolves.toMatchObject({ outcome: 'succeeded' })
      expect(store.listCommands({ workflowId: offlineContext.workflowId })[0]!.id).toBe(offlineCommandId)
      clock = new Date(clock.getTime() + 1_000)
      const recoveredVerification = offlineExecutor.verify({ ...offlineContext, executionToken: 'verify-e2e-offline',
        preparedOutput: offlinePrepared.output, executionOutput: recoveredOutput })
      await completeLaunch(virtual, clock)
      await expect(recoveredVerification).resolves.toMatchObject({ outcome: 'verified' })

      const tamperedClose = once(virtual.socket, 'close')
      virtual.sendTampered('heartbeat', 'tamper:e2e:1', { sentAt: clock.toISOString() })
      const [tamperCode] = await tamperedClose
      expect(tamperCode).toBe(4003)
      virtual = await VirtualCompanion.connect(port, companion, studio, now)
      const revokedClose = once(virtual.socket, 'close')
      const device = store.getDevice(companion.deviceId)!
      store.revokeDevice(device.id, device.version, 'USER_REVOKED')
      capabilityService.disableDevice(device.id)
      expect(gateway.disconnectDevice(device.id)).toBe(true)
      expect((await revokedClose)[0]).toBe(4003)
      virtual = null
      await expect(rejectedHandshake(port, companion, studio, now)).resolves.toBe(4003)
    } finally {
      if (virtual) await virtual.close().catch(() => undefined)
      bridge.shutdown()
      await gateway.shutdown()
      await closeServer(server)
      database.close()
      if (originalHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = originalHome
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)
})

type Inbound = { messageType: string; bindingId: string; payload: any }

class VirtualCompanion {
  readonly #queue: Inbound[] = []
  readonly #waiters: Array<{ resolve(value: Inbound): void; reject(reason: unknown): void }> = []
  #closedError: Error | null = null

  private constructor(
    readonly socket: WebSocket,
    private readonly session: AndroidCompanionSecureSession,
    private readonly now: () => Date,
  ) {
    socket.on('message', raw => {
      try {
        const envelope = JSON.parse(rawBuffer(raw).toString('utf8')) as AndroidEncryptedEnvelope
        const value = { messageType: envelope.messageType, bindingId: envelope.bindingId,
          payload: session.decrypt(envelope, now()) }
        const waiter = this.#waiters.shift()
        if (waiter) waiter.resolve(value)
        else this.#queue.push(value)
      } catch (error) {
        for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
      }
    })
    socket.on('close', (code, reason) => {
      this.#closedError = new Error(`virtual companion closed: ${code} ${reason.toString()}`)
      for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#closedError)
    })
  }

  static async connect(
    port: number,
    companion: AndroidCompanionPrivateIdentity,
    studio: AndroidCompanionPrivateIdentity,
    now: () => Date,
  ): Promise<VirtualCompanion> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/hermes/android-companion/session`)
    await once(socket, 'open')
    const initiator = new AndroidCompanionHandshakeInitiator({ companion, studio, now: now() })
    socket.send(JSON.stringify(initiator.hello))
    const [raw] = await once(socket, 'message')
    const response = JSON.parse(rawBuffer(raw).toString('utf8')) as AndroidSessionAccept
    return new VirtualCompanion(socket, initiator.complete(response, now()), now)
  }

  get pendingMessages() { return this.#queue.length }

  send(messageType: any, bindingId: string, payload: unknown): void {
    const current = this.now()
    this.socket.send(JSON.stringify(this.session.encrypt({
      messageType, bindingId, payload, now: current,
      expiresAt: new Date(current.getTime() + 60_000).toISOString(),
    })))
  }

  sendTampered(messageType: any, bindingId: string, payload: unknown): void {
    const current = this.now()
    const envelope = this.session.encrypt({ messageType, bindingId, payload, now: current,
      expiresAt: new Date(current.getTime() + 60_000).toISOString() })
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`
    this.socket.send(JSON.stringify(envelope))
  }

  receive(label = 'message'): Promise<Inbound> {
    const queued = this.#queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.#closedError) return Promise.reject(this.#closedError)
    return new Promise((resolve, reject) => {
      let waiter!: { resolve(value: Inbound): void; reject(reason: unknown): void }
      const timeout = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        reject(new Error(`virtual companion receive timed out: ${label}`))
      }, 2_000)
      waiter = {
        resolve(value) { clearTimeout(timeout); resolve(value) },
        reject(reason) { clearTimeout(timeout); reject(reason) },
      }
      this.#waiters.push(waiter)
    })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = once(this.socket, 'close')
    this.socket.close(1000, 'TEST_COMPLETE')
    await closed
  }
}

async function completeLaunch(virtual: VirtualCompanion, observedAt: Date): Promise<FabricJsonObject> {
  const inbound = await virtual.receive('launch command')
  expect(inbound.messageType).toBe('command.execute')
  const command = inbound.payload
  expect(['app_launch', 'foreground_verify']).toContain(command.kind)
  virtual.send('ack', command.workflowId, { commandId: command.commandId, deliveryAttempt: command.deliveryAttempt })
  expect(await virtual.receive('launch delivery ack')).toMatchObject({ messageType: 'ack' })
  const output = { schemaVersion: 1, status: 'succeeded', foregroundPackage: command.payload.appBinding,
    foregroundPackageFingerprint: command.payload.packageFingerprint, observedAt: observedAt.toISOString() }
  virtual.send('command.result', command.workflowId, resultPayload(command, output))
  expect(await virtual.receive('launch result ack')).toMatchObject({ messageType: 'ack' })
  return output
}

async function completeCapture(virtual: VirtualCompanion, capturedAt: Date): Promise<FabricJsonObject> {
  const inbound = await virtual.receive('capture command')
  expect(inbound.messageType).toBe('command.execute')
  const command = inbound.payload
  expect(command.kind).toBe('screen_capture')
  virtual.send('ack', command.workflowId, { commandId: command.commandId, deliveryAttempt: command.deliveryAttempt })
  expect(await virtual.receive('capture delivery ack')).toMatchObject({ messageType: 'ack' })
  const output = { schemaVersion: 1, status: 'succeeded', captureId: 'capture:e2e:screen', digest: 'd'.repeat(64),
    mimeType: 'image/png', width: 1080, height: 2400, byteSize: 1024, permissionGrantActive: true,
    capturedAt: capturedAt.toISOString() }
  virtual.send('screen.capture.result', command.workflowId, {
    commandId: command.commandId, workflowId: command.workflowId, executionToken: command.executionToken,
    materialDigest: command.materialDigest, captureId: output.captureId, digest: output.digest,
    mimeType: output.mimeType, width: output.width, height: output.height, byteSize: output.byteSize,
    permissionGrantActive: true, capturedAt: output.capturedAt, encryptedArtifactRef: 'R'.repeat(43),
  })
  expect(await virtual.receive('capture artifact ack')).toMatchObject({ messageType: 'ack' })
  virtual.send('command.result', command.workflowId, resultPayload(command, output))
  expect(await virtual.receive('capture result ack')).toMatchObject({ messageType: 'ack' })
  return output
}

function resultPayload(command: any, result: FabricJsonObject) {
  return { commandId: command.commandId, workflowId: command.workflowId, executionToken: command.executionToken,
    materialDigest: command.materialDigest, deliveryAttempt: command.deliveryAttempt,
    status: 'succeeded', result, errorCode: null }
}

function appContext(deviceId: string, suffix: string): FabricExecutionContext {
  return {
    intentId: `intent-android-e2e-${suffix}`, workflowId: `workflow-android-e2e-${suffix}`,
    stepId: `step-android-e2e-${suffix}`, executorId: `android-e2e-${suffix}`,
    executorType: 'android', capabilityId: 'android.app.launch', capabilityVersion: 1,
    contractDigest: 'c'.repeat(64), policyEvaluationToken: `policy-android-e2e-${suffix}`,
    executionToken: `execute-android-e2e-${suffix}`,
    input: { schemaVersion: 1, appBinding: 'tv.danmaku.bili', packageFingerprint: 'e'.repeat(64),
      reasonCode: 'user_requested' },
    target: { kind: 'android_app', deviceId, appBinding: 'tv.danmaku.bili', packageFingerprint: 'e'.repeat(64) },
    now: '2026-07-15T08:00:00.000Z',
  }
}

function screenContext(deviceId: string): FabricExecutionContext {
  return {
    intentId: 'intent-android-e2e-capture', workflowId: 'workflow-android-e2e-capture',
    stepId: 'step-android-e2e-capture', executorId: 'android-e2e-capture', executorType: 'android',
    capabilityId: 'android.screen.capture', capabilityVersion: 1, contractDigest: 'c'.repeat(64),
    policyEvaluationToken: 'policy-android-e2e-capture', executionToken: 'execute-android-e2e-capture',
    input: { schemaVersion: 1, captureClass: 'workflow_evidence', reasonCode: 'user_requested' },
    target: { kind: 'android_device', deviceId }, now: '2026-07-15T08:00:00.000Z',
  }
}

function capabilityItems(): AndroidCapabilityReportItem[] {
  return [
    { capabilityId: 'android.app.launch', capabilityVersion: 1, packageBinding: ANDROID_COMPANION_PACKAGE,
      packageFingerprint: 'a'.repeat(64), driverVersion: '1.0.0', permissions: [...ANDROID_APP_LAUNCH_PERMISSIONS],
      verificationStrategy: ANDROID_APP_LAUNCH_VERIFICATION, health: 'healthy', enabled: true },
    { capabilityId: 'android.screen.capture', capabilityVersion: 1, packageBinding: ANDROID_COMPANION_PACKAGE,
      packageFingerprint: 'b'.repeat(64), driverVersion: '1.0.0', permissions: [...ANDROID_SCREEN_CAPTURE_PERMISSIONS],
      verificationStrategy: ANDROID_SCREEN_CAPTURE_VERIFICATION, health: 'healthy', enabled: true },
  ]
}

function pairingTranscript(
  challenge: { challengeId: string; nonce: string; expiresAt: string },
  studio: AndroidCompanionPrivateIdentity,
  companion: AndroidCompanionPrivateIdentity,
  initialCapabilitiesDigest: string,
): AndroidPairingTranscript {
  return {
    protocolVersion: ANDROID_COMPANION_PROTOCOL_VERSION,
    challengeId: challenge.challengeId, challengeNonce: challenge.nonce, expiresAt: challenge.expiresAt,
    studio: publicIdentity(studio), companion: { ...publicIdentity(companion),
      installationId: 'android-installation-e2e', label: 'Virtual Pixel', androidVersion: '16', appVersion: '1.0.0' },
    initialCapabilitiesDigest,
  }
}

function publicIdentity(value: AndroidCompanionPrivateIdentity) {
  return { deviceId: value.deviceId, signingPublicKey: value.signingPublicKey,
    exchangePublicKey: value.exchangePublicKey }
}

function identity(): AndroidCompanionPrivateIdentity {
  const options = { publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } } as const
  const signing = generateKeyPairSync('ed25519', options)
  const exchange = generateKeyPairSync('x25519', options)
  return { deviceId: deviceIdFromPublicKey(signing.publicKey), signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey, exchangePublicKey: exchange.publicKey,
    exchangePrivateKey: exchange.privateKey }
}

async function rejectedHandshake(
  port: number, companion: AndroidCompanionPrivateIdentity, studio: AndroidCompanionPrivateIdentity,
  now: () => Date,
): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/hermes/android-companion/session`)
  await once(socket, 'open')
  const initiator = new AndroidCompanionHandshakeInitiator({ companion, studio, now: now() })
  socket.send(JSON.stringify(initiator.hello))
  const [code] = await once(socket, 'close')
  return Number(code)
}

function rawBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  return Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as any)
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}
