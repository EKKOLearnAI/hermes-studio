import { createHash } from 'node:crypto'
import type { HomeDevice, HomeDeviceState, HomeInventoryItem, HomeSpace } from './types'
import { HomeTwinStore } from './store'

export const HOME_PROJECTION_RULE_VERSION = 'home-rules-v1'
export const HOME_SENSOR_STALE_AFTER_MS = 30 * 60_000
const MAX_PROJECTED_RECORDS = 200

export interface HomeProjection {
  key: string
  subjectId: string
  value: Record<string, unknown>
  sourceRecordId: string
  version: number
  updatedAt: string
}

export interface HomeSafeActionCandidate {
  id: string
  kind: 'refresh_device' | 'review_inventory' | 'review_environment'
  subjectId: string
  capabilityId: 'home.device.refresh' | null
  target: string | null
  priority: number
  risk: 'low'
  automatic: false
  externalWrite: false
  reasonCodes: string[]
  rationale: string
  evidence: Array<{ projectionKey: string; subjectId: string; sourceRecordId: string }>
}

export interface HomeProjectionResult {
  projections: HomeProjection[]
  candidates: HomeSafeActionCandidate[]
  computedAt: string
  ruleVersion: string
}

export interface ComputeHomeProjectionOptions {
  computedAt: string
}

interface PreparedProjection {
  key: string
  subjectId: string
  value: Record<string, unknown>
  sourceRecordId: string
}

interface ProjectionRow {
  projection_key: string
  subject_id: string
  value_json: string
  source_record_id: string
  version: number
  updated_at: string
}

interface DeviceProjectionMaterial {
  device: HomeDevice
  states: HomeDeviceState[]
  latestObservedAt: string | null
  freshness: 'fresh' | 'stale' | 'future' | 'missing' | 'not_applicable'
  maintenanceSignals: Array<{ code: string; message: string }>
}

export function computeAndPersistHomeProjections(
  store: HomeTwinStore,
  options: ComputeHomeProjectionOptions,
): HomeProjectionResult {
  const computedAt = canonicalTimestamp(options.computedAt)
  const computedMs = Date.parse(computedAt)
  assertBounds(store)
  const spaces = store.listSpaces({ limit: MAX_PROJECTED_RECORDS })
  const devices = store.listDevices({ limit: MAX_PROJECTED_RECORDS })
  const inventory = store.listInventoryItems({ limit: MAX_PROJECTED_RECORDS })
  const materials = devices.map(device => deviceMaterial(store, device, computedMs))
  const prepared: PreparedProjection[] = []

  for (const space of spaces) prepared.push(roomEnvironmentProjection(space, materials, computedAt))
  for (const material of materials) prepared.push(...deviceProjections(material, computedAt))
  for (const item of inventory) prepared.push(inventoryProjection(item, computedAt))
  prepared.sort((left, right) => compareText(left.key, right.key) || compareText(left.subjectId, right.subjectId))

  const projections = persistProjectionBatch(store, prepared, computedAt)
  const byAddress = new Map(projections.map(item => [`${item.key}\0${item.subjectId}`, item]))
  const candidates = decideCandidates(spaces, materials, inventory, byAddress)
  return { projections, candidates, computedAt, ruleVersion: HOME_PROJECTION_RULE_VERSION }
}

function roomEnvironmentProjection(
  space: HomeSpace,
  materials: DeviceProjectionMaterial[],
  computedAt: string,
): PreparedProjection {
  const devices = materials.filter(item => item.device.spaceId === space.id)
  const metrics: Record<string, unknown> = {}
  for (const metric of ['humidity', 'temperature'] as const) {
    const candidates = devices.filter(item => item.device.deviceClass === metric)
      .map(item => ({ material: item, state: preferredNumericState(item.states) }))
      .filter((item): item is { material: DeviceProjectionMaterial; state: HomeDeviceState & { value: number } } => (
        item.state !== null && typeof item.state.value === 'number' && Number.isFinite(item.state.value)
      ))
      .sort((left, right) => compareText(right.state.observedAt, left.state.observedAt)
        || compareText(left.material.device.id, right.material.device.id))
    const selected = candidates[0]
    if (selected) {
      metrics[metric] = {
        deviceId: selected.material.device.id,
        value: selected.state.value,
        unit: unitFor(selected.material.device, metric),
        observedAt: selected.state.observedAt,
        freshness: selected.material.freshness,
      }
    }
  }
  const value = envelope(computedAt, {
    roomKind: space.kind,
    deviceCounts: {
      total: devices.length,
      available: devices.filter(item => item.device.availability === 'available').length,
      unavailable: devices.filter(item => item.device.availability === 'unavailable').length,
      unknown: devices.filter(item => item.device.availability === 'unknown').length,
    },
    metrics,
  }, [{ code: 'ROOM_ENVIRONMENT_SUMMARY', message: 'Derived from current normalized device state in this space.' }])
  return projection('home.room.environment', space.id, value)
}

