import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  runtime: null as any,
  control: vi.fn(() => ({ level: 0, version: 7 })),
  getRuntime: vi.fn(() => state.runtime),
}))

vi.mock('../../packages/server/src/services/hermes/action-fabric', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getFabricControlState: state.control,
}))
vi.mock('../../packages/server/src/services/hermes/android-companion', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getAndroidCompanionRuntime: state.getRuntime,
}))

describe('Android companion controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.runtime = runtimeFixture()
  })

  it('serves a bounded overview without trust secrets, transport material, or local references', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/android-companion')
    const ctx = context()
    await ctrl.overview(ctx)
    expect(ctx.body).toMatchObject({
      devices: [{ id: deviceId, connected: true, state: 'paired' }],
      capabilities: [{ capabilityId: 'android.app.launch', health: 'healthy', enabled: true }],
      summary: {
        pairedDeviceCount: 1, connectedDeviceCount: 1, healthyCapabilityCount: 1,
        activeCommandCount: 1, verifiedReceiptCount: 1, notificationCount: 1,
        artifactCount: 1, pendingTakeoverCount: 1,
      },
      emergencyStop: { level: 0, version: 7 },
    })
    expect(JSON.stringify(ctx.body)).not.toMatch(/PRIVATE KEY|PUBLIC KEY|installation-secret|session-secret|pairing.?code|claimDigest|encryptionContext|notificationKeyHash|materialDigest|executionToken|local.?path/i)
  })

  it('returns only minimized list DTOs and no command payload or raw receipt target', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/android-companion')
    const outputs: unknown[] = []
    for (const handler of [ctrl.commands, ctrl.receipts, ctrl.notifications, ctrl.artifacts, ctrl.takeovers]) {
      const ctx = context()
      await handler(ctx)
      outputs.push(ctx.body)
    }
    expect(outputs[0]).toMatchObject({ commands: [{ id: 'command-android-api', status: 'waiting_user' }] })
    expect(outputs[1]).toMatchObject({ receipts: [{ status: 'verified', result: {
      status: 'succeeded', foregroundPackage: 'ai.hermes.companion',
    } }] })
    expect(outputs[2]).toMatchObject({ notifications: [{ sensitivity: 'metadata', titleSummary: '', textSummary: '' }] })
    expect(outputs[3]).toMatchObject({ artifacts: [{ mimeType: 'image/png', width: 1080, height: 2400 }] })
    expect(outputs[4]).toMatchObject({ takeovers: [{ status: 'claimed', reasonCode: 'CHALLENGE_REQUIRED' }] })
    expect(JSON.stringify(outputs)).not.toMatch(/secret-payload|raw-target|claim-secret|encryption-secret|notification-secret|execution-secret/i)
  })

  it('revokes device trust, disables its executors, and disconnects its encrypted session', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/android-companion')
    const ctx = context({ expectedVersion: 2, reason: 'USER_REVOKED' }, { deviceId })
    await ctrl.revokeDevice(ctx)
    expect(state.runtime.store.revokeDevice).toHaveBeenCalledWith(deviceId, 2, 'USER_REVOKED')
    expect(state.runtime.capabilities.disableDevice).toHaveBeenCalledWith(deviceId)
    expect(state.runtime.gateway.disconnectDevice).toHaveBeenCalledWith(deviceId)
    expect(ctx.body.device).toMatchObject({ id: deviceId, state: 'revoked', connected: false })
  })

  it('keeps the one-time pairing code on the authenticated offer response and requires explicit completion approval', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/android-companion')
    const offer = context({})
    await ctrl.issuePairingOffer(offer)
    expect(offer.status).toBe(201)
    expect(offer.body.offer).toMatchObject({ challengeId: 'android-pair-api', code: 'ONE_TIME_CODE' })

    const rejected = context({ challengeId: 'android-pair-api', code: 'ONE_TIME_CODE',
      signedTranscript: {}, approved: false })
    await ctrl.completePairing(rejected)
    expect(rejected).toMatchObject({ status: 400, body: { code: 'ANDROID_REQUEST_INVALID' } })
    expect(state.runtime.pairing.complete).not.toHaveBeenCalled()

    const accepted = context({ challengeId: 'android-pair-api', code: 'ONE_TIME_CODE',
      signedTranscript: { transcript: {}, companionSignature: 'signature' }, approved: true })
    await ctrl.completePairing(accepted)
    expect(accepted.status).toBe(201)
    expect(state.runtime.pairing.complete).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: 'android-pair-api', code: 'ONE_TIME_CODE', approvedByUser: true,
    }))
    expect(JSON.stringify(accepted.body)).not.toContain('ONE_TIME_CODE')
  })

  it('rejects unexpected fields and sanitizes unexpected internal failures', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/android-companion')
    const extra = context({ expectedVersion: 2, reason: 'USER_REVOKED', privateKey: 'secret' }, { deviceId })
    await ctrl.revokeDevice(extra)
    expect(extra).toMatchObject({ status: 400, body: { code: 'ANDROID_REQUEST_INVALID' } })
    state.runtime.pairing.issue.mockRejectedValueOnce(new Error('PRIVATE KEY session-secret local-path'))
    const failure = context({})
    await ctrl.issuePairingOffer(failure)
    expect(failure).toMatchObject({ status: 503, body: { code: 'ANDROID_OPERATION_FAILED' } })
    expect(JSON.stringify(failure.body)).not.toMatch(/PRIVATE|secret|path/i)
  })
})

