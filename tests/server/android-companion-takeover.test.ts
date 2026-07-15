import { generateKeyPairSync } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AndroidCompanionStore,
  AndroidCompanionTakeoverService,
  digestAndroidCapabilityReport,
  initAndroidCompanionSchema,
  type AndroidCapabilityReportItem,
  type AndroidCompanionGatewayMessage,
  type AndroidTakeoverWorkflowGateway,
} from '../../packages/server/src/services/hermes/android-companion'
import type { FabricWorkflowDetail } from '../../packages/server/src/services/hermes/action-fabric'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

const now = new Date('2026-07-15T08:00:00.000Z')
const workflowId = 'workflow-android-takeover'
const intentId = 'intent-android-takeover'
const commandId = 'command-android-takeover'
const materialDigest = 'a'.repeat(64)

describe('Android same-workflow takeover', () => {
  let database: DatabaseSync
  let store: AndroidCompanionStore
  let workflows: FakeWorkflows
  let service: AndroidCompanionTakeoverService

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(database)
    store = new AndroidCompanionStore(database)
    prepareExecution(store)
    workflows = new FakeWorkflows()
    service = new AndroidCompanionTakeoverService({ store, workflows, now: () => now })
  })

  afterEach(() => database.close())

  it('binds request and claim to the exact workflow, command, generation, device, and policy snapshot', () => {
    const request = service.handleMessage(takeoverRequest())!
    expect(request.payload).toMatchObject({
      status: 'requested', disposition: 'created', generation: 1,
      policyDecisionId: 'policy-android-takeover', policySnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const takeoverId = value(request.payload, 'takeoverId')
    const policySnapshotDigest = value(request.payload, 'policySnapshotDigest')
    const claim = service.handleMessage(takeoverClaim(takeoverId, policySnapshotDigest))!
    expect(claim.payload).toMatchObject({
      takeoverId, status: 'claimed', disposition: 'updated', claimDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(store.getTakeover(takeoverId)).toMatchObject({
      workflowId, commandId, deviceId, capabilityId: 'android.app.launch', generation: 1,
      reasonCode: 'CHALLENGE_REQUIRED', status: 'claimed', version: 2,
    })
    expect(JSON.stringify(store.getTakeover(takeoverId))).not.toContain('P'.repeat(43))
  })

  it('requires the late bound command result then resumes only the original workflow at verification', () => {
    const request = service.handleMessage(takeoverRequest())!
    const takeoverId = value(request.payload, 'takeoverId')
    const policySnapshotDigest = value(request.payload, 'policySnapshotDigest')
    const claim = service.handleMessage(takeoverClaim(takeoverId, policySnapshotDigest))!
    const claimDigest = value(claim.payload, 'claimDigest')
    workflows.workflow.state = 'waiting_user'

    const completion = takeoverCompletion(takeoverId, claimDigest, policySnapshotDigest)
    expect(() => service.handleMessage(completion)).toThrow(/result is not ready/i)
    let command = store.getCommand(commandId)!
    command = store.transitionCommand({ id: command.id, expectedVersion: command.version,
      status: 'waiting_user', errorCode: 'CHALLENGE_REQUIRED' })
    store.transitionReceipt({ workflowId, materialDigest, expectedVersion: 2,
      status: 'waiting_user', errorCode: 'CHALLENGE_REQUIRED' })
    command = store.transitionCommand({ id: command.id, expectedVersion: command.version, status: 'succeeded',
      response: launchResult() })

    const completed = service.handleMessage(completion)!
    expect(completed.payload).toMatchObject({ status: 'completed', workflowState: 'verifying' })
    expect(workflows.resumed).toEqual([{ workflowId, actor: `android-takeover:${deviceId}` }])
    expect(store.getTakeover(takeoverId)).toMatchObject({ status: 'completed', version: 3 })
    expect(store.getReceipt(workflowId)).toMatchObject({ status: 'waiting_user' })

    const replay = service.handleMessage(completion)!
    expect(replay.payload).toMatchObject({ disposition: 'replayed', workflowState: 'verifying' })
    expect(workflows.resumed).toHaveLength(1)
  })

  it('rejects stale generations, changed policy, unrelated routing, and revoked devices', () => {
    const request = service.handleMessage(takeoverRequest())!
    const takeoverId = value(request.payload, 'takeoverId')
    const policySnapshotDigest = value(request.payload, 'policySnapshotDigest')
    expect(() => service.handleMessage(takeoverRequest({ generation: 3 }))).toThrow(/generation/i)
    expect(() => service.handleMessage(takeoverClaim(takeoverId, 'f'.repeat(64)))).toThrow(/policy binding/i)
    expect(() => service.handleMessage({ ...takeoverClaim(takeoverId, policySnapshotDigest),
      bindingId: 'workflow-unrelated-takeover' })).toThrow(/route binding/i)
    store.revokeDevice(deviceId, store.getDevice(deviceId)!.version, 'USER_REVOKED')
    expect(() => service.handleMessage(takeoverClaim(takeoverId, policySnapshotDigest))).toThrow(/unavailable/i)
    expect(store.getTakeover(takeoverId)).toMatchObject({ status: 'cancelled', version: 2 })
  })
})

class FakeWorkflows implements AndroidTakeoverWorkflowGateway {
  resumed: Array<{ workflowId: string; actor: string }> = []
  workflow = {
    id: workflowId,
    intentId,
    capabilityId: 'android.app.launch',
    state: 'executing',
    policyDecisionId: 'policy-android-takeover',
    policyDecision: {
      id: 'policy-android-takeover',
      policySnapshot: { roleId: 'role-android', contractDigest: 'd'.repeat(64), controlVersion: 1 },
    },
  } as FabricWorkflowDetail

  get(id: string): FabricWorkflowDetail | null {
    return id === workflowId ? this.workflow : null
  }

  resumeVerification(id: string, actor: string): FabricWorkflowDetail {
    if (id !== workflowId || this.workflow.state !== 'waiting_user') throw new Error('wrong workflow resume')
    this.resumed.push({ workflowId: id, actor })
    this.workflow.state = 'verifying'
    return this.workflow
  }
}

function takeoverRequest(overrides: Record<string, unknown> = {}): AndroidCompanionGatewayMessage {
  return message('takeover.requested', {
    workflowId,
    commandId,
    capabilityId: 'android.app.launch',
    reasonCode: 'CHALLENGE_REQUIRED',
    generation: 1,
    requestedAt: '2026-07-15T08:00:00.000Z',
    expiresAt: '2026-07-15T08:15:00.000Z',
    ...overrides,
  })
}

function takeoverClaim(takeoverId: string, policySnapshotDigest: string): AndroidCompanionGatewayMessage {
  return message('takeover.claimed', {
    takeoverId,
    workflowId,
    generation: 1,
    claimProof: 'P'.repeat(43),
    claimedAt: '2026-07-15T08:01:00.000Z',
    policyDecisionId: 'policy-android-takeover',
    policySnapshotDigest,
  })
}

function takeoverCompletion(
  takeoverId: string,
  claimDigest: string,
  policySnapshotDigest: string,
): AndroidCompanionGatewayMessage {
  return message('takeover.completed', {
    takeoverId,
    workflowId,
    commandId,
    generation: 1,
    claimDigest,
    completedAt: '2026-07-15T08:02:00.000Z',
    policyDecisionId: 'policy-android-takeover',
    policySnapshotDigest,
  })
}

function message(
  messageType: AndroidCompanionGatewayMessage['messageType'],
  payload: unknown,
): AndroidCompanionGatewayMessage {
  return {
    deviceId,
    sessionId: 'session-takeover',
    messageType,
    bindingId: workflowId,
    sequence: 1,
    receivedAt: now.toISOString(),
    payload,
  }
}

function value(payload: unknown, key: string): string {
  return String((payload as Record<string, unknown>)[key])
}

function prepareExecution(store: AndroidCompanionStore): void {
  const capabilities = capabilityItems()
  const device = store.pairDevice({
    deviceId,
    installationId: 'android-takeover-installation',
    signingPublicKey: signing.publicKey,
    exchangePublicKey: exchange.publicKey,
    label: 'Takeover Companion',
    androidVersion: '15',
    appVersion: '1.0.0',
    initialCapabilitiesDigest: digestAndroidCapabilityReport(capabilities),
    pairedAt: '2026-07-15T07:00:00.000Z',
  }).device
  store.replaceCapabilityReport({ deviceId, expectedDeviceVersion: device.version, revision: 1,
    capabilities, reportedAt: '2026-07-15T07:01:00.000Z' })
  const command = store.queueCommand({
    id: commandId, workflowId, executionToken: 'execution-android-takeover', materialDigest, deviceId,
    capabilityId: 'android.app.launch', capabilityVersion: 1, kind: 'app_launch',
    payload: { schemaVersion: 1, appBinding: 'ai.hermes.companion', packageFingerprint: 'c'.repeat(64),
      reasonCode: 'WORKFLOW_LAUNCH' }, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }).command
  store.prepareReceipt({ workflowId, intentId, materialDigest, deviceId,
    capabilityId: 'android.app.launch', capabilityVersion: 1,
    target: { kind: 'android_app', deviceId, appBinding: 'ai.hermes.companion', packageFingerprint: 'c'.repeat(64) },
  })
  store.transitionCommand({ id: command.id, expectedVersion: command.version, status: 'delivered', deliverySequence: 1 })
  store.transitionReceipt({ workflowId, materialDigest, expectedVersion: 1, status: 'executing', commandId })
}

function launchResult() {
  return {
    schemaVersion: 1,
    status: 'succeeded',
    foregroundPackage: 'ai.hermes.companion',
    foregroundPackageFingerprint: 'c'.repeat(64),
    observedAt: '2026-07-15T08:01:30.000Z',
  }
}

const keyOptions = {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
} as const
const signing = generateKeyPairSync('ed25519', keyOptions)
const exchange = generateKeyPairSync('x25519', keyOptions)
const deviceId = deviceIdFromPublicKey(signing.publicKey)

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
