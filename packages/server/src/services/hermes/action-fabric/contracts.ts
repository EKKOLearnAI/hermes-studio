import type { FabricCapability, FabricJsonObject, FabricRisk } from './types'

const HEALTH_CAPABILITIES = new Set([
  'health.source.sync', 'health.artifact.analyze.local', 'health.artifact.analyze.remote',
  'health.plan.adjust', 'health.plan.restore', 'health.reminder.send', 'health.checkin.request',
  'health.followup.schedule',
])

const RISK_ORDER: Record<FabricRisk, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }

export function validateFabricSchema(value: unknown, schema: FabricJsonObject): boolean {
  return validateNode(value, schema)
}

export function healthTargetAtoms(
  capabilityId: string,
  target: FabricJsonObject,
  input: FabricJsonObject,
): string[] | null {
  if (!HEALTH_CAPABILITIES.has(capabilityId) || !isPlainObject(target)) return null
  switch (capabilityId) {
    case 'health.source.sync':
      return exact(target, { kind: 'health_connector', connectorId: input.connectorId })
        ? [`health:connector:${String(input.connectorId)}`] : null
    case 'health.artifact.analyze.local':
      return exact(target, { kind: 'health_artifact', artifactId: input.artifactId, manifestDigest: input.manifestDigest })
        ? [`health:artifact:${String(input.artifactId)}:${String(input.manifestDigest)}`] : null
    case 'health.artifact.analyze.remote':
      return exact(target, { kind: 'health_remote_artifact', artifactId: input.artifactId,
        manifestDigest: input.manifestDigest, processorId: input.processorId })
        ? [`health:artifact:${String(input.artifactId)}:${String(input.manifestDigest)}`,
          `health:processor:${String(input.processorId)}`] : null
    case 'health.plan.adjust':
    case 'health.plan.restore':
      return exact(target, { kind: 'health_plan', planId: input.planId })
        ? [`health:plan:${String(input.planId)}`] : null
    case 'health.reminder.send':
    case 'health.checkin.request':
      return exact(target, { kind: 'health_recipient', recipient: input.recipient })
        ? [`health:recipient:${String(input.recipient)}`] : null
    case 'health.followup.schedule':
      return exact(target, { kind: 'health_followup', ownerUserId: input.ownerUserId })
        ? [`health:owner:${String(input.ownerUserId)}`] : null
    default:
      return null
  }
}

export function isHealthCapability(capabilityId: string): boolean {
  return HEALTH_CAPABILITIES.has(capabilityId)
}

export function effectiveCapabilityRisk(capability: FabricCapability, input: FabricJsonObject): FabricRisk {
  let semantic: FabricRisk = capability.risk
  if (capability.id === 'health.followup.schedule') semantic = 'medium'
  if (capability.id === 'health.plan.adjust') {
    const operation = input.operation
    const reason = input.reasonCode
    semantic = operation === 'review_energy_deficit'
      || (operation === 'reduce_training_intensity' && reason === 'material_reported_pain') ? 'medium' : 'low'
  }
  return RISK_ORDER[semantic] > RISK_ORDER[capability.risk] ? semantic : capability.risk
}

export function healthStandingAuthorizationRequirements(
  capability: FabricCapability,
): string[] | null {
  const requiredAuthentication: Record<string, string[]> = {
    'health.source.sync': ['connector_credential:configured'],
    'health.artifact.analyze.local': ['artifact:local_read'],
    'health.artifact.analyze.remote': ['one_time_consent:exact_artifact_manifest', 'processor:exact_id'],
    'health.plan.adjust': ['health_plan:write'],
    'health.plan.restore': ['health_plan:write'],
    'health.reminder.send': ['live_mode:enabled', 'recipient:configured_self'],
    'health.checkin.request': ['live_mode:enabled', 'recipient:configured_self'],
    'health.followup.schedule': ['health_schedule:write'],
  }
  const expected = requiredAuthentication[capability.id]
  return expected !== undefined && capability.idempotency === 'required'
    && sameStringSet(capability.authentication, expected) ? [...expected] : null
}

function sameStringSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every(value => actual.includes(value))
}