function deviceProjections(material: DeviceProjectionMaterial, computedAt: string): PreparedProjection[] {
  const { device, latestObservedAt, freshness, maintenanceSignals } = material
  return [
    projection('home.device.availability', device.id, envelope(computedAt, {
      status: device.availability,
      available: device.availability === 'available',
    }, [{
      code: `DEVICE_${device.availability.toUpperCase()}`,
      message: `Device availability is ${device.availability}.`,
    }])),
    projection('home.device.freshness', device.id, envelope(computedAt, {
      status: freshness,
      latestObservedAt,
      thresholdMs: sensorDevice(device) ? HOME_SENSOR_STALE_AFTER_MS : null,
    }, [{
      code: `DEVICE_STATE_${freshness.toUpperCase()}`,
      message: sensorDevice(device)
        ? 'Sensor freshness is derived from its latest normalized observation.'
        : 'Freshness checks apply only to sensor-like devices.',
    }])),
    projection('home.device.maintenance', device.id, envelope(computedAt, {
      required: maintenanceSignals.length > 0,
      signals: maintenanceSignals,
    }, maintenanceSignals.length > 0
      ? maintenanceSignals
      : [{ code: 'NO_MAINTENANCE_SIGNAL', message: 'No bounded maintenance signal is currently active.' }])),
  ]
}

function inventoryProjection(item: HomeInventoryItem, computedAt: string): PreparedProjection {
  const level = item.lowStockThreshold !== null && item.quantity <= item.lowStockThreshold ? 'low' : 'normal'
  return projection('home.inventory.warning', item.id, envelope(computedAt, {
    level,
    quantity: item.quantity,
    threshold: item.lowStockThreshold,
    unit: item.unit,
  }, [{
    code: level === 'low' ? 'INVENTORY_LOW' : 'INVENTORY_NORMAL',
    message: level === 'low' ? 'Quantity is at or below the configured threshold.' : 'Quantity is above the warning threshold.',
  }]))
}

function deviceMaterial(store: HomeTwinStore, device: HomeDevice, computedMs: number): DeviceProjectionMaterial {
  const states = store.listDeviceStates({ deviceId: device.id, limit: MAX_PROJECTED_RECORDS })
  const latestObservedAt = states.map(state => state.observedAt).sort(compareText).at(-1) ?? null
  let freshness: DeviceProjectionMaterial['freshness'] = 'not_applicable'
  if (sensorDevice(device)) {
    if (latestObservedAt === null) freshness = 'missing'
    else {
      const age = computedMs - Date.parse(latestObservedAt)
      freshness = age < 0 ? 'future' : age > HOME_SENSOR_STALE_AFTER_MS ? 'stale' : 'fresh'
    }
  }
  const maintenanceSignals: DeviceProjectionMaterial['maintenanceSignals'] = []
  if (device.availability === 'unavailable') {
    maintenanceSignals.push({ code: 'DEVICE_UNAVAILABLE', message: 'The provider reports this device as unavailable.' })
  } else if (device.availability === 'unknown') {
    maintenanceSignals.push({ code: 'DEVICE_AVAILABILITY_UNKNOWN', message: 'The provider cannot establish device availability.' })
  }
  if (freshness === 'stale') maintenanceSignals.push({ code: 'STALE_SENSOR', message: 'The latest sensor observation is stale.' })
  if (freshness === 'missing') maintenanceSignals.push({ code: 'MISSING_SENSOR_STATE', message: 'No normalized sensor state is available.' })
  if (freshness === 'future') maintenanceSignals.push({ code: 'FUTURE_SENSOR_STATE', message: 'The sensor timestamp is in the future.' })
  maintenanceSignals.sort((left, right) => compareText(left.code, right.code))
  return { device, states, latestObservedAt, freshness, maintenanceSignals }
}

