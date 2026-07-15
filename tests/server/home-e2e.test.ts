import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approveFabricWorkflow,
  createFabricIntent,
  ensureBuiltInFabricRegistry,
  getFabricWorkflow,
  processActionFabricOnce,
  registerFabricExecutorAdapter,
  setFabricEmergencyStop,
  setFabricExecutorEnabled,
  unregisterFabricExecutorAdapter,
  updateFabricExecutorHealth,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  clearHomeManagerAuthorization,
  createHomeAssistantCommandExecutorAdapter,
  HomeAssistantClientError,
  HomeAssistantRuntime,
  HomeTwinStore,
  mapHomeAssistantCommand,
  refreshHomeManagerAuthorization,
  type HomeAssistantRuntimeClient,
  type HomeAssistantStateSubscription,
  type ResolvedHomeAssistantConfig,
} from '../../packages/server/src/services/hermes/home'
import { getPersonalTwinDbPath, initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin/database'

interface ObservationCycle {
  emit(event: Record<string, unknown>): void
  disconnect(): void
}

class FakeHomeAssistant implements HomeAssistantRuntimeClient {
  readonly cycles: ObservationCycle[] = []
  serviceCalls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = []
  failTransport = false
  fetchCount = 0
  private readback = entity('light.office_lamp', 'off', '2026-07-15T00:00:00.000Z')

  async fetchStates(): Promise<unknown[]> {
    this.fetchCount += 1
    return [this.readback, entity('lock.front_door', 'locked', '2026-07-15T00:00:00.000Z')]
  }

  async subscribeStateChanged(onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal): Promise<HomeAssistantStateSubscription> {
    let settled = false
    let resolveClosed!: (value: { clean: boolean; code: null | 'HOME_ASSISTANT_ABORTED' | 'HOME_ASSISTANT_WS_CLOSED' }) => void
    const closed = new Promise<{ clean: boolean; code: null | 'HOME_ASSISTANT_ABORTED' | 'HOME_ASSISTANT_WS_CLOSED' }>(
      resolve => { resolveClosed = resolve },
    )
    const settle = (value: { clean: boolean; code: null | 'HOME_ASSISTANT_ABORTED' | 'HOME_ASSISTANT_WS_CLOSED' }) => {
      if (settled) return
      settled = true
      resolveClosed(value)
    }
    const abort = () => settle({ clean: false, code: 'HOME_ASSISTANT_ABORTED' })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    this.cycles.push({ emit: onEvent, disconnect: () => settle({ clean: false, code: 'HOME_ASSISTANT_WS_CLOSED' }) })
    return {
      haVersion: '2026.7-e2e', closed,
      ping: async pingSignal => { if (pingSignal?.aborted) throw new HomeAssistantClientError('HOME_ASSISTANT_ABORTED') },
      close: async () => settle({ clean: true, code: null }),
    }
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown[]> {
    this.serviceCalls.push({ domain, service, data })
    if (this.failTransport) throw new Error('socket detail must remain private')
    const state = service === 'turn_on' ? 'on' : 'off'
    this.readback = entity('light.office_lamp', state, new Date(Date.now() + 60_000).toISOString())
    return []
  }

  async fetchState(): Promise<unknown> {
    if (this.failTransport) throw new Error('socket detail must remain private')
    return this.readback
  }
}

describe('Phase 5 home closed loop', () => {
  const originalHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''
  let database: DatabaseSync | null = null
  let running: Promise<void> | null = null
  let observationAbort: AbortController | null = null

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'home-loop-e2e-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'home-e2e-managed-audit-key-at-least-32-bytes'
    const path = getPersonalTwinDbPath()
    mkdirSync(join(path, '..'), { recursive: true })
    database = new DatabaseSync(path)
    database.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(database)
    ensureBuiltInFabricRegistry()
    unregisterFabricExecutorAdapter('home-assistant')
  })

  afterEach(async () => {
    observationAbort?.abort()
    await running
    unregisterFabricExecutorAdapter('home-assistant')
    database?.close()
    database = null
    running = null
    observationAbort = null
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    rmSync(home, { recursive: true, force: true })
  })

  it('observes, replays, approves, verifies, fails uncertain commands closed, and honors revocation controls', async () => {
    const store = new HomeTwinStore(database!)
    const fake = new FakeHomeAssistant()
    const runtime = new HomeAssistantRuntime(config(), store, {
      client: fake,
      wait: async (milliseconds, signal) => {
        if (milliseconds === 250) return
        await waitForAbort(signal)
      },
      now: () => new Date().toISOString(),
    })
    observationAbort = new AbortController()
    running = runtime.run(observationAbort.signal)
    await waitUntil(() => fake.cycles.length === 1 && runtime.getStatus().connectionStatus === 'connected')

    const device = store.listDevices()[0]
    const binding = store.listBindings({ deviceId: device.id })[0]
    expect(binding).toMatchObject({ externalId: 'light.office_lamp', capabilities: ['level', 'power'] })
    expect(runtime.getStatus().rejectedEvents).toBe(1)
    expect(store.listBindings({ provider: 'home-assistant' }).some(item => item.externalId === 'lock.front_door')).toBe(false)
    expect(() => mapHomeAssistantCommand('home.device.set_power', {
      externalId: 'lock.front_door', desiredPower: false, expectedStateVersion: 0,
    }, {})).toThrow(/DENIED/)

    const initialState = store.listDeviceStates({ deviceId: device.id, key: 'power' })[0]
    const changed = stateChanged('event-live-e2e', 'on', new Date(Date.now() + 10_000).toISOString())
    fake.cycles[0].emit(changed)
    await waitUntil(() => store.listDeviceStates({ deviceId: device.id, key: 'power' })[0].version > initialState.version)
    expect(store.listDeviceStates({ deviceId: device.id, key: 'power' })[0].value).toBe(true)
    const eventCount = providerEventCount(database!)

    fake.cycles[0].disconnect()
    await waitUntil(() => fake.cycles.length === 2 && runtime.getStatus().connectionStatus === 'connected')
    const stateVersion = store.listDeviceStates({ deviceId: device.id, key: 'power' })[0].version
    const cursorVersion = store.getProviderCursor('home-assistant')!.version
    fake.cycles[1].emit(changed)
    await waitUntil(() => store.getProviderCursor('home-assistant')!.version > cursorVersion)
    expect(providerEventCount(database!)).toBe(eventCount)
    expect(store.listDeviceStates({ deviceId: device.id, key: 'power' })[0].version).toBe(stateVersion)
    expect(fake.fetchCount).toBe(2)
    expect(runtime.getStatus().rejectedEvents).toBe(2)

    refreshHomeManagerAuthorization(store)
    setFabricExecutorEnabled('home-assistant', true)
    updateFabricExecutorHealth('home-assistant', 'healthy', { connectionStatus: 'connected' })
    registerFabricExecutorAdapter(createHomeAssistantCommandExecutorAdapter({ store, transport: fake }))
    const verified = createFabricIntent(powerIntent(device.id, binding.id, binding.externalId, stateVersion,
      false, 'home-e2e-verified'))
    expect(verified.policyDecision).toMatchObject({ outcome: 'waiting_user' })
    expect(approveFabricWorkflow(verified.workflow.id, 'user-e2e').state).toBe('preparing')
    await runWorkflow(verified.workflow.id)
    expect(getFabricWorkflow(verified.workflow.id)).toMatchObject({ state: 'succeeded' })
    expect(store.listDeviceStates({ deviceId: device.id, key: 'power' })[0]).toMatchObject({ value: false })
    expect(fake.serviceCalls).toEqual([{
      domain: 'light', service: 'turn_off', data: { entity_id: 'light.office_lamp' },
    }])
    const replay = createFabricIntent(powerIntent(device.id, binding.id, binding.externalId, stateVersion,
      false, 'home-e2e-verified'))
    expect(replay.workflow.id).toBe(verified.workflow.id)
    expect(fake.serviceCalls).toHaveLength(1)

    fake.failTransport = true
    const currentVersion = store.listDeviceStates({ deviceId: device.id, key: 'power' })[0].version
    const uncertain = createFabricIntent(powerIntent(device.id, binding.id, binding.externalId, currentVersion,
      true, 'home-e2e-uncertain'))
    approveFabricWorkflow(uncertain.workflow.id, 'user-e2e')
    await processActionFabricOnce({ workerId: 'home-e2e-worker', now: new Date() })
    await processActionFabricOnce({ workerId: 'home-e2e-worker', now: new Date(Date.now() + 1_000) })
    expect(getFabricWorkflow(uncertain.workflow.id)).toMatchObject({
      state: 'waiting_user', lastErrorCode: 'FABRIC_EXECUTION_OUTCOME_UNKNOWN',
    })
    expect(fake.serviceCalls).toHaveLength(2)
    await processActionFabricOnce({ workerId: 'home-e2e-worker', now: new Date(Date.now() + 2_000) })
    expect(fake.serviceCalls).toHaveLength(2)

    clearHomeManagerAuthorization()
    setFabricExecutorEnabled('home-assistant', false)
    expect(createFabricIntent(powerIntent(device.id, binding.id, binding.externalId, currentVersion,
      true, 'home-e2e-revoked')).policyDecision).toMatchObject({ outcome: 'deny' })

    refreshHomeManagerAuthorization(store)
    setFabricExecutorEnabled('home-assistant', true)
    setFabricEmergencyStop(3, 'admin-e2e', 'stop external home writes')
    expect(createFabricIntent(powerIntent(device.id, binding.id, binding.externalId, currentVersion,
      true, 'home-e2e-emergency')).policyDecision).toMatchObject({ outcome: 'deny', reasonCodes: ['emergency_stop'] })
    const exposedState = JSON.stringify({ status: runtime.getStatus(), workflow: getFabricWorkflow(uncertain.workflow.id) })
    expect(exposedState).not.toContain('socket detail')
    expect(exposedState).not.toContain('fake-home-e2e-credential')
    expect(exposedState).not.toContain('home-e2e-managed-audit-key-at-least-32-bytes')
  }, 20_000)
})

