import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getProfileDir, listProfileNamesFromDisk } from '../hermes-profile'
import {
  claimTwinImportRun,
  completeTwinImportRun,
  failTwinImportRun,
  renewTwinImportRun,
  type TwinImportRunLeaseOptions,
} from '../personal-twin/legacy-import'
import { withPersonalTwinDb } from '../personal-twin/database'
import { HomeTwinStore } from './store'
import type { HomeDevice, HomeDeviceState, HomeInventoryItem, HomeObject, HomeSpace } from './types'

const IMPORT_SOURCE = 'legacy-home-state'
const MIGRATION_VERSION = 'home-migration-v1'
const SAFE_DEVICE_DOMAINS = new Set(['binary_sensor', 'climate', 'fan', 'humidifier', 'light', 'sensor', 'switch'])
const POWER_DOMAINS = new Set(['fan', 'humidifier', 'light', 'switch'])
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api.?key|credential|authorization|cookie|session|private.?key)/i

type Row = Record<string, unknown>
interface LegacyProfileSnapshot {
  profile: string
  rooms: Row[]; furniture: Row[]; compartments: Row[]; inventory: Row[]; ledger: Row[]
  devices: Row[]; deviceBindings: Row[]; deviceStates: Row[]; placements: Row[]; layout: Row | null
}
export interface HomeMigrationCounts {
  profiles: number; layouts: number; spaces: number; objects: number; inventory: number
  ledger: number; devices: number; bindings: number; stateEvents: number; placements: number; skipped: number
}
export interface HomeMigrationResult {
  runId: string; status: 'completed'; fingerprint: string; version: string; profiles: string[]
  counts: HomeMigrationCounts; startedAt: string; completedAt: string
}

