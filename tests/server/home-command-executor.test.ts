import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FabricExecutionContext } from '../../packages/server/src/services/hermes/action-fabric/executors'
import {
  createHomeAssistantCommandExecutorAdapter,
  HomeTwinStore,
  mapHomeAssistantCommand,
  normalizeHomeAssistantBootstrapState,
  type HomeAssistantCommandTransport,
} from '../../packages/server/src/services/hermes/home'
import { initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin'

class FakeTransport implements HomeAssistantCommandTransport {
  readonly calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = []
  readback: unknown = null
  fail = false

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown[]> {
    this.calls.push({ domain, service, data })
    if (this.fail) throw new Error('network detail must not escape')
    return [{ entity_id: 'unrelated.entity', state: 'changed' }]
  }

  async fetchState(): Promise<unknown> {
    if (this.fail) throw new Error('network detail must not escape')
    return this.readback
  }
}

describe('home assistant command executor', () => {
  let db: DatabaseSync
  let store: HomeTwinStore
  let transport: FakeTransport
  let identity: ReturnType<typeof normalizeHomeAssistantBootstrapState>['entity']

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)
    store = new HomeTwinStore(db)
    transport = new FakeTransport()
    const initial = normalizeHomeAssistantBootstrapState(state('off', '2026-07-15T00:00:00Z'), '2026-07-15T00:00:01Z')
    identity = initial.entity
    store.upsertDevice({
      id: identity.deviceId, name: identity.name, deviceClass: identity.deviceClass,
      availability: identity.availability, attributes: identity.attributes, expectedVersion: 0,
    })
    store.upsertBinding({
      id: identity.bindingId, deviceId: identity.deviceId, provider: identity.provider,
      externalId: identity.externalId, capabilities: identity.capabilities, metadata: identity.metadata, expectedVersion: 0,
    })
    store.applyDeviceStateEvent({
      event: initial.event,
      states: identity.states.map(item => ({ deviceId: identity.deviceId, ...item })),
    })
  })

  afterEach(() => db.close())

  it('maps one exact service, persists a receipt, and verifies only from a subsequent readback event', async () => {
    const adapter = createHomeAssistantCommandExecutorAdapter({ store, transport })
    const context = commandContext(identity, 'execution-power-1', true, 1)
    const prepared = await adapter.prepare(context)
    expect(prepared).toMatchObject({ outcome: 'prepared', errorCode: null })

    const executed = await adapter.execute({ ...context, preparedOutput: prepared.output })
    expect(executed).toMatchObject({ outcome: 'succeeded', output: { status: 'unknown' } })
    expect(transport.calls).toEqual([{
      domain: 'light', service: 'turn_on', data: { entity_id: 'light.office_lamp' },
    }])
    const sent = store.getCommandReceipt(context.executionToken)!
    expect(sent).toMatchObject({ status: 'sent', operation: 'home.device.set_power', observedEventId: null })
    expect(JSON.stringify(sent)).not.toContain('unrelated.entity')

    const observedAt = new Date(Math.max(Date.parse(sent.createdAt), Date.parse('2026-07-15T00:00:00Z')) + 1_000).toISOString()
    transport.readback = state('on', observedAt)
    const verified = await adapter.verify({
      ...context, preparedOutput: prepared.output, executionOutput: executed.output,
    })
    expect(verified).toMatchObject({ outcome: 'verified', output: { status: 'verified' } })
    expect(store.getCommandReceipt(context.executionToken)).toMatchObject({
      status: 'verified', observedEventId: expect.stringMatching(/^event:ha:/), verifiedAt: expect.any(String),
    })
    expect(store.listDeviceStates({ deviceId: identity.deviceId, key: 'power' })[0]).toMatchObject({ value: true, version: 2 })

    const replay = await adapter.execute({ ...context, preparedOutput: prepared.output })
    expect(replay).toMatchObject({ outcome: 'succeeded', output: { status: 'verified' } })
    expect(transport.calls).toHaveLength(1)
  })

  it('records an uncertain transport outcome and never blindly resends the execution token', async () => {
    const adapter = createHomeAssistantCommandExecutorAdapter({ store, transport })
    const context = commandContext(identity, 'execution-power-uncertain', true, 1)
    const prepared = await adapter.prepare(context)
    transport.fail = true

    const first = await adapter.execute({ ...context, preparedOutput: prepared.output })
    expect(first).toMatchObject({ outcome: 'unknown', errorCode: 'HOME_COMMAND_TRANSPORT_UNCERTAIN', safeToRetry: false })
    expect(store.getCommandReceipt(context.executionToken)).toMatchObject({ status: 'unknown' })
    const replay = await adapter.execute({ ...context, preparedOutput: prepared.output })
    expect(replay).toMatchObject({ outcome: 'unknown', errorCode: 'HOME_COMMAND_OUTCOME_UNCERTAIN' })
    expect(transport.calls).toHaveLength(1)
  })

  it('maps bounded semantic values and rejects dangerous domains before transport', () => {
    expect(mapHomeAssistantCommand('home.device.set_level', {
      externalId: 'light.office_lamp', desiredLevel: 42.5, expectedStateVersion: 1,
    }, {})).toEqual({
      domain: 'light', service: 'turn_on', data: { entity_id: 'light.office_lamp', brightness_pct: 42.5 },
      expectedState: { key: 'level', value: 42.5, tolerance: 0.5, expectedVersion: 1 },
    })
    expect(() => mapHomeAssistantCommand('home.device.set_power', {
      externalId: 'lock.front_door', desiredPower: true, expectedStateVersion: 0,
    }, {})).toThrow(/DENIED/i)
  })
})

function commandContext(
  identity: ReturnType<typeof normalizeHomeAssistantBootstrapState>['entity'],
  executionToken: string,
  desiredPower: boolean,
  expectedStateVersion: number,
): FabricExecutionContext {
  const input = {
    schemaVersion: 1, provider: 'home-assistant', deviceId: identity.deviceId, bindingId: identity.bindingId,
    externalId: identity.externalId, expectedStateVersion, verificationTimeoutMs: 30_000, desiredPower,
  }
  return {
    intentId: 'intent:home:1', workflowId: 'workflow:home:1', stepId: 'step:home:1',
    executorId: 'home-assistant', executorType: 'connector', capabilityId: 'home.device.set_power',
    capabilityVersion: 1, contractDigest: 'a'.repeat(64), policyEvaluationToken: 'policy-home-1',
    executionToken, input,
    target: {
      kind: 'home_device', provider: 'home-assistant', deviceId: identity.deviceId,
      bindingId: identity.bindingId, externalId: identity.externalId,
    },
    now: '2026-07-15T00:00:02.000Z',
  }
}

function state(power: 'on' | 'off', updatedAt: string) {
  return {
    entity_id: 'light.office_lamp', state: power,
    attributes: { friendly_name: 'Office Lamp', brightness: power === 'on' ? 255 : 0, supported_features: 40 },
    last_changed: updatedAt, last_updated: updatedAt,
  }
}