const deviceId = `hwui_${'a'.repeat(32)}`
const baseTime = '2026-07-15T08:00:00.000Z'

function runtimeFixture() {
  const device = {
    id: deviceId, installationId: 'installation-secret', signingPublicKey: 'PUBLIC KEY secret',
    exchangePublicKey: 'PUBLIC KEY exchange', signingFingerprint: 'b'.repeat(64),
    exchangeFingerprint: 'c'.repeat(64), label: 'Pixel', androidVersion: '15', appVersion: '1.0.0',
    state: 'paired', capabilitiesRevision: 1, capabilitiesDigest: 'd'.repeat(64), lastReceivedSequence: 2,
    lastSentSequence: 3, version: 2, pairedAt: baseTime, revokedAt: null, revocationReason: null,
    lastSeenAt: baseTime, createdAt: baseTime, updatedAt: baseTime,
  }
  const capability = {
    deviceId, capabilityId: 'android.app.launch', capabilityVersion: 1, packageBinding: 'ai.hermes.companion',
    packageFingerprint: 'e'.repeat(64), driverVersion: '1.0.0', permissions: ['android.permission.PACKAGE_USAGE_STATS'],
    verificationStrategy: 'fresh_foreground_package_and_signature', health: 'healthy', enabled: true,
    reportRevision: 1, createdAt: baseTime, updatedAt: baseTime,
  }
  const command = {
    id: 'command-android-api', workflowId: 'workflow-android-api', executionToken: 'execution-secret',
    materialDigest: 'f'.repeat(64), deviceId, capabilityId: 'android.app.launch', capabilityVersion: 1,
    kind: 'app_launch', payload: { secret: 'secret-payload' }, status: 'waiting_user', deliverySequence: 1,
    deliveryAttempts: 1, response: { status: 'succeeded', foregroundPackage: 'ai.hermes.companion',
      observedAt: baseTime }, errorCode: 'CHALLENGE_REQUIRED', version: 3, expiresAt: baseTime,
    createdAt: baseTime, updatedAt: baseTime, completedAt: null,
  }
  const receipt = {
    workflowId: command.workflowId, intentId: 'intent-android-api', materialDigest: command.materialDigest,
    deviceId, capabilityId: command.capabilityId, capabilityVersion: 1, target: { secret: 'raw-target' },
    status: 'verified', commandId: command.id, result: command.response, verification: { secret: 'raw-verify' },
    errorCode: null, version: 5, createdAt: baseTime, updatedAt: baseTime, completedAt: baseTime,
  }
  const notification = {
    id: 'notification-android-api', deviceId, packageBinding: 'ai.hermes.companion',
    notificationKeyHash: 'notification-secret', category: 'auth.otp', channelHash: null,
    titleSummary: '', textSummary: '', sensitivity: 'metadata', sourceSequence: 1,
    provenanceDigest: 'notification-secret', postedAt: baseTime, removedAt: null, version: 1,
    createdAt: baseTime, updatedAt: baseTime,
  }
  const artifact = {
    id: 'screen-artifact-android-api', deviceId, workflowId: command.workflowId, commandId: command.id,
    digest: '1'.repeat(64), mimeType: 'image/png', width: 1080, height: 2400, byteSize: 1234,
    encryptionContextDigest: 'encryption-secret', capturedAt: baseTime, createdAt: baseTime,
  }
  const takeover = {
    id: 'takeover-android-api', workflowId: command.workflowId, commandId: command.id, deviceId,
    capabilityId: command.capabilityId, reasonCode: 'CHALLENGE_REQUIRED', generation: 1, status: 'claimed',
    claimDigest: 'claim-secret', version: 2, requestedAt: baseTime, claimedAt: baseTime,
    completedAt: null, expiresAt: baseTime, updatedAt: baseTime,
  }
  const revoked = { ...device, state: 'revoked', version: 3, revokedAt: baseTime, revocationReason: 'USER_REVOKED' }
  const store = {
    expireTakeovers: vi.fn(() => 0), listDevices: vi.fn(() => [device]),
    listCapabilities: vi.fn(() => [capability]), listCommands: vi.fn(() => [command]),
    listReceipts: vi.fn(() => [receipt]), listNotifications: vi.fn(() => [notification]),
    listScreenArtifacts: vi.fn(() => [artifact]), listTakeovers: vi.fn(() => [takeover]),
    getCommand: vi.fn(() => command), revokeDevice: vi.fn(() => revoked),
  }
  return {
    store,
    gateway: { listConnections: vi.fn(() => [{ deviceId }]), disconnectDevice: vi.fn() },
    capabilities: { disableDevice: vi.fn() },
    pairing: {
      issue: vi.fn(async () => ({ challenge: { challengeId: 'android-pair-api', nonce: 'nonce',
        code: 'ONE_TIME_CODE', studioDeviceId: 'studio-device-api', expiresAt: baseTime },
      studio: { deviceId: 'studio-device-api', signingPublicKey: 'PUBLIC KEY studio', exchangePublicKey: 'PUBLIC KEY exchange' } })),
      complete: vi.fn(async () => ({ disposition: 'created', device })),
      revokeOffer: vi.fn(() => true),
    },
  }
}

function context(body?: unknown, params: Record<string, string> = {}) {
  return {
    request: { body, type: 'application/json' },
    query: {},
    params,
    state: { user: { id: 42, role: 'super_admin' } },
    status: 200,
    body: null as any,
  } as any
}
