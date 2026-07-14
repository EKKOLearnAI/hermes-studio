import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureBuiltInFabricRegistry,
  getFabricCapability,
  listFabricCapabilities,
  validateFabricSchema,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  assertHomeCapabilityBindingAllowed,
  HOME_FABRIC_CAPABILITIES,
  homeTargetAtoms,
} from '../../packages/server/src/services/hermes/home'

describe('home action fabric contracts', () => {
  const originalHome = process.env.HERMES_HOME
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hermes-home-fabric-'))
    process.env.HERMES_HOME = directory
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(directory, { recursive: true, force: true })
  })

  it('registers five exact governed capabilities with bounded schemas and verification', () => {
    ensureBuiltInFabricRegistry()
    expect(listFabricCapabilities().filter(item => item.id.startsWith('home.')).map(item => ({
      id: item.id, risk: item.risk, sideEffect: item.sideEffect, idempotency: item.idempotency,
      reversible: item.reversible, verification: item.verificationStrategy,
    }))).toEqual([
      { id: 'home.device.refresh', risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, verification: 'provider_state_snapshot' },
      { id: 'home.device.set_level', risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, verification: 'subsequent_provider_state_match' },
      { id: 'home.device.set_power', risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, verification: 'subsequent_provider_state_match' },
      { id: 'home.device.set_temperature', risk: 'medium', sideEffect: true, idempotency: 'required', reversible: false, verification: 'subsequent_provider_state_match' },
      { id: 'home.scene.activate.safe', risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, verification: 'bounded_scene_state_readback' },
    ])
    expect(HOME_FABRIC_CAPABILITIES).toHaveLength(5)

    const power = getFabricCapability('home.device.set_power')!
    const valid = commandInput({ desiredPower: true })
    expect(validateFabricSchema(valid, power.inputSchema)).toBe(true)
    expect(validateFabricSchema({ ...valid, service: 'light.turn_on' }, power.inputSchema)).toBe(false)
    expect(validateFabricSchema({ ...valid, service_data: {} }, power.inputSchema)).toBe(false)
    expect(power.authentication).toEqual([
      'home_provider:configured', 'home_external_writes:enabled', 'user_approval:required',
    ])
    expect(power.targetRestrictions).toEqual(['home:binding', 'home:device', 'home:provider'])
  })

  it('derives exact target atoms and denies dangerous or mismatched provider identities', () => {
    const input = commandInput({ desiredPower: false })
    const target = {
      kind: 'home_device', provider: 'home-assistant', deviceId: 'device:lamp',
      bindingId: 'binding:lamp', externalId: 'light.office_lamp',
    }
    expect(homeTargetAtoms('home.device.set_power', target, input)).toEqual([
      'home:provider:home-assistant',
      'home:device:device:lamp',
      'home:binding:home-assistant:light.office_lamp',
    ])
    expect(homeTargetAtoms('home.device.set_power', { ...target, externalId: 'switch.other' }, input)).toBeNull()
    expect(() => assertHomeCapabilityBindingAllowed('home.device.set_power', 'lock.front_door', {})).toThrow(/denied/i)
    expect(() => assertHomeCapabilityBindingAllowed('home.device.set_level', 'cover.garage_door', {})).toThrow(/denied/i)
    expect(() => assertHomeCapabilityBindingAllowed('home.device.refresh', 'camera.front_door', {})).toThrow(/denied/i)
    expect(() => assertHomeCapabilityBindingAllowed('home.scene.activate.safe', 'scene.evening', {})).toThrow(/SAFE_SCENE/i)
    expect(() => assertHomeCapabilityBindingAllowed('home.scene.activate.safe', 'scene.evening', { safeScene: true })).not.toThrow()
  })
})

function commandInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: 'home-assistant',
    deviceId: 'device:lamp',
    bindingId: 'binding:lamp',
    externalId: 'light.office_lamp',
    expectedStateVersion: 4,
    verificationTimeoutMs: 30_000,
    ...overrides,
  }
}
