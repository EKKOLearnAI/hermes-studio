import type { FabricCapabilityInput } from '../action-fabric/registry'
import type { FabricJsonObject } from '../action-fabric/types'

const HOME_PROVIDER = 'home-assistant'
const DEVICE_CAPABILITIES = new Set([
  'home.device.refresh', 'home.device.set_power', 'home.device.set_level', 'home.device.set_temperature',
])
const OBSERVABLE_DOMAINS = new Set(['binary_sensor', 'climate', 'fan', 'humidifier', 'light', 'sensor', 'switch'])
const WRITABLE_DOMAINS: Record<string, Set<string>> = {
  'home.device.set_power': new Set(['fan', 'humidifier', 'light', 'switch']),
  'home.device.set_level': new Set(['fan', 'humidifier', 'light']),
  'home.device.set_temperature': new Set(['climate']),
}
const ENTITY_ID = /^([a-z0-9_]{1,64})\.([a-z0-9_]{1,190})$/

function objectSchema(properties: Record<string, unknown>, required: string[]): FabricJsonObject {
  return { type: 'object', additionalProperties: false, properties, required }
}

const semanticId = { type: 'string', minLength: 3, maxLength: 160, pattern: '^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$' }
const externalId = { type: 'string', minLength: 3, maxLength: 255, pattern: '^[a-z0-9_]{1,64}\\.[a-z0-9_]{1,190}$' }
const commandBase = {
  schemaVersion: { const: 1 }, provider: { const: HOME_PROVIDER }, deviceId: semanticId,
  bindingId: semanticId, externalId, expectedStateVersion: { type: 'integer', minimum: 0 },
  verificationTimeoutMs: { type: 'integer', minimum: 1_000, maximum: 120_000 },
}
const commandRequired = [
  'schemaVersion', 'provider', 'deviceId', 'bindingId', 'externalId', 'expectedStateVersion', 'verificationTimeoutMs',
]
const commandOutput = objectSchema({
  schemaVersion: { const: 1 }, receiptId: semanticId, deviceId: semanticId, bindingId: semanticId,
  status: { enum: ['verified', 'unknown', 'failed'] },
  providerRequestId: { type: ['string', 'null'], minLength: 1, maxLength: 255 },
  observedEventId: { type: ['string', 'null'], minLength: 1, maxLength: 160 },
  finalState: { type: 'object' },
}, ['schemaVersion', 'receiptId', 'deviceId', 'bindingId', 'status', 'providerRequestId', 'observedEventId', 'finalState'])
const governedWrite = {
  version: 1, outputSchema: commandOutput, sideEffect: true, idempotency: 'required' as const,
  reversible: false, compensationCapabilityId: null,
  authentication: ['home_provider:configured', 'home_external_writes:enabled', 'user_approval:required'],
  targetRestrictions: ['home:binding', 'home:device', 'home:provider'],
  cost: { currency: null, estimatedMinor: 0 }, enabled: true,
}

