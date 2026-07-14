import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { withPersonalTwinDb } from '../personal-twin/database'
import {
  HOME_DEVICE_AVAILABILITY,
  HOME_SPACE_KINDS,
  HomeDevice,
  HomeDeviceBinding,
  HomeDeviceBindingInput,
  HomeDeviceBindingListOptions,
  HomeDeviceInput,
  HomeDeviceListOptions,
  HomeDeviceState,
  HomeDeviceStateEventInput,
  HomeDeviceStateEventResult,
  HomeDeviceStateListOptions,
  HomeIdentityConflictError,
  HomeInventoryAdjustmentInput,
  HomeInventoryAdjustmentResult,
  HomeInventoryItem,
  HomeInventoryItemInput,
  HomeInventoryItemListOptions,
  HomeInventoryLedgerEntry,
  HomeObject,
  HomeObjectInput,
  HomeObjectListOptions,
  HomeProviderEvent,
  HomeRecordNotFoundError,
  HomeSpace,
  HomeSpaceInput,
  HomeSpaceListOptions,
  HomeValidationError,
  HomeVersionConflictError,
} from './types'

interface SpaceRow {
  space_id: string; kind: HomeSpace['kind']; name: string; parent_space_id: string | null
  attributes_json: string; version: number; created_at: string; updated_at: string
}
interface ObjectRow {
  object_id: string; kind: string; name: string; space_id: string | null
  attributes_json: string; version: number; created_at: string; updated_at: string
}
interface DeviceRow {
  device_id: string; name: string; device_class: string; space_id: string | null
  availability: HomeDevice['availability']; attributes_json: string; version: number; created_at: string; updated_at: string
}
interface BindingRow {
  binding_id: string; device_id: string; provider: string; external_id: string
  capabilities_json: string; metadata_json: string; version: number; created_at: string; updated_at: string
}
interface DeviceStateRow {
  device_id: string; state_key: string; value_json: string; source_event_id: string
  observed_at: string; received_at: string; version: number
}
interface ProviderEventRow {
  provider_event_id: string; provider: string; event_id: string; event_type: string
  occurred_at: string; received_at: string; payload_json: string
  status: HomeProviderEvent['status']; error_code: string | null
}
interface InventoryItemRow {
  item_id: string; name: string; unit: string; quantity: number; low_stock_threshold: number | null
  attributes_json: string; version: number; created_at: string; updated_at: string
}
interface InventoryLedgerRow {
  entry_id: string; item_id: string; delta: number; resulting_quantity: number; reason: string
  source: string; source_id: string; created_at: string
}

const SEMANTIC_ID = /^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/
const SEMANTIC_KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const INVENTORY_UNIT = /^[a-zA-Z0-9._/-]{1,40}$/
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api.?key|credential|authorization|cookie|session|private.?key)/i

function nowIso(): string { return new Date().toISOString() }

function inTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function canonicalJson(value: unknown, shape: 'object' | 'array' | 'any', maxBytes: number): string {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): string => {
    nodes += 1
    if (nodes > 512 || depth > 8) throw new HomeValidationError('Home JSON exceeds structural bounds')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new HomeValidationError('Home JSON numbers must be finite')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || isProxy(item)) throw new HomeValidationError('Home JSON must be schema-safe')
    if (seen.has(item)) throw new HomeValidationError('Home JSON must not contain cycles')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new HomeValidationError('Home JSON must use plain objects')
    }
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        if (item.length > 128) throw new HomeValidationError('Home JSON array is too large')
        const ownKeys = Reflect.ownKeys(item)
        if (ownKeys.some(key => typeof key === 'symbol'
          || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
          throw new HomeValidationError('Home JSON array has invalid properties')
        }
        const values: string[] = []
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new HomeValidationError('Home JSON array must be dense data')
          }
          values.push(visit(descriptor.value, depth + 1))
        }
        return `[${values.join(',')}]`
      }
      const record = item as Record<string, unknown>
      const keys = Reflect.ownKeys(record)
      if (keys.some(key => typeof key !== 'string') || keys.length > 128) {
        throw new HomeValidationError('Home JSON object has invalid keys')
      }
      return `{${(keys as string[]).sort().map(key => {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor'
          || key.length > 160 || SENSITIVE_KEY.test(key)) {
          throw new HomeValidationError('Home JSON object contains an unsafe key')
        }
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new HomeValidationError('Home JSON object must contain data properties')
        }
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`
      }).join(',')}}`
    } finally {
      seen.delete(item)
    }
  }
  if (shape === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new HomeValidationError('Home JSON value must be an object')
  }
  if (shape === 'array' && !Array.isArray(value)) throw new HomeValidationError('Home JSON value must be an array')
  const encoded = visit(value, 0)
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new HomeValidationError('Home JSON exceeds its byte limit')
  return encoded
}

function parseJson<T>(value: string): T { return JSON.parse(value) as T }

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`
}

