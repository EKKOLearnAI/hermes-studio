import { createHash } from 'node:crypto'
import type { HomeDeviceAvailability } from './types'

const ALLOWED_DOMAINS = new Set([
  'binary_sensor', 'climate', 'fan', 'humidifier', 'light', 'sensor', 'switch',
])
const ENTITY_ID = /^([a-z0-9_]{1,64})\.([a-z0-9_]{1,190})$/
const SAFE_ATOM = /^[a-z0-9][a-z0-9._-]{0,159}$/
const EVENT_ATOM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/
const FORBIDDEN_KEY = /^(?:service|services|service_data|target|access_token|refresh_token|password|passwd|secret|api.?key|credential|authorization|cookie|session|private.?key)$/i

export type HomeAssistantNormalizationErrorCode =
  | 'HOME_ASSISTANT_STATE_INVALID'
  | 'HOME_ASSISTANT_DOMAIN_DENIED'
  | 'HOME_ASSISTANT_UNSAFE_MATERIAL'
  | 'HOME_ASSISTANT_EVENT_INVALID'
  | 'HOME_ASSISTANT_EVENT_INVALID_IDENTITY'
  | 'HOME_ASSISTANT_MATERIAL_TOO_LARGE'

export class HomeAssistantNormalizationError extends Error {
  constructor(readonly code: HomeAssistantNormalizationErrorCode) {
    super(code)
    this.name = 'HomeAssistantNormalizationError'
  }
}

export interface NormalizedHomeAssistantState {
  key: string
  value: unknown
  observedAt: string
}

export interface NormalizedHomeAssistantEntity {
  provider: 'home-assistant'
  externalId: string
  deviceId: string
  bindingId: string
  name: string
  deviceClass: string
  availability: HomeDeviceAvailability
  spaceExternalId: string | null
  capabilities: string[]
  attributes: Record<string, unknown>
  metadata: Record<string, unknown>
  states: NormalizedHomeAssistantState[]
}

export interface NormalizedHomeAssistantEvent {
  event: {
    id: string
    provider: 'home-assistant'
    eventId: string
    eventType: 'state_changed' | 'state_bootstrap'
    occurredAt: string
    receivedAt: string
    payload: {
      entityId: string
      eventType: 'state_changed' | 'state_bootstrap'
      removed: boolean
      state: string
      stateUpdatedAt: string
    }
  }
  entity: NormalizedHomeAssistantEntity
}

export function normalizeHomeAssistantState(raw: unknown): NormalizedHomeAssistantEntity {
  assertSafeProviderMaterial(raw)
  if (!plain(raw)) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  const identity = entityIdentity(raw.entity_id)
  if (!ALLOWED_DOMAINS.has(identity.domain)) {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_DOMAIN_DENIED')
  }
  const state = requiredText(raw.state, 1, 65_536, 'HOME_ASSISTANT_STATE_INVALID')
  if (!plain(raw.attributes)) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  const attributes = raw.attributes
  const observedAt = canonicalTimestamp(raw.last_updated ?? raw.last_changed, 'HOME_ASSISTANT_STATE_INVALID')
  canonicalTimestamp(raw.last_changed, 'HOME_ASSISTANT_STATE_INVALID')
  const sourceDeviceClass = optionalAtom(attributes.device_class, 80)
  const deviceClass = sourceDeviceClass ?? identity.domain
  const areaId = optionalAtom(attributes.area_id, 80)
  const friendlyName = optionalText(attributes.friendly_name, 200)
  const name = friendlyName ?? titleFromObjectId(identity.objectId)
  const availability: HomeDeviceAvailability = state === 'unavailable'
    ? 'unavailable'
    : state === 'unknown' ? 'unknown' : 'available'
  const capabilities = normalizedCapabilities(identity.domain, attributes)
  const states = normalizedStates(identity.domain, state, attributes, observedAt)
  const metadata: Record<string, unknown> = { entityDomain: identity.domain }
  if (sourceDeviceClass) metadata.sourceDeviceClass = sourceDeviceClass
  if (areaId) metadata.areaId = areaId
  const unit = optionalText(attributes.unit_of_measurement, 40)
  if (unit) metadata.unit = unit
  const safeAttributes: Record<string, unknown> = { entityDomain: identity.domain }
  if (unit) safeAttributes.unit = unit
  const supportedFeatures = boundedNumber(attributes.supported_features, 0, Number.MAX_SAFE_INTEGER)
  if (supportedFeatures !== null) safeAttributes.supportedFeatures = supportedFeatures
  return {
    provider: 'home-assistant',
    externalId: identity.entityId,
    deviceId: `device:ha:${digest(identity.entityId).slice(0, 24)}`,
    bindingId: `binding:ha:${digest(identity.entityId).slice(0, 24)}`,
    name,
    deviceClass,
    availability,
    spaceExternalId: areaId,
    capabilities,
    attributes: safeAttributes,
    metadata,
    states,
  }
}