export const HOME_FABRIC_CAPABILITIES: FabricCapabilityInput[] = [
  {
    id: 'home.device.refresh', version: 1,
    description: 'Refresh one exact allowlisted Home Assistant entity into normalized Home Twin state',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, provider: { const: HOME_PROVIDER }, deviceId: semanticId,
      bindingId: semanticId, externalId, requestedAt: { type: 'string', format: 'date-time', maxLength: 64 },
    }, ['schemaVersion', 'provider', 'deviceId', 'bindingId', 'externalId', 'requestedAt']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 }, deviceId: semanticId, bindingId: semanticId,
      status: { enum: ['succeeded', 'partial', 'failed'] },
      observedEventIds: { type: 'array', maxItems: 64, items: semanticId },
    }, ['schemaVersion', 'deviceId', 'bindingId', 'status', 'observedEventIds']),
    risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'provider_state_snapshot', authentication: ['home_provider:configured'],
    targetRestrictions: ['home:binding', 'home:device', 'home:provider'],
    cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    ...governedWrite, id: 'home.device.set_level',
    description: 'Set a bounded normalized level on one exact allowlisted Home Assistant binding',
    inputSchema: objectSchema({ ...commandBase, desiredLevel: { type: 'number', minimum: 0, maximum: 100 } },
      [...commandRequired, 'desiredLevel']),
    risk: 'low', verificationStrategy: 'subsequent_provider_state_match',
  },
  {
    ...governedWrite, id: 'home.device.set_power',
    description: 'Set normalized power on one exact allowlisted Home Assistant binding',
    inputSchema: objectSchema({ ...commandBase, desiredPower: { type: 'boolean' } }, [...commandRequired, 'desiredPower']),
    risk: 'low', verificationStrategy: 'subsequent_provider_state_match',
  },
  {
    ...governedWrite, id: 'home.device.set_temperature',
    description: 'Set a bounded temperature on one exact allowlisted Home Assistant climate binding',
    inputSchema: objectSchema({ ...commandBase, desiredTemperatureC: { type: 'number', minimum: 5, maximum: 35 } },
      [...commandRequired, 'desiredTemperatureC']),
    risk: 'medium',
    authentication: ['home_provider:configured', 'home_external_writes:enabled', 'user_approval:always'],
    verificationStrategy: 'subsequent_provider_state_match',
  },
  {
    ...governedWrite, id: 'home.scene.activate.safe',
    description: 'Activate one exact scene binding explicitly classified as non-security safe',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, provider: { const: HOME_PROVIDER }, sceneId: semanticId,
      bindingId: semanticId, externalId, safeScene: { const: true },
      verificationTimeoutMs: { type: 'integer', minimum: 1_000, maximum: 120_000 },
    }, ['schemaVersion', 'provider', 'sceneId', 'bindingId', 'externalId', 'safeScene', 'verificationTimeoutMs']),
    risk: 'low', targetRestrictions: ['home:binding', 'home:provider', 'home:scene'],
    verificationStrategy: 'bounded_scene_state_readback',
  },
]

export function isHomeCapability(capabilityId: string): boolean {
  return HOME_FABRIC_CAPABILITIES.some(capability => capability.id === capabilityId)
}

export function assertHomeCapabilityBindingAllowed(
  capabilityId: string,
  value: string,
  metadata: Record<string, unknown>,
): void {
  const match = ENTITY_ID.exec(value)
  if (!match) throw new Error('HOME_CAPABILITY_BINDING_DENIED')
  const domain = match[1]
  if (capabilityId === 'home.scene.activate.safe') {
    if (domain !== 'scene') throw new Error('HOME_CAPABILITY_BINDING_DENIED')
    if (metadata.safeScene !== true) throw new Error('HOME_CAPABILITY_SAFE_SCENE_REQUIRED')
    return
  }
  if (capabilityId === 'home.device.refresh') {
    if (!OBSERVABLE_DOMAINS.has(domain)) throw new Error('HOME_CAPABILITY_BINDING_DENIED')
    return
  }
  if (!WRITABLE_DOMAINS[capabilityId]?.has(domain)) throw new Error('HOME_CAPABILITY_BINDING_DENIED')
}

export function homeTargetAtoms(
  capabilityId: string,
  target: FabricJsonObject,
  input: FabricJsonObject,
): string[] | null {
  if (!isHomeCapability(capabilityId) || !plain(target) || !plain(input) || input.provider !== HOME_PROVIDER) return null
  if (DEVICE_CAPABILITIES.has(capabilityId)) {
    const expected = { kind: 'home_device', provider: HOME_PROVIDER,
      deviceId: input.deviceId, bindingId: input.bindingId, externalId: input.externalId }
    if (!exact(target, expected) || typeof input.externalId !== 'string') return null
    try { assertHomeCapabilityBindingAllowed(capabilityId, input.externalId, {}) } catch { return null }
    return [`home:provider:${HOME_PROVIDER}`, `home:device:${String(input.deviceId)}`,
      `home:binding:${HOME_PROVIDER}:${input.externalId}`]
  }
  if (capabilityId === 'home.scene.activate.safe') {
    const expected = { kind: 'home_scene', provider: HOME_PROVIDER,
      sceneId: input.sceneId, bindingId: input.bindingId, externalId: input.externalId }
    if (!exact(target, expected) || typeof input.externalId !== 'string' || input.safeScene !== true) return null
    try { assertHomeCapabilityBindingAllowed(capabilityId, input.externalId, { safeScene: true }) } catch { return null }
    return [`home:provider:${HOME_PROVIDER}`, `home:scene:${String(input.sceneId)}`,
      `home:binding:${HOME_PROVIDER}:${input.externalId}`]
  }
  return null
}

function exact(actual: FabricJsonObject, expected: FabricJsonObject): boolean {
  const actualKeys = Object.keys(actual).sort(); const expectedKeys = Object.keys(expected).sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
}

function plain(value: unknown): value is FabricJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
