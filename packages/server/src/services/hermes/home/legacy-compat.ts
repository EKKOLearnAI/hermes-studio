import { withPersonalTwinDb } from '../personal-twin/database'
import { HomeTwinStore } from './store'

type JsonObject = Record<string, unknown>

export interface LegacyHomeRoom {
  id: string; name: string; floorName: string; x: number | null; y: number | null
  w: number | null; h: number | null; color: string; createdAt: string; updatedAt: string
}
export interface LegacyHomeFurniture {
  id: string; roomId: string; name: string; furnitureType: string; x: number | null; y: number | null
  w: number | null; h: number | null; createdAt: string; updatedAt: string
}
export interface LegacyHomeCompartment {
  id: string; furnitureId: string; name: string; createdAt: string; updatedAt: string
}
export interface LegacyHomeInventoryBatch {
  id: string; name: string; quantity: number; unit: string; expiryDate: string | null
  notes: string; createdAt: string; updatedAt: string
}
export interface LegacyHomePlacement {
  id: string; targetType: string; targetId: string; roomId: string | null; furnitureId: string | null
  compartmentId: string | null; x: number | null; y: number | null; z: number | null
  createdAt: string; updatedAt: string
}
export interface LegacyHomeDevice {
  id: string; externalId: string; provider: string; name: string; roomId: string | null
  capabilities: string[]; state: JsonObject; createdAt: string; updatedAt: string
}
export interface LegacyHomeOverview {
  generatedAt: string; profile: string; rooms: LegacyHomeRoom[]; furniture: LegacyHomeFurniture[]
  compartments: LegacyHomeCompartment[]; inventory: LegacyHomeInventoryBatch[]
  placements: LegacyHomePlacement[]; devices: LegacyHomeDevice[]
}
export type LegacyHomeMap = Omit<LegacyHomeOverview, 'inventory'>

function record(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback }
function nullableText(value: unknown): string | null { return typeof value === 'string' ? value : null }
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function source(attributes: JsonObject, profile: string, table: string): JsonObject | null {
  const value = record(attributes.legacySource)
  return value.system === 'home-state-v1' && value.profile === profile && value.table === table ? value : null
}
function sourceTime(attributes: JsonObject, key: 'sourceCreatedAt' | 'sourceUpdatedAt', fallback: string): string {
  return text(attributes[key], fallback)
}
function geometry(attributes: JsonObject): JsonObject { return record(attributes.geometry) }
function byCreatedAt<T extends { createdAt: string; id: string }>(left: T, right: T): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}
function placement(value: unknown, profile: string, attributes: JsonObject): LegacyHomePlacement | null {
  const item = record(value)
  const id = text(item.id)
  if (!id || !source(attributes, profile, 'home_placements')) return null
  return {
    id, targetType: text(item.targetType), targetId: text(item.targetId), roomId: nullableText(item.roomId),
    furnitureId: nullableText(item.furnitureId), compartmentId: nullableText(item.compartmentId),
    x: numberOrNull(item.x), y: numberOrNull(item.y), z: numberOrNull(item.z),
    createdAt: text(item.createdAt), updatedAt: text(item.updatedAt),
  }
}