function emptyCounts(): HomeMigrationCounts {
  return { profiles: 0, layouts: 0, spaces: 0, objects: 0, inventory: 0, ledger: 0,
    devices: 0, bindings: 0, stateEvents: 0, placements: 0, skipped: 0 }
}
function countsRecord(counts: HomeMigrationCounts): Record<string, number> {
  return { ...counts }
}
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Row).sort(([left], [right]) => compareUtf8(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}
function digest(...parts: unknown[]): string { return createHash('sha256').update(stableJson(parts)).digest('hex') }
function mappedId(kind: 'space' | 'object' | 'inventory' | 'device' | 'binding' | 'event' | 'ledger',
  profile: string, sourceId: string): string {
  return `${kind}:legacy:${digest(profile, kind, sourceId).slice(0, 24)}`
}
export function getLegacyHomeStateDbPath(profile: string): string {
  return join(getProfileDir(profile), 'home_state.db')
}
function profilesOnDisk(requested?: string[]): string[] {
  const known = new Set(listProfileNamesFromDisk().filter(profile => existsSync(getLegacyHomeStateDbPath(profile))))
  const selected = requested?.length ? requested : [...known]
  return [...new Set(selected.map(value => value.trim()).filter(value => known.has(value)))]
    .sort((left, right) => left === 'default' ? -1 : right === 'default' ? 1 : compareUtf8(left, right))
}
function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}
function rows(db: DatabaseSync, table: string, columns: string, order: string): Row[] {
  if (!hasTable(db, table)) return []
  return db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).all() as Row[]
}
function latestLayout(db: DatabaseSync, profile: string): Row | null {
  if (!hasTable(db, 'home_layouts')) return null
  return db.prepare(`SELECT profile,version,layout_json,created_at,updated_at FROM home_layouts
    WHERE profile=? ORDER BY version DESC LIMIT 1`).get(profile) as Row | undefined ?? null
}
function readProfile(profile: string): LegacyProfileSnapshot {
  const db = new DatabaseSync(getLegacyHomeStateDbPath(profile), { open: true, readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON')
    const snapshot: LegacyProfileSnapshot = {
      profile,
      rooms: rows(db, 'home_rooms', 'id,name,floor_name,x,y,w,h,color,created_at,updated_at', 'id'),
      furniture: rows(db, 'home_furniture', 'id,room_id,name,furniture_type,x,y,w,h,created_at,updated_at', 'id'),
      compartments: rows(db, 'home_compartments', 'id,furniture_id,name,created_at,updated_at', 'id'),
      inventory: rows(db, 'home_inventory_batches', 'id,name,quantity,unit,expiry_date,notes,created_at,updated_at', 'id'),
      ledger: rows(db, 'home_inventory_ledger', 'id,batch_id,event_type,quantity_delta,actor,payload_json,created_at', 'created_at,id'),
      devices: rows(db, 'home_devices', 'id,external_id,provider,name,room_id,capabilities_json,state_json,created_at,updated_at', 'id'),
      deviceBindings: rows(db, 'home_device_bindings', 'id,device_id,target_type,target_id,created_at,updated_at', 'id'),
      deviceStates: rows(db, 'home_device_states', 'id,device_id,capability,state_json,observed_at', 'observed_at,id'),
      placements: rows(db, 'home_placements', 'id,target_type,target_id,room_id,furniture_id,compartment_id,x,y,z,created_at,updated_at', 'id'),
      layout: latestLayout(db, profile),
    }
    validateSnapshot(snapshot)
    return snapshot
  } catch {
    throw new Error('HOME_MIGRATION_SOURCE_INVALID')
  } finally { db.close() }
}
function requiredText(row: Row, key: string, maximum = 200): string {
  const value = row[key]
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('HOME_MIGRATION_SOURCE_INVALID')
  }
  return value
}
function optionalText(row: Row, key: string, maximum = 2000): string | null {
  const value = row[key]
  if (value === null || value === undefined || value === '') return null
  return requiredText(row, key, maximum)
}
function finite(row: Row, key: string, nullable = true): number | null {
  const value = row[key]
  if (nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
  return value
}
function timestamp(row: Row, key: string): string {
  const value = requiredText(row, key, 80)
  if (!Number.isFinite(Date.parse(value))) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
  return new Date(value).toISOString()
}
function jsonValue(value: unknown, maximum: number): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('HOME_MIGRATION_SOURCE_INVALID') }
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 4_096 || depth > 12) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object') throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    for (const [key, child] of Object.entries(item as Row)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.length > 160 || SENSITIVE_KEY.test(key)) {
        throw new Error('HOME_MIGRATION_SOURCE_INVALID')
      }
      visit(child, depth + 1)
    }
  }
  visit(parsed, 0)
  return parsed
}
function jsonRecord(value: unknown, maximum = 65_536): Row {
  const parsed = jsonValue(value, maximum)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
  return parsed as Row
}
function validateSnapshot(snapshot: LegacyProfileSnapshot): void {
  for (const room of snapshot.rooms) {
    requiredText(room, 'id', 160); requiredText(room, 'name'); requiredText(room, 'floor_name', 100)
    optionalText(room, 'color', 40); for (const key of ['x', 'y', 'w', 'h']) finite(room, key)
    timestamp(room, 'created_at'); timestamp(room, 'updated_at')
  }
  const roomIds = new Set(snapshot.rooms.map(row => String(row.id)))
  for (const item of snapshot.furniture) {
    requiredText(item, 'id', 160); if (!roomIds.has(requiredText(item, 'room_id', 160))) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    requiredText(item, 'name'); requiredText(item, 'furniture_type', 100)
    for (const key of ['x', 'y', 'w', 'h']) finite(item, key); timestamp(item, 'created_at'); timestamp(item, 'updated_at')
  }
  const furnitureIds = new Set(snapshot.furniture.map(row => String(row.id)))
  for (const item of snapshot.compartments) {
    requiredText(item, 'id', 160); if (!furnitureIds.has(requiredText(item, 'furniture_id', 160))) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    requiredText(item, 'name'); timestamp(item, 'created_at'); timestamp(item, 'updated_at')
  }
  for (const item of snapshot.inventory) {
    requiredText(item, 'id', 160); requiredText(item, 'name'); requiredText(item, 'unit', 40)
    const quantity = finite(item, 'quantity', false)!; if (quantity < 0) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    optionalText(item, 'expiry_date', 80); optionalText(item, 'notes', 2_000)
    timestamp(item, 'created_at'); timestamp(item, 'updated_at')
  }
  const inventoryIds = new Set(snapshot.inventory.map(row => String(row.id)))
  for (const item of snapshot.ledger) {
    requiredText(item, 'id', 160); if (!inventoryIds.has(requiredText(item, 'batch_id', 160))) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    requiredText(item, 'event_type', 100); const delta = finite(item, 'quantity_delta', false)!; if (delta === 0) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    requiredText(item, 'actor', 100); jsonRecord(item.payload_json); timestamp(item, 'created_at')
  }
  for (const item of snapshot.devices) {
    requiredText(item, 'id', 160); requiredText(item, 'external_id', 255); requiredText(item, 'provider', 80); requiredText(item, 'name')
    optionalText(item, 'room_id', 160); jsonValue(item.capabilities_json, 16_384); jsonRecord(item.state_json)
    timestamp(item, 'created_at'); timestamp(item, 'updated_at')
  }
  const deviceIds = new Set(snapshot.devices.map(row => String(row.id)))
  for (const item of snapshot.deviceBindings) {
    requiredText(item, 'id', 160)
    if (!deviceIds.has(requiredText(item, 'device_id', 160))) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    requiredText(item, 'target_type', 40); requiredText(item, 'target_id', 160)
    timestamp(item, 'created_at'); timestamp(item, 'updated_at')
  }
  for (const item of snapshot.deviceStates) {
    requiredText(item, 'id', 160); if (!deviceIds.has(requiredText(item, 'device_id', 160))) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    requiredText(item, 'capability', 100); jsonRecord(item.state_json); timestamp(item, 'observed_at')
  }
  for (const item of snapshot.placements) {
    requiredText(item, 'id', 160)
    if (!['object', 'inventory_batch', 'asset', 'device'].includes(requiredText(item, 'target_type', 40))) {
      throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    }
    requiredText(item, 'target_id', 160)
    for (const key of ['room_id', 'furniture_id', 'compartment_id']) optionalText(item, key, 160)
    for (const key of ['x', 'y', 'z']) finite(item, key); timestamp(item, 'created_at'); timestamp(item, 'updated_at')
  }
  if (snapshot.layout) {
    finite(snapshot.layout, 'version', false); jsonRecord(snapshot.layout.layout_json, 524_288)
    timestamp(snapshot.layout, 'created_at'); timestamp(snapshot.layout, 'updated_at')
  }
}
function source(profile: string, table: string, id: string): Row {
  return { system: 'home-state-v1', profile, table, id }
}
function geometry(row: Row): Row {
  return { x: finite(row, 'x'), y: finite(row, 'y'), w: finite(row, 'w'), h: finite(row, 'h') }
}
function placementFor(snapshot: LegacyProfileSnapshot, targetType: string, targetId: string): Row | null {
  return snapshot.placements.filter(item => item.target_type === targetType && item.target_id === targetId)
    .sort((left, right) => timestamp(left, 'updated_at').localeCompare(timestamp(right, 'updated_at'))).at(-1) ?? null
}
function placementSpace(snapshot: LegacyProfileSnapshot, placement: Row | null): string | null {
  if (!placement) return null
  const compartment = optionalText(placement, 'compartment_id', 160)
  if (compartment) return mappedId('space', snapshot.profile, `compartment:${compartment}`)
  const furniture = optionalText(placement, 'furniture_id', 160)
  if (furniture) return mappedId('space', snapshot.profile, `furniture:${furniture}`)
  const room = optionalText(placement, 'room_id', 160)
  return room ? mappedId('space', snapshot.profile, `room:${room}`) : null
}
function legacyPlacement(row: Row): Row {
  return {
    id: requiredText(row, 'id', 160), targetType: requiredText(row, 'target_type', 40),
    targetId: requiredText(row, 'target_id', 160), roomId: optionalText(row, 'room_id', 160),
    furnitureId: optionalText(row, 'furniture_id', 160), compartmentId: optionalText(row, 'compartment_id', 160),
    x: finite(row, 'x'), y: finite(row, 'y'), z: finite(row, 'z'),
    createdAt: timestamp(row, 'created_at'), updatedAt: timestamp(row, 'updated_at'),
  }
}
function normalizeUnit(value: string): { unit: string; legacyUnit?: string } {
  if (/^[a-zA-Z0-9._/-]{1,40}$/.test(value)) return { unit: value }
  return { unit: 'piece', legacyUnit: value }
}
function provider(value: string): string {
  if (value === 'home_assistant' || value === 'home-assistant') return 'home-assistant'
  const normalized = value.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80)
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(normalized) ? normalized : 'legacy-home'
}
function entityDomain(externalId: string, state: Row): string {
  const supplied = typeof state.domain === 'string' ? state.domain : externalId.split('.')[0]
  return /^[a-z0-9_]{1,64}$/.test(supplied) ? supplied : 'unknown'
}
function capabilities(domain: string, raw: unknown): string[] {
  const legacy = Array.isArray(raw) ? raw.filter(item => typeof item === 'string') as string[] : []
  if (!SAFE_DEVICE_DOMAINS.has(domain)) return []
  const output = new Set<string>()
  if (POWER_DOMAINS.has(domain) && legacy.some(item => item === 'switch.on_off' || item === 'power')) output.add('power')
  if (legacy.some(item => ['light.brightness', 'fan.speed', 'level'].includes(item))) output.add('level')
  if (domain === 'climate' && legacy.some(item => item === 'climate.temperature' || item === 'temperature')) output.add('temperature')
  return [...output].sort(compareUtf8)
}
function scalar(value: unknown): string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null
}
function normalizedStates(domain: string, record: Row): Array<{ key: string; value: unknown }> {
  const state = scalar(record.state)
  const attributes = record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes)
    ? record.attributes as Row : record
  const output: Array<{ key: string; value: unknown }> = []
  if (state !== null) output.push({ key: 'state', value: state })
  if (POWER_DOMAINS.has(domain) && (state === 'on' || state === 'off')) output.push({ key: 'power', value: state === 'on' })
  const level = domain === 'light' && typeof attributes.brightness === 'number' ? Math.round(attributes.brightness / 255 * 1_000) / 10
    : domain === 'fan' && typeof attributes.percentage === 'number' ? attributes.percentage
      : domain === 'humidifier' && typeof attributes.humidity === 'number' ? attributes.humidity : null
  if (typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 100) output.push({ key: 'level', value: level })
  const temperature = domain === 'climate' ? attributes.temperature : null
  if (typeof temperature === 'number' && Number.isFinite(temperature)) output.push({ key: 'temperature', value: temperature })
  if (['sensor', 'binary_sensor'].includes(domain) && typeof state === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(state)) {
    output.push({ key: 'value', value: Number(state) })
  }
  return output.length ? output.sort((left, right) => compareUtf8(left.key, right.key)) : [{ key: 'state', value: 'unknown' }]
}
function materialEqual(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right) }
function ensureSpace(store: HomeTwinStore, input: Omit<Parameters<HomeTwinStore['upsertSpace']>[0], 'expectedVersion'>): HomeSpace {
  const existing = store.getSpace(input.id)
  if (existing && existing.kind === input.kind && existing.name === input.name && existing.parentSpaceId === (input.parentSpaceId ?? null)
    && materialEqual(existing.attributes, input.attributes ?? {})) return existing
  return store.upsertSpace({ ...input, expectedVersion: existing?.version ?? 0 })
}
function ensureObject(store: HomeTwinStore, existingById: Map<string, HomeObject>,
  input: Omit<Parameters<HomeTwinStore['upsertObject']>[0], 'expectedVersion'>): HomeObject {
  const existing = existingById.get(input.id) ?? store.getObject(input.id)
  if (existing && existing.kind === input.kind && existing.name === input.name && existing.spaceId === (input.spaceId ?? null)
    && materialEqual(existing.attributes, input.attributes ?? {})) return existing
  const value = store.upsertObject({ ...input, expectedVersion: existing?.version ?? 0 }); existingById.set(value.id, value); return value
}
function ensureInventory(store: HomeTwinStore, existingById: Map<string, HomeInventoryItem>,
  input: Omit<Parameters<HomeTwinStore['upsertInventoryItem']>[0], 'expectedVersion'>): HomeInventoryItem {
  const existing = existingById.get(input.id) ?? store.getInventoryItem(input.id)
  if (existing && existing.name === input.name && existing.unit === input.unit
    && existing.lowStockThreshold === (input.lowStockThreshold ?? null) && materialEqual(existing.attributes, input.attributes ?? {})) return existing
  const value = store.upsertInventoryItem({ ...input, initialQuantity: existing?.quantity ?? input.initialQuantity,
    expectedVersion: existing?.version ?? 0 }); existingById.set(value.id, value); return value
}
function ensureDevice(store: HomeTwinStore, existingById: Map<string, HomeDevice>,
  input: Omit<Parameters<HomeTwinStore['upsertDevice']>[0], 'expectedVersion'>): HomeDevice {
  const existing = existingById.get(input.id) ?? store.getDevice(input.id)
  if (existing && existing.name === input.name && existing.deviceClass === input.deviceClass
    && existing.spaceId === (input.spaceId ?? null) && existing.availability === input.availability
    && materialEqual(existing.attributes, input.attributes ?? {})) return existing
  const value = store.upsertDevice({ ...input, expectedVersion: existing?.version ?? 0 }); existingById.set(value.id, value); return value
}
function applyStateEvent(store: HomeTwinStore, input: { profile: string; deviceId: string; provider: string
  sourceId: string; observedAt: string; states: Array<{ key: string; value: unknown }> }): void {
  const identity = digest(input.profile, input.sourceId, input.observedAt, input.states)
  store.applyDeviceStateEvent({
    event: { id: `event:legacy:${identity.slice(0, 24)}`, provider: input.provider,
      eventId: `legacy-${identity}`, eventType: 'legacy_state', occurredAt: input.observedAt,
      receivedAt: input.observedAt, payload: { migration: 'home-state-v1', profile: input.profile, sourceId: input.sourceId } },
    states: input.states.map(state => ({ deviceId: input.deviceId, key: state.key, value: state.value, observedAt: input.observedAt })),
  })
}
function importSnapshot(store: HomeTwinStore, snapshot: LegacyProfileSnapshot, counts: HomeMigrationCounts): void {
  const profile = snapshot.profile
  const homeId = mappedId('space', profile, 'home')
  ensureSpace(store, { id: homeId, kind: 'home', name: `${profile} home`, parentSpaceId: null,
    attributes: { legacySource: source(profile, 'profile', profile) } }); counts.spaces += 1
  const layout = snapshot.layout ? jsonRecord(snapshot.layout.layout_json, 524_288) : null
  const floorNames = new Set(snapshot.rooms.map(row => requiredText(row, 'floor_name', 100)))
  if (layout && Array.isArray(layout.floors)) for (const floor of layout.floors) {
    if (floor && typeof floor === 'object' && typeof (floor as Row).name === 'string') floorNames.add(String((floor as Row).name))
  }
  for (const floorName of [...floorNames].sort(compareUtf8)) {
    ensureSpace(store, { id: mappedId('space', profile, `floor:${floorName}`), kind: 'floor', name: floorName,
      parentSpaceId: homeId, attributes: { legacySource: source(profile, 'derived-floor', floorName) } }); counts.spaces += 1
  }
  for (const row of snapshot.rooms) {
    const legacyId = requiredText(row, 'id', 160); const floorName = requiredText(row, 'floor_name', 100)
    ensureSpace(store, { id: mappedId('space', profile, `room:${legacyId}`), kind: 'room', name: requiredText(row, 'name'),
      parentSpaceId: mappedId('space', profile, `floor:${floorName}`), attributes: { legacySource: source(profile, 'home_rooms', legacyId),
        floorName, color: optionalText(row, 'color', 40), geometry: geometry(row), sourceCreatedAt: timestamp(row, 'created_at'),
        sourceUpdatedAt: timestamp(row, 'updated_at') } })
    counts.spaces += 1
  }
  for (const row of snapshot.furniture) {
    const legacyId = requiredText(row, 'id', 160); const roomId = requiredText(row, 'room_id', 160)
    ensureSpace(store, { id: mappedId('space', profile, `furniture:${legacyId}`), kind: 'furniture', name: requiredText(row, 'name'),
      parentSpaceId: mappedId('space', profile, `room:${roomId}`), attributes: { legacySource: source(profile, 'home_furniture', legacyId),
        furnitureType: requiredText(row, 'furniture_type', 100), geometry: geometry(row), sourceCreatedAt: timestamp(row, 'created_at'),
        sourceUpdatedAt: timestamp(row, 'updated_at') } })
    counts.spaces += 1
  }
  for (const row of snapshot.compartments) {
    const legacyId = requiredText(row, 'id', 160); const furnitureId = requiredText(row, 'furniture_id', 160)
    ensureSpace(store, { id: mappedId('space', profile, `compartment:${legacyId}`), kind: 'compartment', name: requiredText(row, 'name'),
      parentSpaceId: mappedId('space', profile, `furniture:${furnitureId}`), attributes: { legacySource: source(profile, 'home_compartments', legacyId),
        sourceCreatedAt: timestamp(row, 'created_at'), sourceUpdatedAt: timestamp(row, 'updated_at') } }); counts.spaces += 1
  }
  const objects = new Map(store.listObjects({ limit: 200 }).map(value => [value.id, value]))
  if (layout && snapshot.layout) {
    ensureObject(store, objects, { id: mappedId('object', profile, 'layout-document'), kind: 'layout-document',
      name: `${profile} legacy layout`, spaceId: homeId, attributes: { legacySource: source(profile, 'home_layouts', String(snapshot.layout.version)),
        document: layout, sourceCreatedAt: timestamp(snapshot.layout, 'created_at'),
        sourceUpdatedAt: timestamp(snapshot.layout, 'updated_at') } }); counts.layouts += 1; counts.objects += 1
  }
  for (const row of snapshot.placements) {
    const placement = legacyPlacement(row)
    ensureObject(store, objects, { id: mappedId('object', profile, `placement:${String(placement.id)}`),
      kind: 'legacy-placement', name: `Legacy placement ${String(placement.id)}`, spaceId: placementSpace(snapshot, row),
      attributes: { legacySource: source(profile, 'home_placements', String(placement.id)), legacyPlacement: placement } })
    counts.objects += 1; counts.placements += 1
  }
  for (const row of snapshot.placements.filter(value => value.target_type === 'object' || value.target_type === 'asset')) {
    const legacyId = requiredText(row, 'target_id', 160); const targetType = requiredText(row, 'target_type', 40)
    ensureObject(store, objects, { id: mappedId('object', profile, `${targetType}:${legacyId}`), kind: targetType,
      name: legacyId, spaceId: placementSpace(snapshot, row), attributes: { legacySource: source(profile, 'home_placements', requiredText(row, 'id', 160)),
        legacyTargetId: legacyId, legacyPlacement: legacyPlacement(row),
        coordinates: { x: finite(row, 'x'), y: finite(row, 'y'), z: finite(row, 'z') } } })
    counts.objects += 1
  }
  const inventory = new Map(store.listInventoryItems({ limit: 200 }).map(value => [value.id, value]))
  for (const row of snapshot.inventory) {
    const legacyId = requiredText(row, 'id', 160); const itemLedger = snapshot.ledger.filter(entry => entry.batch_id === legacyId)
    const finalQuantity = finite(row, 'quantity', false)!; const baseQuantity = finalQuantity - itemLedger.reduce((sum, entry) => sum + finite(entry, 'quantity_delta', false)!, 0)
    if (!Number.isFinite(baseQuantity) || baseQuantity < 0) throw new Error('HOME_MIGRATION_SOURCE_INVALID')
    const legacyPlacement = placementFor(snapshot, 'inventory_batch', legacyId); const normalizedUnit = normalizeUnit(requiredText(row, 'unit', 40))
    const itemId = mappedId('inventory', profile, legacyId)
    ensureInventory(store, inventory, { id: itemId, name: requiredText(row, 'name'), unit: normalizedUnit.unit,
      initialQuantity: baseQuantity, lowStockThreshold: null, attributes: { legacySource: source(profile, 'home_inventory_batches', legacyId),
        ...(normalizedUnit.legacyUnit ? { legacyUnit: normalizedUnit.legacyUnit } : {}), expiryDate: optionalText(row, 'expiry_date', 80),
        notes: optionalText(row, 'notes', 2_000) ?? '', sourceCreatedAt: timestamp(row, 'created_at'),
        placement: legacyPlacement ? { spaceId: placementSpace(snapshot, legacyPlacement),
          roomId: optionalText(legacyPlacement, 'room_id', 160), furnitureId: optionalText(legacyPlacement, 'furniture_id', 160),
          compartmentId: optionalText(legacyPlacement, 'compartment_id', 160), x: finite(legacyPlacement, 'x'), y: finite(legacyPlacement, 'y'), z: finite(legacyPlacement, 'z') } : null,
        sourceUpdatedAt: timestamp(row, 'updated_at') } }); counts.inventory += 1
    for (const entry of itemLedger) {
      const legacyEntryId = requiredText(entry, 'id', 160); const payload = jsonRecord(entry.payload_json)
      store.adjustInventory({ id: mappedId('ledger', profile, legacyEntryId), itemId,
        delta: finite(entry, 'quantity_delta', false)!, reason: typeof payload.reason === 'string' && payload.reason.length <= 200
          ? payload.reason : requiredText(entry, 'event_type', 100), source: IMPORT_SOURCE,
        sourceId: `${profile}:${digest(profile, legacyEntryId)}`, occurredAt: timestamp(entry, 'created_at') })
      counts.ledger += 1
    }
  }
  const devices = new Map(store.listDevices({ limit: 200 }).map(value => [value.id, value]))
  for (const row of snapshot.devices) {
    const legacyId = requiredText(row, 'id', 160); const externalId = requiredText(row, 'external_id', 255)
    const state = jsonRecord(row.state_json); const domain = entityDomain(externalId, state); const providerId = provider(requiredText(row, 'provider', 80))
    const rawCapabilities = jsonValue(row.capabilities_json, 16_384)
    const legacyTargetBindings = snapshot.deviceBindings.filter(binding => binding.device_id === legacyId).map(binding => ({
      id: requiredText(binding, 'id', 160), deviceId: legacyId,
      targetType: requiredText(binding, 'target_type', 40), targetId: requiredText(binding, 'target_id', 160),
      createdAt: timestamp(binding, 'created_at'), updatedAt: timestamp(binding, 'updated_at'),
      legacySource: source(profile, 'home_device_bindings', requiredText(binding, 'id', 160)),
    }))
    const devicePlacement = placementFor(snapshot, 'device', legacyId)
    const legacyRoom = optionalText(row, 'room_id', 160)
    const spaceId = placementSpace(snapshot, devicePlacement) ?? (legacyRoom ? mappedId('space', profile, `room:${legacyRoom}`) : null)
    const deviceId = mappedId('device', profile, legacyId)
    ensureDevice(store, devices, { id: deviceId, name: requiredText(row, 'name'), deviceClass: /^[a-z0-9][a-z0-9._-]{0,99}$/.test(domain) ? domain : 'unknown',
      spaceId, availability: state.state === 'unavailable' ? 'unavailable' : state.state === 'unknown' ? 'unknown' : 'available',
      attributes: { legacySource: source(profile, 'home_devices', legacyId), legacyProvider: requiredText(row, 'provider', 80),
        legacyExternalId: externalId, legacyRoomId: legacyRoom, legacyCapabilities: rawCapabilities,
        legacyState: state, legacyTargetBindings,
        sourceCreatedAt: timestamp(row, 'created_at'),
        sourceUpdatedAt: timestamp(row, 'updated_at') } }); counts.devices += 1
    if (/^[a-z0-9_]{1,64}\.[a-z0-9_]{1,190}$/.test(externalId)) {
      const bindingInput = { id: mappedId('binding', profile, legacyId), deviceId, provider: providerId, externalId,
        capabilities: capabilities(domain, rawCapabilities), metadata: { entityDomain: domain,
          legacySource: source(profile, 'home_devices', legacyId) } }
      const existing = store.getBinding(bindingInput.id)
      if (!existing || existing.id !== bindingInput.id || !materialEqual(existing.capabilities, bindingInput.capabilities)
        || !materialEqual(existing.metadata, bindingInput.metadata)) {
        store.upsertBinding({ ...bindingInput, expectedVersion: existing?.version ?? 0 })
      }
      counts.bindings += 1
    } else counts.skipped += 1
    applyStateEvent(store, { profile, deviceId, provider: providerId, sourceId: `device:${legacyId}`,
      observedAt: timestamp(row, 'updated_at'), states: normalizedStates(domain, state) }); counts.stateEvents += 1
    for (const stateRow of snapshot.deviceStates.filter(value => value.device_id === legacyId)) {
      const material = jsonRecord(stateRow.state_json); const keyMaterial = requiredText(stateRow, 'capability', 100)
      const key = keyMaterial.includes('temperature') ? 'temperature' : keyMaterial.includes('brightness') || keyMaterial.includes('speed') ? 'level'
        : keyMaterial.includes('on_off') ? 'power' : keyMaterial.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 100)
      const value = key === 'power' ? material.state === 'on' || material.value === true
        : scalar(material.value ?? material.state)
      if (!key || value === null) { counts.skipped += 1; continue }
      applyStateEvent(store, { profile, deviceId, provider: providerId, sourceId: `state:${requiredText(stateRow, 'id', 160)}`,
        observedAt: timestamp(stateRow, 'observed_at'), states: [{ key, value }] }); counts.stateEvents += 1
    }
  }
}
function countsFromStored(value: Record<string, number>): HomeMigrationCounts {
  const expected = Object.keys(emptyCounts()).sort(compareUtf8)
  if (stableJson(Object.keys(value).sort(compareUtf8)) !== stableJson(expected)) throw new Error('HOME_MIGRATION_RUN_CORRUPT')
  const result = emptyCounts()
  for (const key of expected as Array<keyof HomeMigrationCounts>) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('HOME_MIGRATION_RUN_CORRUPT')
    result[key] = value[key]
  }
  return result
}