function mirrorTwinEntity(
  db: DatabaseSync,
  input: { id: string; label: string; sourceId: string; attributes: Record<string, unknown> },
): void {
  const source = 'home-twin'
  const byId = db.prepare('SELECT source,source_id FROM twin_entities WHERE id=?').get(input.id) as {
    source: string; source_id: string
  } | undefined
  if (byId && (byId.source !== source || byId.source_id !== input.sourceId)) {
    throw new HomeIdentityConflictError(`Generic Twin entity ${input.id} belongs to another source`)
  }
  const bySource = db.prepare('SELECT id FROM twin_entities WHERE source=? AND source_id=?').get(source, input.sourceId) as {
    id: string
  } | undefined
  if (bySource && bySource.id !== input.id) {
    throw new HomeIdentityConflictError(`Generic Twin provenance ${input.sourceId} belongs to ${bySource.id}`)
  }
  const attributesJson = canonicalJson(input.attributes, 'object', 131_072)
  const now = nowIso()
  db.prepare(`INSERT INTO twin_entities
    (id,type,label,attributes_json,source,source_id,created_at,updated_at)
    VALUES(?,'home',?,?,?,?,?,?)
    ON CONFLICT(source,source_id) DO UPDATE SET
      type=excluded.type,label=excluded.label,attributes_json=excluded.attributes_json,updated_at=excluded.updated_at`)
    .run(input.id, input.label, attributesJson, source, input.sourceId, now, now)
}

function mirrorTwinEvent(db: DatabaseSync, input: {
  eventType: string
  subjectId: string | null
  payload: Record<string, unknown>
  occurredAt: string
  source: string
  sourceId: string
  actor: string
}): void {
  if (input.subjectId !== null && !db.prepare('SELECT 1 FROM twin_entities WHERE id=?').get(input.subjectId)) {
    throw new HomeRecordNotFoundError(`Generic Twin subject not found: ${input.subjectId}`)
  }
  const payloadJson = canonicalJson(input.payload, 'object', 524_288)
  const id = stableId('event', [input.source, input.sourceId, input.eventType])
  const existing = db.prepare(`SELECT id,subject_id,payload_json,occurred_at,actor FROM twin_events
    WHERE source=? AND source_id=? AND event_type=?`).get(input.source, input.sourceId, input.eventType) as {
    id: string; subject_id: string | null; payload_json: string; occurred_at: string; actor: string
  } | undefined
  if (existing) {
    if (existing.id !== id || existing.subject_id !== input.subjectId || existing.payload_json !== payloadJson
      || existing.occurred_at !== input.occurredAt || existing.actor !== input.actor) {
      throw new HomeIdentityConflictError(`Generic Twin event ${input.source}/${input.sourceId} changed material`)
    }
    return
  }
  const ingestedAt = nowIso()
  db.prepare(`INSERT INTO twin_events
    (id,event_type,subject_id,payload_json,occurred_at,ingested_at,source,source_id,actor,
     confidence,confirmation_state,evidence_json,schema_version)
    VALUES(?,?,?,?,?,?,?,?,?,1,'observed','[]',1)`)
    .run(id, input.eventType, input.subjectId, payloadJson, input.occurredAt, ingestedAt, input.source, input.sourceId, input.actor)
  const outboxPayload = canonicalJson({
    recordId: id, eventType: input.eventType, source: input.source, sourceId: input.sourceId,
  }, 'object', 8192)
  db.prepare(`INSERT INTO twin_outbox
    (id,topic,aggregate_id,payload_json,status,available_at,created_at)
    VALUES(?,'twin.event.recorded',?,?,'pending',?,?)`)
    .run(stableId('outbox', ['twin.event.recorded', id]), id, outboxPayload, ingestedAt, ingestedAt)
}

function mirrorPlacement(
  db: DatabaseSync,
  input: { subjectId: string; spaceId: string | null; subjectKind: 'object' | 'device'; version: number; occurredAt: string },
): void {
  const source = 'home-twin'
  const sourceId = `placement:${input.subjectId}`
  const existing = db.prepare('SELECT id,object_id,valid_to FROM twin_relations WHERE source=? AND source_id=?')
    .get(source, sourceId) as { id: string; object_id: string; valid_to: string | null } | undefined
  if (input.spaceId === null) {
    if (existing?.valid_to === null) {
      db.prepare('UPDATE twin_relations SET valid_to=?,updated_at=? WHERE id=?')
        .run(input.occurredAt, input.occurredAt, existing.id)
    }
  } else {
    if (!db.prepare('SELECT 1 FROM twin_entities WHERE id=?').get(input.subjectId)
      || !db.prepare('SELECT 1 FROM twin_entities WHERE id=?').get(input.spaceId)) {
      throw new HomeRecordNotFoundError('Generic Twin placement endpoint is missing')
    }
    const id = existing?.id ?? stableId('relation', [source, sourceId])
    db.prepare(`INSERT INTO twin_relations
      (id,subject_id,predicate,object_id,attributes_json,valid_from,valid_to,source,source_id,created_at,updated_at)
      VALUES(?,?,'home.located_in',?,'{}',?,NULL,?,?,?,?)
      ON CONFLICT(source,source_id) DO UPDATE SET
        subject_id=excluded.subject_id,predicate=excluded.predicate,object_id=excluded.object_id,
        valid_from=excluded.valid_from,valid_to=NULL,updated_at=excluded.updated_at`)
      .run(id, input.subjectId, input.spaceId, input.occurredAt, source, sourceId, input.occurredAt, input.occurredAt)
  }
  mirrorTwinEvent(db, {
    eventType: 'home.placement.changed', subjectId: input.subjectId,
    payload: { subjectId: input.subjectId, subjectKind: input.subjectKind, spaceId: input.spaceId, version: input.version },
    occurredAt: input.occurredAt, source, sourceId: `${sourceId}:v${input.version}`, actor: source,
  })
}