export function normalizeHomeAssistantBootstrapState(raw: unknown, receivedAt: string): NormalizedHomeAssistantEvent {
  const entity = normalizeHomeAssistantState(raw)
  const received = canonicalTimestamp(receivedAt, 'HOME_ASSISTANT_EVENT_INVALID')
  const observedAt = entity.states[0].observedAt
  const eventId = `bootstrap-${digest(`${entity.externalId}\0${observedAt}`)}`
  return normalizedEvent(entity, 'state_bootstrap', eventId, observedAt, received, false)
}

export function normalizeHomeAssistantStateChanged(raw: unknown, receivedAt: string): NormalizedHomeAssistantEvent {
  assertSafeProviderMaterial(raw)
  if (!plain(raw) || raw.event_type !== 'state_changed' || !plain(raw.data)) {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_EVENT_INVALID')
  }
  const occurredAt = canonicalTimestamp(raw.time_fired, 'HOME_ASSISTANT_EVENT_INVALID')
  const received = canonicalTimestamp(receivedAt, 'HOME_ASSISTANT_EVENT_INVALID')
  const dataEntity = entityIdentity(raw.data.entity_id).entityId
  const removed = raw.data.new_state === null
  const material = removed ? raw.data.old_state : raw.data.new_state
  if (!plain(material)) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_EVENT_INVALID')
  let entity = normalizeHomeAssistantState(material)
  if (entity.externalId !== dataEntity) {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_EVENT_INVALID_IDENTITY')
  }
  if (removed) {
    entity = {
      ...entity,
      availability: 'unavailable',
      states: [{ key: 'state', value: 'removed', observedAt: occurredAt }],
    }
  }
  const context = plain(raw.context) ? raw.context : null
  const contextId = context && typeof context.id === 'string' ? context.id : null
  if (contextId !== null && !EVENT_ATOM.test(contextId)) {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_EVENT_INVALID')
  }
  const eventId = contextId ?? `derived-${digest(JSON.stringify({
    entityId: dataEntity,
    occurredAt,
    state: eventStateValue(entity),
    updatedAt: entity.states[0].observedAt,
  }))}`
  return normalizedEvent(entity, 'state_changed', eventId, occurredAt, received, removed)
}

function normalizedEvent(
  entity: NormalizedHomeAssistantEntity,
  eventType: 'state_changed' | 'state_bootstrap',
  eventId: string,
  occurredAt: string,
  receivedAt: string,
  removed: boolean,
): NormalizedHomeAssistantEvent {
  const state = eventStateValue(entity)
  const stateUpdatedAt = entity.states.find(item => item.key === 'state')?.observedAt ?? entity.states[0].observedAt
  const idMaterial = `${eventType}\0${eventId}\0${entity.externalId}`
  return {
    event: {
      id: `event:ha:${digest(idMaterial).slice(0, 24)}`,
      provider: 'home-assistant',
      eventId,
      eventType,
      occurredAt,
      receivedAt,
      payload: { entityId: entity.externalId, eventType, removed, state, stateUpdatedAt },
    },
    entity,
  }
}

function normalizedCapabilities(domain: string, attributes: Record<string, unknown>): string[] {
  const capabilities = new Set<string>()
  if (['light', 'switch', 'fan', 'humidifier'].includes(domain)) capabilities.add('power')
  if (domain === 'light' && boundedNumber(attributes.brightness, 0, 255) !== null) capabilities.add('level')
  if (domain === 'fan' && boundedNumber(attributes.percentage, 0, 100) !== null) capabilities.add('level')
  if (domain === 'humidifier' && boundedNumber(attributes.humidity, 0, 100) !== null) capabilities.add('level')
  if (domain === 'climate' && boundedNumber(attributes.temperature, -100, 200) !== null) capabilities.add('temperature')
  return [...capabilities].sort()
}