function powerIntent(deviceId: string, bindingId: string, externalId: string, expectedStateVersion: number,
  desiredPower: boolean, idempotencyKey: string) {
  return {
    capabilityId: 'home.device.set_power', requestedByRoleId: 'home-manager', requestedByUserId: 'user-e2e',
    idempotencyKey, goal: 'Apply one exact approved home power command', environments: ['production'] as const,
    target: { kind: 'home_device', provider: 'home-assistant', deviceId, bindingId, externalId },
    input: { schemaVersion: 1, provider: 'home-assistant', deviceId, bindingId, externalId,
      expectedStateVersion, verificationTimeoutMs: 30_000, desiredPower },
    constraints: {}, rationale: 'Phase 5 synthetic closed-loop test',
  }
}

async function runWorkflow(id: string): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await processActionFabricOnce({ workerId: 'home-e2e-worker', now: new Date(Date.now() + index * 1_000) })
  }
  const workflow = getFabricWorkflow(id)
  if (workflow?.state !== 'succeeded') throw new Error('HOME_E2E_WORKFLOW_NOT_SUCCEEDED')
}

function entity(entityId: string, state: string, updatedAt: string) {
  return { entity_id: entityId, state, attributes: entityId.startsWith('light.')
    ? { friendly_name: 'Office Lamp', brightness: state === 'on' ? 255 : 0, supported_features: 40 }
    : { friendly_name: 'Front Door' }, last_changed: updatedAt, last_updated: updatedAt }
}