export function syncLegacyHomeTwinSources(options: { profiles?: string[]; lease?: TwinImportRunLeaseOptions } = {}): HomeMigrationResult {
  const profiles = profilesOnDisk(options.profiles)
  let snapshots: LegacyProfileSnapshot[]
  try { snapshots = profiles.map(readProfile) } catch { throw new Error('HOME_MIGRATION_SOURCE_UNAVAILABLE') }
  const fingerprint = digest({ version: MIGRATION_VERSION, snapshots })
  let claim = claimTwinImportRun({ source: IMPORT_SOURCE, fingerprint, version: MIGRATION_VERSION }, options.lease)
  if (!claim.owner) {
    if (claim.status !== 'completed' || !claim.completedAt) throw new Error('HOME_MIGRATION_IN_PROGRESS')
    return { runId: claim.runId, status: 'completed', fingerprint, version: MIGRATION_VERSION, profiles,
      counts: countsFromStored(claim.counts), startedAt: claim.startedAt, completedAt: claim.completedAt }
  }
  const counts = emptyCounts(); counts.profiles = profiles.length
  try {
    for (const snapshot of snapshots) {
      claim = renewTwinImportRun(claim, options.lease)
      withPersonalTwinDb(db => {
        const store = new HomeTwinStore(db)
        store.transaction(() => importSnapshot(store, snapshot, counts))
      })
      claim = renewTwinImportRun(claim, options.lease)
    }
    const completed = completeTwinImportRun(claim, countsRecord(counts), options.lease)
    return { runId: completed.runId, status: 'completed', fingerprint, version: MIGRATION_VERSION, profiles,
      counts, startedAt: completed.startedAt, completedAt: completed.completedAt! }
  } catch (error) {
    const code = error instanceof Error && /^HOME_MIGRATION_[A-Z_]+$/.test(error.message) ? error.message : 'HOME_MIGRATION_FAILED'
    try { failTwinImportRun(claim, code, countsRecord(counts), options.lease) } catch (failure) {
      if (failure instanceof Error && failure.message === 'TWIN_IMPORT_RUN_LEASE_LOST') throw new Error('HOME_MIGRATION_LEASE_LOST')
      throw failure
    }
    throw new Error(code)
  }
}

export function listLegacyHomeProfiles(): string[] { return profilesOnDisk() }