export function getLegacyHomeOverview(profile = 'default'): LegacyHomeOverview {
  const normalizedProfile = profile.trim() || 'default'
  return withPersonalTwinDb(db => {
    const store = new HomeTwinStore(db)
    const spaces = store.listSpaces({ limit: 200 })
    const spaceLegacyId = new Map(spaces.map(item => [item.id, text(record(item.attributes.legacySource).id)]))
    const rooms = spaces.flatMap((item): LegacyHomeRoom[] => {
      const attributes = item.attributes
      const provenance = source(attributes, normalizedProfile, 'home_rooms')
      if (!provenance) return []
      const position = geometry(attributes)
      return [{
        id: text(provenance.id), name: item.name, floorName: text(attributes.floorName, '1F'),
        x: numberOrNull(position.x), y: numberOrNull(position.y), w: numberOrNull(position.w), h: numberOrNull(position.h),
        color: text(attributes.color, '#d4d4d8'), createdAt: sourceTime(attributes, 'sourceCreatedAt', item.createdAt),
        updatedAt: sourceTime(attributes, 'sourceUpdatedAt', item.updatedAt),
      }]
    }).sort(byCreatedAt)
    const furniture = spaces.flatMap((item): LegacyHomeFurniture[] => {
      const attributes = item.attributes
      const provenance = source(attributes, normalizedProfile, 'home_furniture')
      if (!provenance) return []
      const position = geometry(attributes)
      return [{
        id: text(provenance.id), roomId: item.parentSpaceId ? (spaceLegacyId.get(item.parentSpaceId) ?? '') : '',
        name: item.name, furnitureType: text(attributes.furnitureType, 'furniture'), x: numberOrNull(position.x),
        y: numberOrNull(position.y), w: numberOrNull(position.w), h: numberOrNull(position.h),
        createdAt: sourceTime(attributes, 'sourceCreatedAt', item.createdAt),
        updatedAt: sourceTime(attributes, 'sourceUpdatedAt', item.updatedAt),
      }]
    }).sort(byCreatedAt)
    const compartments = spaces.flatMap((item): LegacyHomeCompartment[] => {
      const attributes = item.attributes
      const provenance = source(attributes, normalizedProfile, 'home_compartments')
      if (!provenance) return []
      return [{
        id: text(provenance.id), furnitureId: item.parentSpaceId ? (spaceLegacyId.get(item.parentSpaceId) ?? '') : '',
        name: item.name, createdAt: sourceTime(attributes, 'sourceCreatedAt', item.createdAt),
        updatedAt: sourceTime(attributes, 'sourceUpdatedAt', item.updatedAt),
      }]
    }).sort(byCreatedAt)
    const inventory = store.listInventoryItems({ limit: 200 }).flatMap((item): LegacyHomeInventoryBatch[] => {
      const attributes = item.attributes
      const provenance = source(attributes, normalizedProfile, 'home_inventory_batches')
      if (!provenance) return []
      return [{
        id: text(provenance.id), name: item.name, quantity: item.quantity, unit: text(attributes.legacyUnit, item.unit),
        expiryDate: nullableText(attributes.expiryDate), notes: text(attributes.notes),
        createdAt: sourceTime(attributes, 'sourceCreatedAt', item.createdAt),
        updatedAt: sourceTime(attributes, 'sourceUpdatedAt', item.updatedAt),
      }]
    }).sort(byCreatedAt)
    const placements = store.listObjects({ kind: 'legacy-placement', limit: 200 })
      .flatMap(item => {
        const value = placement(item.attributes.legacyPlacement, normalizedProfile, item.attributes)
        return value ? [value] : []
      }).sort(byCreatedAt)
    const devices = store.listDevices({ limit: 200 }).flatMap((item): LegacyHomeDevice[] => {
      const attributes = item.attributes
      const provenance = source(attributes, normalizedProfile, 'home_devices')
      if (!provenance) return []
      const binding = store.listBindings({ deviceId: item.id, limit: 50 })
        .find(candidate => record(candidate.metadata).legacySource !== undefined)
      const capabilities = Array.isArray(attributes.legacyCapabilities)
        ? attributes.legacyCapabilities.filter((value): value is string => typeof value === 'string') : []
      const state = record(attributes.legacyState)
      return [{
        id: text(provenance.id), externalId: text(attributes.legacyExternalId, binding?.externalId ?? ''),
        provider: text(attributes.legacyProvider, binding?.provider ?? 'home_assistant'), name: item.name,
        roomId: nullableText(attributes.legacyRoomId), capabilities, state,
        createdAt: sourceTime(attributes, 'sourceCreatedAt', item.createdAt),
        updatedAt: sourceTime(attributes, 'sourceUpdatedAt', item.updatedAt),
      }]
    }).sort(byCreatedAt)
    return { generatedAt: new Date().toISOString(), profile: normalizedProfile, rooms, furniture,
      compartments, inventory, placements, devices }
  })
}

export function getLegacyHomeMap(profile = 'default'): LegacyHomeMap {
  const { inventory: _inventory, ...map } = getLegacyHomeOverview(profile)
  return map
}

export function getLegacyHomeLayout(profile = 'default'): JsonObject {
  const normalizedProfile = profile.trim() || 'default'
  return withPersonalTwinDb(db => {
    const item = new HomeTwinStore(db).listObjects({ kind: 'layout-document', limit: 200 })
      .find(candidate => source(candidate.attributes, normalizedProfile, 'home_layouts'))
    const document = record(item?.attributes.document)
    if (Object.keys(document).length) return document
    return {
      version: 1, unit: 'cm', canvas: { width: 1200, height: 900, scale: 10 },
      floors: [{ id: 'floor-1', name: '1F', elevation: 0, height: 280 }],
      rooms: [], walls: [], openings: [], furniture: [], placements: [],
    }
  })
}