function stateChanged(eventId: string, state: 'on' | 'off', updatedAt: string) {
  return { event_type: 'state_changed', time_fired: updatedAt, context: { id: eventId }, data: {
    entity_id: 'light.office_lamp', old_state: entity('light.office_lamp', state === 'on' ? 'off' : 'on', updatedAt),
    new_state: entity('light.office_lamp', state, updatedAt),
  } }
}

function config(): ResolvedHomeAssistantConfig {
  return { profile: 'default', baseUrl: 'http://127.0.0.1:8123', restStatesUrl: 'http://127.0.0.1:8123/api/states',
    websocketUrl: 'ws://127.0.0.1:8123/api/websocket', token: 'fake-home-e2e-credential',
    credentialFingerprint: 'e2e-fingerprint', connectTimeoutMs: 1_000, requestTimeoutMs: 1_000,
    heartbeatIntervalMs: 5_000, reconnectInitialMs: 250, reconnectMaxMs: 1_000,
    maxWebSocketMessageBytes: 1_048_576, maxRestResponseBytes: 1_048_576, tlsVerify: true }
}

function providerEventCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS count FROM twin_home_provider_events').get() as { count: number }).count)
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('HOME_E2E_WAIT_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
  return new Promise((_resolve, reject) => signal.addEventListener('abort',
    () => reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED')), { once: true }))
}
