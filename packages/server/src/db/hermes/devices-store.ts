import { getDb, jsonGet, jsonGetAll, jsonSet } from '../index'
import { DEVICES_TABLE } from './schemas'
import type { LanDeviceInfo } from '../../services/lan-discovery'

export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'blocked'

export type DeviceRecord = Omit<LanDeviceInfo, 'last_seen_at'> & {
  status: DeviceStatus
  requested_at: number
  decided_at: number | null
  last_seen_at: number
  updated_at: number
}

type StoredDeviceRow = {
  id: string
  status: DeviceStatus
  device_public_key: string
  computer_name: string
  endpoint_kind: LanDeviceInfo['endpoint_kind']
  ip: string
  http_port: number
  url: string
  os_json: string
  hermes_agent_version: string
  hermes_web_ui_version: string
  response_ms: number
  requested_at: number
  decided_at: number | null
  last_seen_at: number
  updated_at: number
}

function parseTime(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value
  if (!value) return Date.now()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function normalizeStatus(value: unknown): DeviceStatus {
  return value === 'approved' || value === 'rejected' || value === 'blocked' ? value : 'pending'
}

function rowToRecord(row: StoredDeviceRow | Record<string, any>): DeviceRecord {
  let os: LanDeviceInfo['os'] = { type: '', platform: '' as NodeJS.Platform, release: '', arch: '' }
  try {
    os = JSON.parse(String(row.os_json || '{}'))
  } catch {
    // Keep the empty OS fallback.
  }

  return {
    id: String(row.id),
    device_id: String(row.id),
    status: normalizeStatus(row.status),
    device_public_key: String(row.device_public_key || ''),
    computer_name: String(row.computer_name || ''),
    endpoint_kind: row.endpoint_kind === 'web' || row.endpoint_kind === 'desktop' ? row.endpoint_kind : 'custom',
    ip: String(row.ip || ''),
    http_port: Number(row.http_port || 0),
    url: String(row.url || ''),
    os,
    hermes_agent_version: String(row.hermes_agent_version || ''),
    hermes_web_ui_version: String(row.hermes_web_ui_version || ''),
    response_ms: Number(row.response_ms || 0),
    requested_at: Number(row.requested_at || 0),
    decided_at: row.decided_at == null ? null : Number(row.decided_at),
    last_seen_at: Number(row.last_seen_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

function deviceToRow(device: LanDeviceInfo, status: DeviceStatus, requestedAt: number, decidedAt: number | null, now: number) {
  return {
    id: device.id,
    status,
    device_public_key: device.device_public_key,
    computer_name: device.computer_name,
    endpoint_kind: device.endpoint_kind,
    ip: device.ip,
    http_port: device.http_port,
    url: device.url,
    os_json: JSON.stringify(device.os || {}),
    hermes_agent_version: device.hermes_agent_version,
    hermes_web_ui_version: device.hermes_web_ui_version,
    response_ms: device.response_ms,
    requested_at: requestedAt,
    decided_at: decidedAt,
    last_seen_at: parseTime(device.last_seen_at),
    updated_at: now,
  }
}

export function listDeviceRecords(): DeviceRecord[] {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(DEVICES_TABLE))
      .map(rowToRecord)
      .sort((a, b) => b.last_seen_at - a.last_seen_at)
  }

  const rows = db.prepare(`SELECT * FROM ${DEVICES_TABLE} ORDER BY last_seen_at DESC`).all() as StoredDeviceRow[]
  return rows.map(rowToRecord)
}

export function getDeviceRecord(id: string): DeviceRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(DEVICES_TABLE, id)
    return row ? rowToRecord(row) : null
  }

  const row = db.prepare(`SELECT * FROM ${DEVICES_TABLE} WHERE id = ?`).get(id) as StoredDeviceRow | undefined
  return row ? rowToRecord(row) : null
}

export function upsertDiscoveredDevices(devices: LanDeviceInfo[]): void {
  for (const device of devices) upsertDiscoveredDevice(device)
}

export function upsertDiscoveredDevice(device: LanDeviceInfo): DeviceRecord {
  const now = Date.now()
  const existing = getDeviceRecord(device.id)
  const status = existing?.status || 'pending'
  const requestedAt = existing?.requested_at || now
  const decidedAt = existing?.decided_at || null
  const row = deviceToRow(device, status, requestedAt, decidedAt, now)

  const db = getDb()
  if (!db) {
    jsonSet(DEVICES_TABLE, device.id, row)
    return rowToRecord(row)
  }

  db.prepare(`
    INSERT INTO ${DEVICES_TABLE} (
      id, status, computer_name, endpoint_kind, ip, http_port, url, os_json,
      hermes_agent_version, hermes_web_ui_version, response_ms, device_public_key,
      requested_at, decided_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      device_public_key = excluded.device_public_key,
      computer_name = excluded.computer_name,
      endpoint_kind = excluded.endpoint_kind,
      ip = excluded.ip,
      http_port = excluded.http_port,
      url = excluded.url,
      os_json = excluded.os_json,
      hermes_agent_version = excluded.hermes_agent_version,
      hermes_web_ui_version = excluded.hermes_web_ui_version,
      response_ms = excluded.response_ms,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `).run(
    row.id,
    row.status,
    row.computer_name,
    row.endpoint_kind,
    row.ip,
    row.http_port,
    row.url,
    row.os_json,
    row.hermes_agent_version,
    row.hermes_web_ui_version,
    row.response_ms,
    row.device_public_key,
    row.requested_at,
    row.decided_at,
    row.last_seen_at,
    row.updated_at,
  )
  return getDeviceRecord(device.id)!
}

export function requestDeviceLink(device: LanDeviceInfo): DeviceRecord {
  const existing = getDeviceRecord(device.id)
  const record = upsertDiscoveredDevice(device)
  if (existing?.status === 'blocked') return record
  if (existing?.status === 'approved') return record
  if (existing?.status !== 'pending') return updateDeviceStatus(device.id, 'pending')
  return record
}

export function updateDeviceStatus(id: string, status: DeviceStatus): DeviceRecord {
  const existing = getDeviceRecord(id)
  if (!existing) throw new Error('Device not found')
  const now = Date.now()
  const decidedAt = status === 'pending' ? null : now

  const db = getDb()
  if (!db) {
    jsonSet(DEVICES_TABLE, id, {
      ...existing,
      os_json: JSON.stringify(existing.os || {}),
      status,
      decided_at: decidedAt,
      updated_at: now,
    })
    return getDeviceRecord(id)!
  }

  db.prepare(`UPDATE ${DEVICES_TABLE} SET status = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
    .run(status, decidedAt, now, id)
  return getDeviceRecord(id)!
}