export function validateHealthSemantics(capabilityId: string, input: FabricJsonObject): boolean {
  if (capabilityId !== 'health.plan.adjust') return true
  const operation = input.operation
  if (operation === 'reduce_training_intensity') {
    return ['rest', 'low', 'moderate'].includes(String(input.maximumIntensity))
      && ['low_sleep', 'low_recovery_score', 'material_reported_pain'].includes(String(input.reasonCode))
      && input.targetG === undefined && input.chains === undefined
  }
  if (operation === 'review_energy_deficit') {
    return input.reasonCode === 'weight_loss_velocity_over_one_percent'
      && input.maximumIntensity === undefined && input.targetG === undefined && input.chains === undefined
  }
  if (operation === 'prioritize_food_protein') {
    return Number.isInteger(input.targetG) && Number(input.targetG) >= 1 && Number(input.targetG) <= 500
      && input.reasonCode === 'resistance_day_protein_gap'
      && input.maximumIntensity === undefined && input.chains === undefined
  }
  if (operation === 'reduce_constrained_chain_load') {
    return Array.isArray(input.chains) && input.chains.length > 0 && input.chains.length <= 32
      && input.reasonCode === 'posture_chain_overload'
      && input.maximumIntensity === undefined && input.targetG === undefined
  }
  return false
}

export function validateHealthOutputSemantics(
  capabilityId: string,
  input: FabricJsonObject,
  output: FabricJsonObject,
): boolean {
  if (!isHealthCapability(capabilityId)) return true
  if (capabilityId === 'health.source.sync' && output.connectorId !== input.connectorId) return false
  if (capabilityId.startsWith('health.artifact.analyze.') && output.artifactId !== input.artifactId) return false
  if (capabilityId === 'health.artifact.analyze.remote' && output.consentId !== input.consentId) return false
  if ((capabilityId === 'health.plan.adjust' || capabilityId === 'health.plan.restore')
    && output.planId !== input.planId) return false
  if (capabilityId === 'health.plan.adjust') {
    if (!Number.isSafeInteger(input.expectedVersion) || output.previousVersion !== input.expectedVersion
      || output.newVersion !== Number(input.expectedVersion) + 1
      || typeof output.previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(output.previousDigest)
      || typeof output.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(output.planDigest)) return false
  }
  if (capabilityId === 'health.plan.restore') {
    if (output.status !== 'restored' || output.restoredVersion !== input.restoreVersion
      || output.planDigest !== input.restoreDigest) return false
  }
  if (capabilityId === 'health.followup.schedule' && output.followupId !== input.followupId) return false
  const ids = capabilityId === 'health.source.sync' ? output.recordIds
    : capabilityId.startsWith('health.artifact.analyze.') ? output.observationIds : undefined
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !Number.isSafeInteger(output.totalCount) || !Number.isSafeInteger(output.omittedCount)
      || output.totalCount !== ids.length + Number(output.omittedCount)
      || (Number(output.omittedCount) > 0) !== (typeof output.continuationCursor === 'string')) return false
  }
  return true
}

function validateNode(value: unknown, schema: FabricJsonObject): boolean {
  if ('const' in schema && !sameJson(value, schema.const)) return false
  if (Array.isArray(schema.enum) && !schema.enum.some(item => sameJson(value, item))) return false
  const types = typeof schema.type === 'string' ? [schema.type]
    : Array.isArray(schema.type) ? schema.type : []
  if (types.length > 0 && !types.some(type => matchesType(value, type))) return false

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < Number(schema.minLength)) return false
    if (Number.isInteger(schema.maxLength) && value.length > Number(schema.maxLength)) return false
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern).test(value)) return false } catch { return false }
    }
    if (schema.format === 'date-time' && !validDateTime(value)) return false
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < Number(schema.minItems)) return false
    if (Number.isInteger(schema.maxItems) && value.length > Number(schema.maxItems)) return false
    const items = schema.items
    if (isPlainObject(items) && value.some(item => !validateNode(item, items))) return false
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    if (required.some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(value, key))) return false
    if (Number.isInteger(schema.minProperties) && keys.length < Number(schema.minProperties)) return false
    if (schema.additionalProperties === false && keys.some(key => !Object.prototype.hasOwnProperty.call(properties, key))) return false
    for (const key of keys) {
      const child = properties[key]
      if (isPlainObject(child) && !validateNode(value[key], child)) return false
    }
  }
  return true
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === 'null') return value === null
  if (type === 'object') return isPlainObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  return false
}

function validDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

function isPlainObject(value: unknown): value is FabricJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exact(actual: FabricJsonObject, expected: FabricJsonObject): boolean {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && sameJson(actual[key], expected[key]))
}

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}
