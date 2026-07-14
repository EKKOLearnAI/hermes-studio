import { describe, expect, it } from 'vitest'
import {
  HomeAssistantNormalizationError,
  normalizeHomeAssistantBootstrapState,
  normalizeHomeAssistantState,
  normalizeHomeAssistantStateChanged,
} from '../../packages/server/src/services/hermes/home/home-assistant-normalizer'

describe('home assistant normalizer', () => {
  it('normalizes a light into deterministic device, binding, capabilities, and state', () => {
    const raw = {
      entity_id: 'light.office_lamp',
      state: 'on',
      attributes: {
        friendly_name: 'Office Lamp', device_class: 'light', brightness: 128,
        supported_features: 40, area_id: 'office', irrelevant_blob: 'ignored',
      },
      last_changed: '2026-07-15T00:00:00+00:00',
      last_updated: '2026-07-15T00:00:01+00:00',
      context: { id: 'context-1', parent_id: null, user_id: null },
    }

    const normalized = normalizeHomeAssistantState(raw)
    expect(normalized).toMatchObject({
      provider: 'home-assistant', externalId: 'light.office_lamp', name: 'Office Lamp',
      deviceClass: 'light', availability: 'available', spaceExternalId: 'office',
      capabilities: ['level', 'power'],
      metadata: { entityDomain: 'light', sourceDeviceClass: 'light', areaId: 'office' },
    })
    expect(normalized.deviceId).toMatch(/^device:ha:[a-f0-9]{24}$/)
    expect(normalized.bindingId).toMatch(/^binding:ha:[a-f0-9]{24}$/)
    expect(normalized.states).toEqual([
      { key: 'level', value: 50.2, observedAt: '2026-07-15T00:00:01.000Z' },
      { key: 'power', value: true, observedAt: '2026-07-15T00:00:01.000Z' },
      { key: 'state', value: 'on', observedAt: '2026-07-15T00:00:01.000Z' },
    ])
    expect(JSON.stringify(normalized)).not.toContain('irrelevant_blob')
  })

  it('normalizes numeric sensors and unavailable state without inventing command capabilities', () => {
    const sensor = normalizeHomeAssistantState({
      entity_id: 'sensor.office_temperature', state: '23.5',
      attributes: { friendly_name: 'Office Temperature', device_class: 'temperature', unit_of_measurement: '°C' },
      last_changed: '2026-07-15T00:00:00Z', last_updated: '2026-07-15T00:00:00Z',
    })
    expect(sensor).toMatchObject({ deviceClass: 'temperature', capabilities: [], availability: 'available' })
    expect(sensor.states).toEqual([
      { key: 'state', value: '23.5', observedAt: '2026-07-15T00:00:00.000Z' },
      { key: 'value', value: 23.5, observedAt: '2026-07-15T00:00:00.000Z' },
    ])

    const unavailable = normalizeHomeAssistantState({
      entity_id: 'binary_sensor.office_motion', state: 'unavailable',
      attributes: { device_class: 'motion' },
      last_changed: '2026-07-15T00:00:00Z', last_updated: '2026-07-15T00:00:00Z',
    })
    expect(unavailable.availability).toBe('unavailable')
    expect(unavailable.capabilities).toEqual([])
  })

  it('produces stable bootstrap and state_changed event identities', () => {
    const state = {
      entity_id: 'switch.coffee_machine', state: 'on', attributes: { friendly_name: 'Coffee Machine' },
      last_changed: '2026-07-15T01:00:00Z', last_updated: '2026-07-15T01:00:00Z',
      context: { id: '01JZHOMEASSISTANTEVENT000001', parent_id: null, user_id: null },
    }
    const bootstrap = normalizeHomeAssistantBootstrapState(state, '2026-07-15T01:00:02Z')
    const rawEvent = {
      event_type: 'state_changed', time_fired: '2026-07-15T01:00:01Z',
      context: { id: '01JZHOMEASSISTANTEVENT000001', parent_id: null, user_id: null },
      data: { entity_id: 'switch.coffee_machine', old_state: null, new_state: state },
    }
    const first = normalizeHomeAssistantStateChanged(rawEvent, '2026-07-15T01:00:02Z')
    const replay = normalizeHomeAssistantStateChanged(rawEvent, '2026-07-15T01:05:00Z')

    expect(bootstrap.event.id).toMatch(/^event:ha:[a-f0-9]{24}$/)
    expect(first.event.id).toBe(replay.event.id)
    expect(first.event.eventId).toBe('01JZHOMEASSISTANTEVENT000001')
    expect(first.event.receivedAt).toBe('2026-07-15T01:00:02.000Z')
    expect(first.entity.capabilities).toEqual(['power'])
    expect(first.event.payload).toEqual({
      entityId: 'switch.coffee_machine', eventType: 'state_changed', removed: false,
      state: 'on', stateUpdatedAt: '2026-07-15T01:00:00.000Z',
    })
  })

  it.each([
    ['dangerous domain', {
      entity_id: 'camera.front_door', state: 'idle', attributes: {},
      last_changed: '2026-07-15T00:00:00Z', last_updated: '2026-07-15T00:00:00Z',
    }],
    ['command surface', {
      entity_id: 'light.office', state: 'on', attributes: { service: 'light.turn_off' },
      last_changed: '2026-07-15T00:00:00Z', last_updated: '2026-07-15T00:00:00Z',
    }],
    ['credential key', {
      entity_id: 'sensor.bad', state: 'ok', attributes: { access_token: 'do-not-store' },
      last_changed: '2026-07-15T00:00:00Z', last_updated: '2026-07-15T00:00:00Z',
    }],
    ['oversized value', {
      entity_id: 'sensor.large', state: 'x'.repeat(530_000), attributes: {},
      last_changed: '2026-07-15T00:00:00Z', last_updated: '2026-07-15T00:00:00Z',
    }],
  ])('rejects unsafe provider state: %s', (_name, value) => {
    expect(() => normalizeHomeAssistantState(value)).toThrow(HomeAssistantNormalizationError)
  })

  it('rejects poison keys and mismatched state_changed entity identities', () => {
    const poisoned = JSON.parse(`{
      "entity_id":"sensor.poison","state":"ok","last_changed":"2026-07-15T00:00:00Z",
      "last_updated":"2026-07-15T00:00:00Z","attributes":{"__proto__":{"polluted":true}}
    }`) as unknown
    expect(() => normalizeHomeAssistantState(poisoned)).toThrow(/unsafe/i)
    expect(() => normalizeHomeAssistantStateChanged({
      event_type: 'state_changed', time_fired: '2026-07-15T01:00:01Z',
      data: {
        entity_id: 'switch.one', old_state: null,
        new_state: {
          entity_id: 'switch.two', state: 'on', attributes: {},
          last_changed: '2026-07-15T01:00:00Z', last_updated: '2026-07-15T01:00:00Z',
        },
      },
    }, '2026-07-15T01:00:02Z')).toThrow(/identity/i)
  })
})