function decideCandidates(
  spaces: HomeSpace[],
  materials: DeviceProjectionMaterial[],
  inventory: HomeInventoryItem[],
  projections: Map<string, HomeProjection>,
): HomeSafeActionCandidate[] {
  const candidates: HomeSafeActionCandidate[] = []
  for (const material of materials) {
    const reasons = material.maintenanceSignals.map(signal => signal.code)
    if (reasons.length === 0) continue
    const evidence = requireProjection(projections, 'home.device.maintenance', material.device.id)
    candidates.push(candidate({
      kind: 'refresh_device',
      subjectId: material.device.id,
      capabilityId: 'home.device.refresh',
      target: `home:device:${material.device.id}`,
      priority: material.device.availability === 'unavailable' ? 80 : 60,
      reasonCodes: reasons,
      rationale: material.maintenanceSignals.map(signal => signal.message).join(' '),
      evidence,
    }))
  }
  for (const item of inventory) {
    if (item.lowStockThreshold === null || item.quantity > item.lowStockThreshold) continue
    const evidence = requireProjection(projections, 'home.inventory.warning', item.id)
    candidates.push(candidate({
      kind: 'review_inventory', subjectId: item.id, capabilityId: null, target: null, priority: 40,
      reasonCodes: ['INVENTORY_LOW'], rationale: 'Inventory is at or below its configured warning threshold.', evidence,
    }))
  }
  for (const space of spaces) {
    const projectionValue = requireProjection(projections, 'home.room.environment', space.id)
    const state = projectionValue.value.state as { metrics?: Record<string, { value?: unknown; freshness?: unknown }> }
    const extreme = Object.entries(state.metrics ?? {}).filter(([metric, value]) => value.freshness === 'fresh'
      && typeof value.value === 'number'
      && ((metric === 'temperature' && (value.value < 16 || value.value > 30))
        || (metric === 'humidity' && (value.value < 20 || value.value > 80))))
    if (extreme.length === 0) continue
    candidates.push(candidate({
      kind: 'review_environment', subjectId: space.id, capabilityId: null, target: null, priority: 50,
      reasonCodes: extreme.map(([metric]) => `ROOM_${metric.toUpperCase()}_OUT_OF_RANGE`).sort(compareText),
      rationale: 'A fresh room environment metric is outside the conservative review range.', evidence: projectionValue,
    }))
  }
  return candidates.sort((left, right) => right.priority - left.priority || compareText(left.id, right.id))
}

function candidate(input: Omit<HomeSafeActionCandidate, 'id' | 'risk' | 'automatic' | 'externalWrite' | 'evidence'> & {
  evidence: HomeProjection
}): HomeSafeActionCandidate {
  const reasonCodes = [...input.reasonCodes].sort(compareText)
  return {
    id: `candidate:home:${digest(stableJson({ kind: input.kind, subjectId: input.subjectId, reasonCodes })).slice(0, 24)}`,
    kind: input.kind,
    subjectId: input.subjectId,
    capabilityId: input.capabilityId,
    target: input.target,
    priority: input.priority,
    risk: 'low',
    automatic: false,
    externalWrite: false,
    reasonCodes,
    rationale: input.rationale,
    evidence: [{
      projectionKey: input.evidence.key,
      subjectId: input.evidence.subjectId,
      sourceRecordId: input.evidence.sourceRecordId,
    }],
  }
}

function projection(key: string, subjectId: string, value: Record<string, unknown>): PreparedProjection {
  return {
    key,
    subjectId,
    value,
    sourceRecordId: `home-projection-${digest(stableJson({ key, subjectId, value }))}`,
  }
}

function envelope(
  computedAt: string,
  state: Record<string, unknown>,
  rationale: Array<{ code: string; message: string }>,
): Record<string, unknown> {
  return { schemaVersion: 1, ruleVersion: HOME_PROJECTION_RULE_VERSION, computedAt, state, rationale }
}

