import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HomeAssistantClientError,
  HomeAssistantRuntime,
  type HomeAssistantRuntimeClient,
  type HomeAssistantStateSubscription,
  HomeTwinStore,
  resolveHomeAssistantConfigMaterial,
} from '../../packages/server/src/services/hermes/home'
import { initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin'

interface FakeCycle {
  emit(event: Record<string, unknown>): void
  disconnect(): void
  pingCount(): number
}

class FakeHomeAssistantClient implements HomeAssistantRuntimeClient {
  readonly cycles: FakeCycle[] = []
  fetchCount = 0

  constructor(private readonly states: unknown[]) {}

  async fetchStates(): Promise<unknown[]> {
    this.fetchCount += 1
    return this.states
  }

  async subscribeStateChanged(
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<HomeAssistantStateSubscription> {
    let settled = false
    let pings = 0
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
    this.cycles.push({
      emit: event => onEvent(event),
      disconnect: () => settle({ clean: false, code: 'HOME_ASSISTANT_WS_CLOSED' }),
      pingCount: () => pings,
    })
    return {
      haVersion: '2026.7.1',
      closed,
      ping: async pingSignal => {
        if (pingSignal?.aborted) throw new HomeAssistantClientError('HOME_ASSISTANT_ABORTED')
        pings += 1
      },
      close: async () => settle({ clean: true, code: null }),
    }
  }
}

describe('home assistant durable runtime', () => {
  let db: DatabaseSync
  let store: HomeTwinStore

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)
    store = new HomeTwinStore(db)
  })

  afterEach(() => db.close())

  it('bootstraps, observes, heartbeats, reconnects, and deduplicates restart replay', async () => {
    const bootstrapState = state('light.office_lamp', 'off', '2026-07-15T00:00:00Z', {
      friendly_name: 'Office Lamp', brightness: 0, area_id: 'office', supported_features: 40,
    })
    const client = new FakeHomeAssistantClient([
      bootstrapState,
      state('camera.front_door', 'idle', '2026-07-15T00:00:00Z', {}),
    ])
    const delays: number[] = []
    let releasedHeartbeat = false
    const wait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
      if (milliseconds === 5_000 && !releasedHeartbeat) {
        releasedHeartbeat = true
        return
      }
      if (milliseconds === 250) {
        delays.push(milliseconds)
        return
      }
      await waitForAbort(signal)
    }
    let clock = Date.parse('2026-07-15T00:00:10Z')
    const config = resolveHomeAssistantConfigMaterial('runtime-test', {
      home_assistant: {
        base_url: 'http://127.0.0.1:8123', token: 'runtime-test-token-not-secret',
        heartbeat_interval_ms: 5_000, reconnect_initial_ms: 250, reconnect_max_ms: 1_000,
      },
    }, {})
    expect(config).not.toBeNull()
    const runtime = new HomeAssistantRuntime(config!, store, {
      client,
      wait,
      now: () => new Date(clock += 1_000).toISOString(),
    })
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await waitUntil(() => client.cycles.length === 1 && runtime.getStatus().connectionStatus === 'connected')
    await waitUntil(() => client.cycles[0].pingCount() === 1)
    expect(store.listDevices()).toEqual([expect.objectContaining({
      name: 'Office Lamp', spaceId: expect.stringMatching(/^space:ha:/), availability: 'available',
    })])
    expect(store.listBindings({ provider: 'home-assistant' })).toEqual([
      expect.objectContaining({ externalId: 'light.office_lamp', capabilities: ['level', 'power'] }),
    ])
    expect(runtime.getStatus().rejectedEvents).toBe(1)

    const changed = {
      event_type: 'state_changed', time_fired: '2026-07-15T00:01:01Z',
      context: { id: '01JZHOMEASSISTANTRUNTIME00001' },
      data: {
        entity_id: 'light.office_lamp', old_state: bootstrapState,
        new_state: state('light.office_lamp', 'on', '2026-07-15T00:01:00Z', {
          friendly_name: 'Office Lamp', brightness: 128, area_id: 'office', supported_features: 40,
        }),
      },
    }
    client.cycles[0].emit(changed)
    await waitUntil(() => providerEventCount(db) === 2)
    expect(store.listDeviceStates({ key: 'power' })).toEqual([
      expect.objectContaining({ value: true, version: 2 }),
    ])

    client.cycles[0].disconnect()
    await waitUntil(() => client.cycles.length === 2 && runtime.getStatus().connectionStatus === 'connected')
    expect(client.fetchCount).toBe(2)
    expect(delays).toEqual([250])
    expect(providerEventCount(db)).toBe(2)
    const cursorVersion = store.getProviderCursor('home-assistant')!.version

    client.cycles[1].emit(changed)
    await waitUntil(() => store.getProviderCursor('home-assistant')!.version > cursorVersion)
    expect(providerEventCount(db)).toBe(2)
    expect(store.listDeviceStates({ key: 'power' })[0]).toMatchObject({ value: true, version: 2 })
    const persisted = JSON.stringify(store.getProviderCursor('home-assistant'))
    expect(persisted).not.toContain(config!.token)
    expect(persisted).not.toContain('credentialFingerprint')

    controller.abort()
    await running
    expect(runtime.getStatus()).toMatchObject({ connectionStatus: 'disconnected', lastErrorCode: null })
    const restarted = new HomeAssistantRuntime(config!, store, { client })
    expect(restarted.getStatus()).toMatchObject({
      connectionStatus: 'disconnected', lastEventId: '01JZHOMEASSISTANTRUNTIME00001',
      lastEventAt: '2026-07-15T00:01:01.000Z', rejectedEvents: 2,
    })
  })
})

function state(entityId: string, value: string, updatedAt: string, attributes: Record<string, unknown>) {
  return {
    entity_id: entityId, state: value, attributes,
    last_changed: updatedAt, last_updated: updatedAt,
  }
}

function providerEventCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM twin_home_provider_events').get() as { count: number }).count
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime state')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED')), { once: true })
  })
}