function normalizedStates(
  domain: string,
  state: string,
  attributes: Record<string, unknown>,
  observedAt: string,
): NormalizedHomeAssistantState[] {
  const states: NormalizedHomeAssistantState[] = [{ key: 'state', value: state, observedAt }]
  if (['light', 'switch', 'fan', 'humidifier'].includes(domain) && ['on', 'off'].includes(state)) {
    states.push({ key: 'power', value: state === 'on', observedAt })
  }
  const brightness = domain === 'light' ? boundedNumber(attributes.brightness, 0, 255) : null
  if (brightness !== null) states.push({ key: 'level', value: Math.round((brightness / 255) * 1_000) / 10, observedAt })
  const percentage = domain === 'fan' ? boundedNumber(attributes.percentage, 0, 100) : null
  if (percentage !== null) states.push({ key: 'level', value: percentage, observedAt })
  const humidity = domain === 'humidifier' ? boundedNumber(attributes.humidity, 0, 100) : null
  if (humidity !== null) states.push({ key: 'level', value: humidity, observedAt })
  const temperature = domain === 'climate' ? boundedNumber(attributes.temperature, -100, 200) : null
  if (temperature !== null) states.push({ key: 'temperature', value: temperature, observedAt })
  if (['sensor', 'binary_sensor'].includes(domain)) {
    const numeric = strictNumericState(state)
    if (numeric !== null) states.push({ key: 'value', value: numeric, observedAt })
  }
  return states.sort((left, right) => left.key.localeCompare(right.key))
}

function eventStateValue(entity: NormalizedHomeAssistantEntity): string {
  const state = entity.states.find(item => item.key === 'state')?.value
  if (typeof state !== 'string') throw new HomeAssistantNormalizationError('HOME_ASSISTANT_EVENT_INVALID')
  return state
}

function entityIdentity(value: unknown): { domain: string; objectId: string; entityId: string } {
  if (typeof value !== 'string' || value.length > 255) {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  }
  const match = ENTITY_ID.exec(value)
  if (!match) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  return { domain: match[1], objectId: match[2], entityId: value }
}

function assertSafeProviderMaterial(root: unknown): void {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number): void => {
    nodes += 1
    if (nodes > 4_096 || depth > 12) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_MATERIAL_TOO_LARGE')
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'string') {
      if (value.length > 524_288) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_MATERIAL_TOO_LARGE')
      return
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_UNSAFE_MATERIAL')
      return
    }
    if (typeof value !== 'object' || seen.has(value)) {
      throw new HomeAssistantNormalizationError('HOME_ASSISTANT_UNSAFE_MATERIAL')
    }
    const prototype = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new HomeAssistantNormalizationError('HOME_ASSISTANT_UNSAFE_MATERIAL')
    }
    seen.add(value)
    try {
      const keys = Reflect.ownKeys(value)
      if (keys.length > 512 || keys.some(key => typeof key !== 'string')) {
        throw new HomeAssistantNormalizationError('HOME_ASSISTANT_UNSAFE_MATERIAL')
      }
      for (const key of keys as string[]) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor'
          || key.length > 160 || FORBIDDEN_KEY.test(key)) {
          throw new HomeAssistantNormalizationError('HOME_ASSISTANT_UNSAFE_MATERIAL')
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) {
          throw new HomeAssistantNormalizationError('HOME_ASSISTANT_UNSAFE_MATERIAL')
        }
        visit(descriptor.value, depth + 1)
      }
    } finally { seen.delete(value) }
  }
  visit(root, 0)
  let encoded: string
  try { encoded = JSON.stringify(root) } catch {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_UNSAFE_MATERIAL')
  }
  if (Buffer.byteLength(encoded, 'utf8') > 524_288) {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_MATERIAL_TOO_LARGE')
  }
}

function canonicalTimestamp(value: unknown, code: HomeAssistantNormalizationErrorCode): string {
  if (typeof value !== 'string' || value.length > 80 || Number.isNaN(Date.parse(value))) {
    throw new HomeAssistantNormalizationError(code)
  }
  return new Date(value).toISOString()
}

function requiredText(
  value: unknown,
  minimum: number,
  maximum: number,
  code: HomeAssistantNormalizationErrorCode,
): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new HomeAssistantNormalizationError(code)
  }
  return value
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  const text = value.trim()
  if (!text || text.length > maximum) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  return text
}

function optionalAtom(value: unknown, maximum: number): string | null {
  const text = optionalText(value, maximum)
  if (text === null) return null
  if (!SAFE_ATOM.test(text)) throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  return text
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HomeAssistantNormalizationError('HOME_ASSISTANT_STATE_INVALID')
  }
  return value
}

function strictNumericState(value: string): number | null {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function titleFromObjectId(value: string): string {
  return value.split('_').filter(Boolean).map(part => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ').slice(0, 200)
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