function persistProjectionBatch(
  store: HomeTwinStore,
  prepared: PreparedProjection[],
  updatedAt: string,
): HomeProjection[] {
  if (prepared.length < 1 || prepared.length > 1_024) throw new Error('HOME_PROJECTION_INVALID_BATCH')
  const addresses = new Set(prepared.map(item => `${item.key}\0${item.subjectId}`))
  if (addresses.size !== prepared.length) throw new Error('HOME_PROJECTION_DUPLICATE_ADDRESS')
  const encoded = prepared.map(item => ({ item, valueJson: boundedStableJson(item.value) }))
  const db = store.database
  db.exec('BEGIN IMMEDIATE')
  try {
    const results: HomeProjection[] = []
    for (const { item, valueJson } of encoded) {
      if (!db.prepare('SELECT 1 FROM twin_entities WHERE id=?').get(item.subjectId)) {
        throw new Error(`HOME_PROJECTION_SUBJECT_NOT_FOUND:${item.subjectId}`)
      }
      const current = db.prepare('SELECT * FROM twin_projections WHERE projection_key=? AND subject_id=?')
        .get(item.key, item.subjectId) as ProjectionRow | undefined
      if (!current || current.value_json !== valueJson || current.source_record_id !== item.sourceRecordId) {
        db.prepare(`INSERT INTO twin_projections
          (projection_key,subject_id,value_json,source_record_id,version,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(projection_key,subject_id) DO UPDATE SET
          value_json=excluded.value_json,source_record_id=excluded.source_record_id,
          version=excluded.version,updated_at=excluded.updated_at`).run(
          item.key, item.subjectId, valueJson, item.sourceRecordId, (current?.version ?? 0) + 1, updatedAt,
        )
      }
      const row = db.prepare('SELECT * FROM twin_projections WHERE projection_key=? AND subject_id=?')
        .get(item.key, item.subjectId) as unknown as ProjectionRow
      results.push(projectionFromRow(row))
    }
    db.exec('COMMIT')
    return results
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function requireProjection(projections: Map<string, HomeProjection>, key: string, subjectId: string): HomeProjection {
  const value = projections.get(`${key}\0${subjectId}`)
  if (!value) throw new Error('HOME_PROJECTION_MISSING_EVIDENCE')
  return value
}

function projectionFromRow(row: ProjectionRow): HomeProjection {
  return {
    key: row.projection_key,
    subjectId: row.subject_id,
    value: JSON.parse(row.value_json) as Record<string, unknown>,
    sourceRecordId: row.source_record_id,
    version: row.version,
    updatedAt: row.updated_at,
  }
}

function preferredNumericState(states: HomeDeviceState[]): HomeDeviceState | null {
  const candidates = states.filter(state => ['temperature', 'value', 'level'].includes(state.key))
    .sort((left, right) => compareText(right.observedAt, left.observedAt) || compareText(left.key, right.key))
  return candidates[0] ?? null
}

function unitFor(device: HomeDevice, metric: 'humidity' | 'temperature'): string {
  return typeof device.attributes.unit === 'string' && device.attributes.unit.length <= 40
    ? device.attributes.unit
    : metric === 'humidity' ? '%' : '°C'
}

function sensorDevice(device: HomeDevice): boolean {
  return ['humidity', 'temperature'].includes(device.deviceClass)
    || ['sensor', 'binary_sensor'].includes(String(device.attributes.entityDomain ?? ''))
}

function assertBounds(store: HomeTwinStore): void {
  for (const table of ['twin_home_spaces', 'twin_home_devices', 'twin_home_inventory_items']) {
    const row = store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    if (row.count > MAX_PROJECTED_RECORDS) throw new Error('HOME_PROJECTION_INPUT_LIMIT_EXCEEDED')
  }
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || Number.isNaN(Date.parse(value))) {
    throw new Error('HOME_PROJECTION_INVALID_COMPUTED_AT')
  }
  return new Date(value).toISOString()
}

function boundedStableJson(value: unknown): string {
  const encoded = stableJson(value)
  if (Buffer.byteLength(encoded, 'utf8') > 65_536) throw new Error('HOME_PROJECTION_VALUE_TOO_LARGE')
  return encoded
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('HOME_PROJECTION_VALUE_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') throw new Error('HOME_PROJECTION_VALUE_INVALID')
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  if (keys.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) {
    throw new Error('HOME_PROJECTION_VALUE_INVALID')
  }
  return `{${(keys as string[]).sort(compareText).map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function compareText(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)) }