function mirrorInventoryProjection(db: DatabaseSync, item: HomeInventoryItem, sourceRecordId: string): void {
  const valueJson = canonicalJson({
    isLowStock: item.lowStockThreshold !== null && item.quantity <= item.lowStockThreshold,
    quantity: item.quantity,
    threshold: item.lowStockThreshold,
    unit: item.unit,
  }, 'object', 8192)
  db.prepare(`INSERT INTO twin_projections
    (projection_key,subject_id,value_json,source_record_id,version,updated_at)
    VALUES('home.inventory.low_stock',?,?,?,?,?)
    ON CONFLICT(projection_key,subject_id) DO UPDATE SET
      value_json=excluded.value_json,source_record_id=excluded.source_record_id,
      version=excluded.version,updated_at=excluded.updated_at`)
    .run(item.id, valueJson, sourceRecordId, item.version, item.updatedAt)
}

function mirrorInventoryItem(db: DatabaseSync, item: HomeInventoryItem, sourceRecordId: string): void {
  mirrorTwinEntity(db, {
    id: item.id, label: item.name, sourceId: `inventory:${item.id}`,
    attributes: {
      recordKind: 'inventory-item', unit: item.unit, quantity: item.quantity,
      lowStockThreshold: item.lowStockThreshold, attributes: item.attributes, version: item.version,
    },
  })
  mirrorInventoryProjection(db, item, sourceRecordId)
}

function semanticId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 160 || !SEMANTIC_ID.test(value)) {
    throw new HomeValidationError(`${field} is invalid`)
  }
  return value
}

function semanticKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SEMANTIC_KEY.test(value)) throw new HomeValidationError(`${field} is invalid`)
  return value
}

function providerId(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) throw new HomeValidationError('Home provider is invalid')
  return value
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new HomeValidationError(`${field} is required`)
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > maximum) throw new HomeValidationError(`${field} is invalid`)
  return normalized
}

function expectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new HomeValidationError('expectedVersion is invalid')
  return value as number
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new HomeValidationError(`${field} is invalid`)
  return new Date(value).toISOString()
}

function listLimit(value: number | undefined): number {
  if (value === undefined) return 100
  if (!Number.isFinite(value)) return 100
  return Math.max(1, Math.min(200, Math.floor(value)))
}

