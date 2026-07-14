import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  listFabricExecutors,
  setFabricEmergencyStop,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  HomeProductionRuntime,
  HomeTwinStore,
  type HomeProductionClient,
  type HomeProductionObservation,
} from '../../packages/server/src/services/hermes/home'
import type { ResolvedHomeAssistantConfig } from '../../packages/server/src/services/hermes/home/home-assistant-config'
import type { HomeAssistantRuntimeStatus } from '../../packages/server/src/services/hermes/home/home-assistant-runtime'
import { getPersonalTwinDbPath, initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin/database'
import { getAssistantRole } from '../../packages/server/src/services/hermes/personal-twin/assistant-roles'

describe('home production runtime lifecycle', () => {
  const originalHome = process.env.HERMES_HOME
  let directory = ''
  let resolved: ResolvedHomeAssistantConfig | null
  let runtime: HomeProductionRuntime | null = null
  let createdClients = 0
  let abortedObservations = 0

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hermes-home-production-'))
    process.env.HERMES_HOME = directory
    resolved = config('fingerprint-a')
    createdClients = 0
    abortedObservations = 0
    ensureBuiltInFabricRegistry()
  })

  afterEach(async () => {
    await runtime?.stop()
    runtime = null
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(directory, { recursive: true, force: true })
  })

  it('enables only a connected configured exact binding and leaves repeated approval snapshots stable', async () => {
    runtime = createRuntime()
    await runtime.start()
    expect(runtime.getStatus()).toMatchObject({
      active: true, configured: true, connectionStatus: 'connected', executorEnabled: true,
      authorizedTargetCount: 3, lastErrorCode: null,
    })
    expect(homeExecutor()).toMatchObject({ enabled: true, health: 'healthy' })
    expect(getAssistantRole('home-manager')?.decisionAuthority.allowedTargets).toEqual([
      'home:binding:home-assistant:light.office_lamp',
      'home:device:device:lamp',
      'home:provider:home-assistant',
    ])

    const input = powerPolicyInput('home-runtime-stable')
    const before = evaluateFabricPolicy(input)
    await runtime.reconcile()
    const after = evaluateFabricPolicy(input)
    expect(before).toMatchObject({ outcome: 'waiting_user', executorId: 'home-assistant' })
    expect(after.id).toBe(before.id)
    expect(after.policySnapshot).toEqual(before.policySnapshot)
    expect(createdClients).toBe(1)
  })

  it('revokes credentials and targets before allowing another command', async () => {
    runtime = createRuntime()
    await runtime.start()
    resolved = null
    await runtime.reconcile()

    expect(runtime.getStatus()).toMatchObject({
      configured: false, connectionStatus: 'unconfigured', executorEnabled: false,
      authorizedTargetCount: 0, lastErrorCode: 'HOME_ASSISTANT_NOT_CONFIGURED',
    })
    expect(homeExecutor()).toMatchObject({ enabled: false, health: 'unhealthy' })
    expect(getAssistantRole('home-manager')?.decisionAuthority.allowedTargets).toEqual([])
    expect(evaluateFabricPolicy(powerPolicyInput('home-runtime-revoked')))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['executor_unavailable'] })
    expect(abortedObservations).toBe(1)
  })

  it('rotates changed credentials and never re-enables through a level-three emergency stop', async () => {
    runtime = createRuntime()
    await runtime.start()
    resolved = config('fingerprint-b')
    await runtime.reconcile()
    expect(createdClients).toBe(2)
    expect(abortedObservations).toBe(1)
    expect(runtime.getStatus()).toMatchObject({ credentialFingerprint: 'fingerprint-b', executorEnabled: true })

    setFabricEmergencyStop(3, 'admin', 'home production stop')
    await runtime.reconcile()
    expect(runtime.getStatus().executorEnabled).toBe(false)
    expect(homeExecutor().enabled).toBe(false)
    await runtime.reconcile()
    expect(homeExecutor().enabled).toBe(false)
  })

  function createRuntime(): HomeProductionRuntime {
    return new HomeProductionRuntime({
      activeProfile: () => 'default',
      resolveConfig: async () => resolved,
      openStore: openStoreWithLight,
      createClient: () => {
        createdClients += 1
        return client()
      },
      createObservation: configValue => connectedObservation(configValue),
      pollIntervalMs: 60_000,
    })
  }

  function openStoreWithLight(): { store: HomeTwinStore; close(): void } {
    const path = getPersonalTwinDbPath()
    mkdirSync(join(path, '..'), { recursive: true })
    const database = new DatabaseSync(path)
    database.exec('PRAGMA foreign_keys = ON')
    initPersonalTwinSchema(database)
    const store = new HomeTwinStore(database)
    if (!store.getDevice('device:lamp')) {
      store.upsertDevice({ id: 'device:lamp', name: 'Office lamp', deviceClass: 'light', availability: 'available',
        expectedVersion: 0 })
      store.upsertBinding({ id: 'binding:lamp', deviceId: 'device:lamp', provider: 'home-assistant',
        externalId: 'light.office_lamp', capabilities: ['level', 'power'], metadata: { entityDomain: 'light' },
        expectedVersion: 0 })
    }
    return { store, close: () => database.close() }
  }

  function connectedObservation(value: ResolvedHomeAssistantConfig): HomeProductionObservation {
    const status: HomeAssistantRuntimeStatus = {
      provider: 'home-assistant', profile: value.profile, connectionStatus: 'connected', haVersion: '2026.7',
      reconnectAttempt: 0, rejectedEvents: 0, lastEventId: null, lastEventAt: null, lastErrorCode: null,
    }
    return {
      getStatus: () => ({ ...status }),
      run: signal => new Promise<void>(resolve => {
        if (signal.aborted) { abortedObservations += 1; resolve(); return }
        signal.addEventListener('abort', () => { abortedObservations += 1; resolve() }, { once: true })
      }),
    }
  }
})

function homeExecutor() {
  return listFabricExecutors().find(executor => executor.id === 'home-assistant')!
}

function client(): HomeProductionClient {
  return {
    fetchStates: async () => [],
    subscribeStateChanged: async () => { throw new Error('unused') },
    fetchState: async () => ({}),
    callService: async () => [],
  }
}

function config(credentialFingerprint: string): ResolvedHomeAssistantConfig {
  return {
    profile: 'default', baseUrl: 'http://homeassistant.local', restStatesUrl: 'http://homeassistant.local/api/states',
    websocketUrl: 'ws://homeassistant.local/api/websocket', token: 'not-exposed-in-runtime-status', credentialFingerprint,
    connectTimeoutMs: 10_000, requestTimeoutMs: 15_000, heartbeatIntervalMs: 30_000,
    reconnectInitialMs: 1_000, reconnectMaxMs: 30_000, maxWebSocketMessageBytes: 1_048_576,
    maxRestResponseBytes: 8_388_608, tlsVerify: true,
  }
}

function powerPolicyInput(idempotencyKey: string) {
  return {
    capabilityId: 'home.device.set_power', requestedByRoleId: 'home-manager', requestedByUserId: 'user-1',
    idempotencyKey, target: { kind: 'home_device', provider: 'home-assistant', deviceId: 'device:lamp',
      bindingId: 'binding:lamp', externalId: 'light.office_lamp' }, input: {
      schemaVersion: 1, provider: 'home-assistant', deviceId: 'device:lamp', bindingId: 'binding:lamp',
      externalId: 'light.office_lamp', expectedStateVersion: 1, verificationTimeoutMs: 30_000,
      desiredPower: true,
    }, constraints: {},
  }
}