function spaceFromRow(row: SpaceRow): HomeSpace {
  return {
    id: row.space_id, kind: row.kind, name: row.name, parentSpaceId: row.parent_space_id,
    attributes: parseJson(row.attributes_json), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function objectFromRow(row: ObjectRow): HomeObject {
  return {
    id: row.object_id, kind: row.kind, name: row.name, spaceId: row.space_id,
    attributes: parseJson(row.attributes_json), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function deviceFromRow(row: DeviceRow): HomeDevice {
  return {
    id: row.device_id, name: row.name, deviceClass: row.device_class, spaceId: row.space_id,
    availability: row.availability, attributes: parseJson(row.attributes_json), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function bindingFromRow(row: BindingRow): HomeDeviceBinding {
  return {
    id: row.binding_id, deviceId: row.device_id, provider: row.provider, externalId: row.external_id,
    capabilities: parseJson(row.capabilities_json), metadata: parseJson(row.metadata_json), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function stateFromRow(row: DeviceStateRow): HomeDeviceState {
  return {
    deviceId: row.device_id, key: row.state_key, value: parseJson(row.value_json), sourceEventId: row.source_event_id,
    observedAt: row.observed_at, receivedAt: row.received_at, version: row.version,
  }
}

function eventFromRow(row: ProviderEventRow): HomeProviderEvent {
  return {
    id: row.provider_event_id, provider: row.provider, eventId: row.event_id, eventType: row.event_type,
    occurredAt: row.occurred_at, receivedAt: row.received_at, payload: parseJson(row.payload_json),
    status: row.status, errorCode: row.error_code,
  }
}

function inventoryItemFromRow(row: InventoryItemRow): HomeInventoryItem {
  return {
    id: row.item_id, name: row.name, unit: row.unit, quantity: row.quantity,
    lowStockThreshold: row.low_stock_threshold, attributes: parseJson(row.attributes_json),
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function inventoryEntryFromRow(row: InventoryLedgerRow): HomeInventoryLedgerEntry {
  return {
    id: row.entry_id, itemId: row.item_id, delta: row.delta, resultingQuantity: row.resulting_quantity,
    reason: row.reason, source: row.source, sourceId: row.source_id, createdAt: row.created_at,
  }
}

function requireSpace(db: DatabaseSync, id: string | null): void {
  if (id !== null && !db.prepare('SELECT 1 FROM twin_home_spaces WHERE space_id=?').get(id)) {
    throw new HomeRecordNotFoundError(`Home parent or placement space not found: ${id}`)
  }
}

function requireDevice(db: DatabaseSync, id: string): void {
  if (!db.prepare('SELECT 1 FROM twin_home_devices WHERE device_id=?').get(id)) {
    throw new HomeRecordNotFoundError(`Home device not found: ${id}`)
  }
}

function assertSpaceParentChain(db: DatabaseSync, id: string, parentId: string | null): void {
  let current = parentId
  const visited = new Set<string>()
  while (current !== null) {
    if (current === id || visited.has(current)) throw new HomeValidationError('Home space parent hierarchy contains a cycle')
    visited.add(current)
    if (visited.size > 64) throw new HomeValidationError('Home space parent hierarchy is too deep')
    const row = db.prepare('SELECT parent_space_id FROM twin_home_spaces WHERE space_id=?').get(current) as {
      parent_space_id: string | null
    } | undefined
    if (!row) throw new HomeRecordNotFoundError(`Home parent space not found: ${current}`)
    current = row.parent_space_id
  }
}

function assertVersion(current: number | undefined, expected: number, kind: string, id: string): void {
  if (current === undefined && expected !== 0) {
    throw new HomeVersionConflictError(`${kind} ${id} does not exist at expected version ${expected}`)
  }
  if (current !== undefined && current !== expected) {
    throw new HomeVersionConflictError(`${kind} ${id} version is ${current}, not ${expected}`)
  }
}

export class HomeTwinStore {
  constructor(readonly database: DatabaseSync) {}

  upsertSpace(input: HomeSpaceInput): HomeSpace {
    const id = semanticId(input.id, 'Home space id')
    if (!HOME_SPACE_KINDS.includes(input.kind)) throw new HomeValidationError('Home space kind is invalid')
    const name = boundedText(input.name, 'Home space name', 200)
    const parentSpaceId = input.parentSpaceId == null ? null : semanticId(input.parentSpaceId, 'Home parent space id')
    if (parentSpaceId === id) throw new HomeValidationError('Home space cannot be its own parent')
    const attributesJson = canonicalJson(input.attributes ?? {}, 'object', 65_536)
    const expected = expectedVersion(input.expectedVersion)
    return inTransaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM twin_home_spaces WHERE space_id=?').get(id) as SpaceRow | undefined
      assertVersion(existing?.version, expected, 'Home space', id)
      requireSpace(this.database, parentSpaceId)
      assertSpaceParentChain(this.database, id, parentSpaceId)
      const now = nowIso()
      if (!existing) {
        this.database.prepare(`INSERT INTO twin_home_spaces
          (space_id,kind,name,parent_space_id,attributes_json,version,created_at,updated_at)
          VALUES(?,?,?,?,?,1,?,?)`).run(id, input.kind, name, parentSpaceId, attributesJson, now, now)
      } else {
        this.database.prepare(`UPDATE twin_home_spaces SET kind=?,name=?,parent_space_id=?,attributes_json=?,
          version=version+1,updated_at=? WHERE space_id=? AND version=?`)
          .run(input.kind, name, parentSpaceId, attributesJson, now, id, expected)
      }
      const result = spaceFromRow(
        this.database.prepare('SELECT * FROM twin_home_spaces WHERE space_id=?').get(id) as unknown as SpaceRow,
      )
      mirrorTwinEntity(this.database, {
        id: result.id, label: result.name, sourceId: `space:${result.id}`,
        attributes: {
          recordKind: 'space', spaceKind: result.kind, parentSpaceId: result.parentSpaceId,
          attributes: result.attributes, version: result.version,
        },
      })
      return result
    })
  }

  upsertObject(input: HomeObjectInput): HomeObject {
    const id = semanticId(input.id, 'Home object id')
    const kind = semanticKey(input.kind, 'Home object kind')
    const name = boundedText(input.name, 'Home object name', 200)
    const spaceId = input.spaceId == null ? null : semanticId(input.spaceId, 'Home object space id')
    const attributesJson = canonicalJson(input.attributes ?? {}, 'object', 65_536)
    const expected = expectedVersion(input.expectedVersion)
    return inTransaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM twin_home_objects WHERE object_id=?').get(id) as ObjectRow | undefined
      assertVersion(existing?.version, expected, 'Home object', id)
      requireSpace(this.database, spaceId)
      const now = nowIso()
      if (!existing) {
        this.database.prepare(`INSERT INTO twin_home_objects
          (object_id,kind,name,space_id,attributes_json,version,created_at,updated_at)
          VALUES(?,?,?,?,?,1,?,?)`).run(id, kind, name, spaceId, attributesJson, now, now)
      } else {
        this.database.prepare(`UPDATE twin_home_objects SET kind=?,name=?,space_id=?,attributes_json=?,
          version=version+1,updated_at=? WHERE object_id=? AND version=?`)
          .run(kind, name, spaceId, attributesJson, now, id, expected)
      }
      const result = objectFromRow(
        this.database.prepare('SELECT * FROM twin_home_objects WHERE object_id=?').get(id) as unknown as ObjectRow,
      )
      mirrorTwinEntity(this.database, {
        id: result.id, label: result.name, sourceId: `object:${result.id}`,
        attributes: {
          recordKind: 'object', objectKind: result.kind, spaceId: result.spaceId,
          attributes: result.attributes, version: result.version,
        },
      })
      mirrorPlacement(this.database, {
        subjectId: result.id, spaceId: result.spaceId, subjectKind: 'object', version: result.version, occurredAt: now,
      })
      return result
    })
  }

  upsertDevice(input: HomeDeviceInput): HomeDevice {
    const id = semanticId(input.id, 'Home device id')
    const name = boundedText(input.name, 'Home device name', 200)
    const deviceClass = semanticKey(input.deviceClass, 'Home device class')
    const spaceId = input.spaceId == null ? null : semanticId(input.spaceId, 'Home device space id')
    if (!HOME_DEVICE_AVAILABILITY.includes(input.availability)) throw new HomeValidationError('Home device availability is invalid')
    const attributesJson = canonicalJson(input.attributes ?? {}, 'object', 65_536)
    const expected = expectedVersion(input.expectedVersion)
    return inTransaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM twin_home_devices WHERE device_id=?').get(id) as DeviceRow | undefined
      assertVersion(existing?.version, expected, 'Home device', id)
      requireSpace(this.database, spaceId)
      const now = nowIso()
      if (!existing) {
        this.database.prepare(`INSERT INTO twin_home_devices
          (device_id,name,device_class,space_id,availability,attributes_json,version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?)`).run(id, name, deviceClass, spaceId, input.availability, attributesJson, now, now)
      } else {
        this.database.prepare(`UPDATE twin_home_devices SET name=?,device_class=?,space_id=?,availability=?,attributes_json=?,
          version=version+1,updated_at=? WHERE device_id=? AND version=?`)
          .run(name, deviceClass, spaceId, input.availability, attributesJson, now, id, expected)
      }
      const result = deviceFromRow(
        this.database.prepare('SELECT * FROM twin_home_devices WHERE device_id=?').get(id) as unknown as DeviceRow,
      )
      mirrorTwinEntity(this.database, {
        id: result.id, label: result.name, sourceId: `device:${result.id}`,
        attributes: {
          recordKind: 'device', deviceClass: result.deviceClass, spaceId: result.spaceId,
          availability: result.availability, attributes: result.attributes, version: result.version,
        },
      })
      mirrorPlacement(this.database, {
        subjectId: result.id, spaceId: result.spaceId, subjectKind: 'device', version: result.version, occurredAt: now,
      })
      return result
    })
  }

  upsertBinding(input: HomeDeviceBindingInput): HomeDeviceBinding {
    const id = semanticId(input.id, 'Home binding id')
    const deviceId = semanticId(input.deviceId, 'Home binding device id')
    const provider = providerId(input.provider)
    const externalId = boundedText(input.externalId, 'Home binding external id', 255)
    if (input.capabilities !== undefined && !Array.isArray(input.capabilities)) {
      throw new HomeValidationError('Home binding capabilities must be an array')
    }
    const capabilities = [...new Set(input.capabilities ?? [])].map(value => semanticKey(value, 'Home capability')).sort()
    if (capabilities.length > 64) throw new HomeValidationError('Home binding has too many capabilities')
    const capabilitiesJson = canonicalJson(capabilities, 'array', 16_384)
    const metadataJson = canonicalJson(input.metadata ?? {}, 'object', 65_536)
    const expected = expectedVersion(input.expectedVersion)
    return inTransaction(this.database, () => {
      requireDevice(this.database, deviceId)
      const existing = this.database.prepare('SELECT * FROM twin_home_device_bindings WHERE binding_id=?').get(id) as BindingRow | undefined
      assertVersion(existing?.version, expected, 'Home binding', id)
      const owner = this.database.prepare(`SELECT binding_id FROM twin_home_device_bindings
        WHERE provider=? AND external_id=?`).get(provider, externalId) as { binding_id: string } | undefined
      if (owner && owner.binding_id !== id) {
        throw new HomeIdentityConflictError(`Home provider identity ${provider}/${externalId} belongs to ${owner.binding_id}`)
      }
      if (existing && (existing.device_id !== deviceId || existing.provider !== provider || existing.external_id !== externalId)) {
        throw new HomeIdentityConflictError(`Home binding ${id} identity is immutable`)
      }
      const now = nowIso()
      if (!existing) {
        this.database.prepare(`INSERT INTO twin_home_device_bindings
          (binding_id,device_id,provider,external_id,capabilities_json,metadata_json,version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?)`).run(id, deviceId, provider, externalId, capabilitiesJson, metadataJson, now, now)
      } else {
        this.database.prepare(`UPDATE twin_home_device_bindings SET capabilities_json=?,metadata_json=?,
          version=version+1,updated_at=? WHERE binding_id=? AND version=?`)
          .run(capabilitiesJson, metadataJson, now, id, expected)
      }
      return bindingFromRow(this.database.prepare('SELECT * FROM twin_home_device_bindings WHERE binding_id=?').get(id) as unknown as BindingRow)
    })
  }

  upsertInventoryItem(input: HomeInventoryItemInput): HomeInventoryItem {
    const id = semanticId(input.id, 'Home inventory item id')
    const name = boundedText(input.name, 'Home inventory item name', 200)
    const unit = boundedText(input.unit, 'Home inventory unit', 40)
    if (!INVENTORY_UNIT.test(unit)) throw new HomeValidationError('Home inventory unit is invalid')
    if (input.initialQuantity !== undefined
      && (!Number.isFinite(input.initialQuantity) || input.initialQuantity < 0)) {
      throw new HomeValidationError('Home inventory initial quantity is invalid')
    }
    if (input.lowStockThreshold !== undefined && input.lowStockThreshold !== null
      && (!Number.isFinite(input.lowStockThreshold) || input.lowStockThreshold < 0)) {
      throw new HomeValidationError('Home inventory low-stock threshold is invalid')
    }
    const attributesJson = canonicalJson(input.attributes ?? {}, 'object', 65_536)
    const expected = expectedVersion(input.expectedVersion)
    return inTransaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM twin_home_inventory_items WHERE item_id=?')
        .get(id) as InventoryItemRow | undefined
      assertVersion(existing?.version, expected, 'Home inventory item', id)
      if (existing && input.initialQuantity !== undefined && input.initialQuantity !== existing.quantity) {
        throw new HomeValidationError('Home inventory quantity can only change through the ledger')
      }
      const quantity = existing?.quantity ?? input.initialQuantity ?? 0
      const threshold = input.lowStockThreshold === undefined
        ? (existing?.low_stock_threshold ?? null)
        : input.lowStockThreshold
      const now = nowIso()
      if (!existing) {
        this.database.prepare(`INSERT INTO twin_home_inventory_items
          (item_id,name,unit,quantity,low_stock_threshold,attributes_json,version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?)`).run(id, name, unit, quantity, threshold, attributesJson, now, now)
      } else {
        this.database.prepare(`UPDATE twin_home_inventory_items SET name=?,unit=?,low_stock_threshold=?,attributes_json=?,
          version=version+1,updated_at=? WHERE item_id=? AND version=?`)
          .run(name, unit, threshold, attributesJson, now, id, expected)
      }
      const result = inventoryItemFromRow(this.database.prepare(
        'SELECT * FROM twin_home_inventory_items WHERE item_id=?',
      ).get(id) as unknown as InventoryItemRow)
      mirrorInventoryItem(this.database, result, result.id)
      return result
    })
  }

  adjustInventory(input: HomeInventoryAdjustmentInput): HomeInventoryAdjustmentResult {
    const id = semanticId(input.id, 'Home inventory ledger id')
    const itemId = semanticId(input.itemId, 'Home inventory item id')
    if (!Number.isFinite(input.delta) || input.delta === 0) throw new HomeValidationError('Home inventory delta is invalid')
    const reason = boundedText(input.reason, 'Home inventory adjustment reason', 200)
    const source = boundedText(input.source, 'Home inventory adjustment source', 100)
    if (!/^[a-zA-Z0-9:._-]+$/.test(source)) throw new HomeValidationError('Home inventory adjustment source is invalid')
    const sourceId = boundedText(input.sourceId, 'Home inventory adjustment source id', 255)
    const occurredAt = timestamp(input.occurredAt, 'Home inventory adjustment occurredAt')
    return inTransaction(this.database, () => {
      const existingEntries = this.database.prepare(`SELECT * FROM twin_home_inventory_ledger
        WHERE entry_id=? OR (source=? AND source_id=?)`).all(id, source, sourceId) as unknown as InventoryLedgerRow[]
      if (existingEntries.length > 1) throw new HomeIdentityConflictError('Home inventory ledger identities collide')
      const existingEntry = existingEntries[0]
      if (existingEntry) {
        const sameIdentity = existingEntry.entry_id === id && existingEntry.item_id === itemId
          && existingEntry.delta === input.delta && existingEntry.reason === reason
          && existingEntry.source === source && existingEntry.source_id === sourceId
          && existingEntry.created_at === occurredAt
        if (!sameIdentity) throw new HomeIdentityConflictError(`Home inventory adjustment ${id} changed material`)
        const currentItem = this.database.prepare('SELECT * FROM twin_home_inventory_items WHERE item_id=?')
          .get(itemId) as InventoryItemRow | undefined
        if (!currentItem) throw new HomeRecordNotFoundError(`Home inventory item not found: ${itemId}`)
        return {
          disposition: 'duplicate', item: inventoryItemFromRow(currentItem), entry: inventoryEntryFromRow(existingEntry),
        }
      }

      const current = this.database.prepare('SELECT * FROM twin_home_inventory_items WHERE item_id=?')
        .get(itemId) as InventoryItemRow | undefined
      if (!current) throw new HomeRecordNotFoundError(`Home inventory item not found: ${itemId}`)
      const resultingQuantity = current.quantity + input.delta
      if (!Number.isFinite(resultingQuantity) || resultingQuantity < 0) {
        throw new HomeValidationError('Home inventory adjustment would make quantity negative')
      }
      this.database.prepare(`INSERT INTO twin_home_inventory_ledger
        (entry_id,item_id,delta,resulting_quantity,reason,source,source_id,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, itemId, input.delta, resultingQuantity, reason, source, sourceId, occurredAt)
      const updatedAt = nowIso()
      this.database.prepare(`UPDATE twin_home_inventory_items SET quantity=?,version=version+1,updated_at=?
        WHERE item_id=? AND version=?`).run(resultingQuantity, updatedAt, itemId, current.version)
      const item = inventoryItemFromRow(this.database.prepare('SELECT * FROM twin_home_inventory_items WHERE item_id=?')
        .get(itemId) as unknown as InventoryItemRow)
      const entry = inventoryEntryFromRow(this.database.prepare('SELECT * FROM twin_home_inventory_ledger WHERE entry_id=?')
        .get(id) as unknown as InventoryLedgerRow)
      mirrorInventoryItem(this.database, item, entry.id)
      mirrorTwinEvent(this.database, {
        eventType: 'home.inventory.adjusted', subjectId: item.id,
        payload: {
          itemId: item.id, delta: entry.delta, resultingQuantity: entry.resultingQuantity,
          reason: entry.reason, unit: item.unit, version: item.version,
        },
        occurredAt, source, sourceId, actor: source,
      })
      return { disposition: 'applied', item, entry }
    })
  }

  listSpaces(options: HomeSpaceListOptions = {}): HomeSpace[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (options.parentSpaceId !== undefined) {
      if (options.parentSpaceId === null) clauses.push('parent_space_id IS NULL')
      else { clauses.push('parent_space_id=?'); values.push(semanticId(options.parentSpaceId, 'Home parent space id')) }
    }
    if (options.kind !== undefined) {
      if (!HOME_SPACE_KINDS.includes(options.kind)) throw new HomeValidationError('Home space kind is invalid')
      clauses.push('kind=?'); values.push(options.kind)
    }
    values.push(listLimit(options.limit))
    return (this.database.prepare(`SELECT * FROM twin_home_spaces ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY name,space_id LIMIT ?`).all(...values) as unknown as SpaceRow[]).map(spaceFromRow)
  }

  listObjects(options: HomeObjectListOptions = {}): HomeObject[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (options.spaceId !== undefined) {
      if (options.spaceId === null) clauses.push('space_id IS NULL')
      else { clauses.push('space_id=?'); values.push(semanticId(options.spaceId, 'Home object space id')) }
    }
    if (options.kind !== undefined) { clauses.push('kind=?'); values.push(semanticKey(options.kind, 'Home object kind')) }
    values.push(listLimit(options.limit))
    return (this.database.prepare(`SELECT * FROM twin_home_objects ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY name,object_id LIMIT ?`).all(...values) as unknown as ObjectRow[]).map(objectFromRow)
  }

  listDevices(options: HomeDeviceListOptions = {}): HomeDevice[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (options.spaceId !== undefined) {
      if (options.spaceId === null) clauses.push('space_id IS NULL')
      else { clauses.push('space_id=?'); values.push(semanticId(options.spaceId, 'Home device space id')) }
    }
    if (options.deviceClass !== undefined) {
      clauses.push('device_class=?'); values.push(semanticKey(options.deviceClass, 'Home device class'))
    }
    values.push(listLimit(options.limit))
    return (this.database.prepare(`SELECT * FROM twin_home_devices ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY name,device_id LIMIT ?`).all(...values) as unknown as DeviceRow[]).map(deviceFromRow)
  }

  listBindings(options: HomeDeviceBindingListOptions = {}): HomeDeviceBinding[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (options.deviceId !== undefined) {
      clauses.push('device_id=?'); values.push(semanticId(options.deviceId, 'Home binding device id'))
    }
    if (options.provider !== undefined) { clauses.push('provider=?'); values.push(providerId(options.provider)) }
    values.push(listLimit(options.limit))
    return (this.database.prepare(`SELECT * FROM twin_home_device_bindings
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY provider,external_id LIMIT ?`)
      .all(...values) as unknown as BindingRow[]).map(bindingFromRow)
  }

  listDeviceStates(options: HomeDeviceStateListOptions = {}): HomeDeviceState[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (options.deviceId !== undefined) {
      clauses.push('device_id=?'); values.push(semanticId(options.deviceId, 'Home state device id'))
    }
    if (options.key !== undefined) { clauses.push('state_key=?'); values.push(semanticKey(options.key, 'Home state key')) }
    values.push(listLimit(options.limit))
    return (this.database.prepare(`SELECT * FROM twin_home_device_states
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY device_id,state_key LIMIT ?`)
      .all(...values) as unknown as DeviceStateRow[]).map(stateFromRow)
  }

  listInventoryItems(options: HomeInventoryItemListOptions = {}): HomeInventoryItem[] {
    const clauses = options.lowStockOnly === true
      ? ['low_stock_threshold IS NOT NULL', 'quantity <= low_stock_threshold']
      : []
    return (this.database.prepare(`SELECT * FROM twin_home_inventory_items
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY name,item_id LIMIT ?`)
      .all(listLimit(options.limit)) as unknown as InventoryItemRow[]).map(inventoryItemFromRow)
  }

  applyDeviceStateEvent(input: HomeDeviceStateEventInput): HomeDeviceStateEventResult {
    const eventId = semanticId(input.event.id, 'Home provider event id')
    const provider = providerId(input.event.provider)
    const externalEventId = boundedText(input.event.eventId, 'Home provider external event id', 255)
    const eventType = semanticKey(input.event.eventType, 'Home provider event type')
    const occurredAt = timestamp(input.event.occurredAt, 'Home event occurredAt')
    const receivedAt = timestamp(input.event.receivedAt, 'Home event receivedAt')
    const payloadJson = canonicalJson(input.event.payload, 'object', 524_288)
    if (!Array.isArray(input.states) || input.states.length < 1 || input.states.length > 64) {
      throw new HomeValidationError('Home state event must contain 1 to 64 states')
    }
    const states = input.states.map(state => ({
      deviceId: semanticId(state.deviceId, 'Home state device id'),
      key: semanticKey(state.key, 'Home state key'),
      valueJson: canonicalJson(state.value, 'any', 65_536),
      observedAt: timestamp(state.observedAt, 'Home state observedAt'),
    }))
    const stateAddresses = new Set(states.map(state => `${state.deviceId}\0${state.key}`))
    if (stateAddresses.size !== states.length) throw new HomeValidationError('Home state event contains duplicate state keys')

    return inTransaction(this.database, () => {
      const existingEvents = this.database.prepare(`SELECT * FROM twin_home_provider_events
        WHERE provider_event_id=? OR (provider=? AND event_id=?)`).all(eventId, provider, externalEventId) as unknown as ProviderEventRow[]
      if (existingEvents.length > 1) throw new HomeIdentityConflictError('Home provider event identities collide')
      const existingEvent = existingEvents[0]
      if (existingEvent) {
        const sameIdentity = existingEvent.provider_event_id === eventId && existingEvent.provider === provider
          && existingEvent.event_id === externalEventId && existingEvent.event_type === eventType
          && existingEvent.occurred_at === occurredAt && existingEvent.received_at === receivedAt
          && existingEvent.payload_json === payloadJson
        if (!sameIdentity) throw new HomeIdentityConflictError(`Home provider event ${eventId} replay changed material`)
        const currentStates = states.map(state => {
          const row = this.database.prepare(`SELECT * FROM twin_home_device_states
            WHERE device_id=? AND state_key=?`).get(state.deviceId, state.key) as DeviceStateRow | undefined
          if (!row) throw new HomeIdentityConflictError(`Home provider event ${eventId} replay has missing state material`)
          return stateFromRow(row)
        })
        return { disposition: 'duplicate', event: eventFromRow(existingEvent), states: currentStates }
      }

      const mutations = states.map(state => {
        requireDevice(this.database, state.deviceId)
        const current = this.database.prepare(`SELECT * FROM twin_home_device_states
          WHERE device_id=? AND state_key=?`).get(state.deviceId, state.key) as DeviceStateRow | undefined
        const newer = !current || state.observedAt > current.observed_at
          || (state.observedAt === current.observed_at && eventId > current.source_event_id)
        return { ...state, current, newer }
      })
      const disposition: 'applied' | 'ignored' = mutations.some(mutation => mutation.newer) ? 'applied' : 'ignored'
      this.database.prepare(`INSERT INTO twin_home_provider_events
        (provider_event_id,provider,event_id,event_type,occurred_at,received_at,payload_json,status,error_code)
        VALUES(?,?,?,?,?,?,?,?,NULL)`).run(
        eventId, provider, externalEventId, eventType, occurredAt, receivedAt, payloadJson, disposition === 'applied' ? 'applied' : 'ignored',
      )
      for (const mutation of mutations) {
        if (!mutation.newer) continue
        this.database.prepare(`INSERT INTO twin_home_device_states
          (device_id,state_key,value_json,source_event_id,observed_at,received_at,version)
          VALUES(?,?,?,?,?,?,1)
          ON CONFLICT(device_id,state_key) DO UPDATE SET
            value_json=excluded.value_json,source_event_id=excluded.source_event_id,observed_at=excluded.observed_at,
            received_at=excluded.received_at,version=twin_home_device_states.version+1`)
          .run(mutation.deviceId, mutation.key, mutation.valueJson, eventId, mutation.observedAt, receivedAt)
      }
      const event = eventFromRow(this.database.prepare(
        'SELECT * FROM twin_home_provider_events WHERE provider_event_id=?',
      ).get(eventId) as unknown as ProviderEventRow)
      const resultStates = mutations.map(mutation => stateFromRow(this.database.prepare(`SELECT * FROM twin_home_device_states
        WHERE device_id=? AND state_key=?`).get(mutation.deviceId, mutation.key) as unknown as DeviceStateRow))
      const deviceIds = [...new Set(mutations.map(mutation => mutation.deviceId))]
      for (const deviceId of deviceIds) {
        if (!this.database.prepare('SELECT 1 FROM twin_entities WHERE id=?').get(deviceId)) {
          const device = deviceFromRow(this.database.prepare('SELECT * FROM twin_home_devices WHERE device_id=?')
            .get(deviceId) as unknown as DeviceRow)
          mirrorTwinEntity(this.database, {
            id: device.id, label: device.name, sourceId: `device:${device.id}`,
            attributes: {
              recordKind: 'device', deviceClass: device.deviceClass, spaceId: device.spaceId,
              availability: device.availability, attributes: device.attributes, version: device.version,
            },
          })
        }
      }
      mirrorTwinEvent(this.database, {
        eventType: `home.provider.${eventType}`,
        subjectId: deviceIds.length === 1 ? deviceIds[0] : null,
        payload: {
          providerEventId: eventId, provider, eventId: externalEventId, disposition,
          states: mutations.map(mutation => ({
            deviceId: mutation.deviceId, key: mutation.key, observedAt: mutation.observedAt,
            valueDigest: createHash('sha256').update(mutation.valueJson).digest('hex'),
          })),
        },
        occurredAt, source: `home-provider:${provider}`, sourceId: externalEventId, actor: provider,
      })
      return { disposition, event, states: resultStates }
    })
  }
}

export function withHomeTwinStore<T>(operation: (store: HomeTwinStore) => T): T {
  return withPersonalTwinDb(database => operation(new HomeTwinStore(database)))
}
