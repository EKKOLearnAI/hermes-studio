import {
  DuplicateDeviceRequestError,
  getDeviceRelation,
  listDeviceRelations,
  listPendingInboundRequests,
  requestInboundDeviceLink,
  updateInboundStatus,
  updateOutboundStatus,
  type DeviceInboundStatus,
  type DeviceOutboundStatus,
} from '../db/hermes/devices-store'
import { getLanDiscoveryCache, getLanEndpointKind, scanLanDevices, type LanDeviceInfo } from '../services/lan-discovery'
import { createDeviceSignature, getPublicSystemInfo, verifyDeviceSignature } from '../services/system-info'
import { config } from '../config'
import { randomUUID } from 'crypto'

const REQUEST_TTL_MS = 5 * 60 * 1000
const seenRequestNonces = new Map<string, number>()

function rememberNonce(deviceId: string, nonce: string, timestamp: number): boolean {
  const now = Date.now()
  for (const [key, expiresAt] of seenRequestNonces) {
    if (expiresAt <= now) seenRequestNonces.delete(key)
  }

  const key = `${deviceId}:${nonce}`
  if (seenRequestNonces.has(key)) return false
  seenRequestNonces.set(key, timestamp + REQUEST_TTL_MS)
  return true
}

function parseRemoteStatus(status: unknown): DeviceOutboundStatus | null {
  return status === 'none' ||
    status === 'pending' ||
    status === 'approved' ||
    status === 'rejected' ||
    status === 'blocked'
    ? status
    : null
}

async function fetchRemoteLinkStatus(device: LanDeviceInfo): Promise<DeviceOutboundStatus | null> {
  const timestamp = Date.now()
  const nonce = randomUUID()
  const localInfo = await getPublicSystemInfo()
  const signature = await createDeviceSignature(nonce, timestamp)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(`${device.url.replace(/\/$/, '')}/api/devices/link-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: localInfo.device_id,
        device_public_key: localInfo.device_public_key,
        timestamp,
        nonce,
        signature,
      }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({})) as { status?: unknown }
    if (!response.ok) return null
    return parseRemoteStatus(data.status)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function syncOutboundStatuses(devices: LanDeviceInfo[]): Promise<Map<string, DeviceOutboundStatus>> {
  const statuses = new Map<string, DeviceOutboundStatus>()
  await Promise.all(devices.map(async device => {
    const status = await fetchRemoteLinkStatus(device)
    if (!status) return
    statuses.set(device.id, status)

    const existing = getDeviceRelation(device.id)
    if (status === 'pending') return
    if (status !== 'none' || existing?.outbound_status !== 'none') {
      updateOutboundStatus(device.id, status, device)
    }
  }))
  return statuses
}

async function devicesPayload() {
  const cache = getLanDiscoveryCache()
  const remoteStatuses = await syncOutboundStatuses(cache.devices)
  const relations = new Map(listDeviceRelations().map(device => [device.id, device]))
  return {
    scanning: cache.scanning,
    last_scanned_at: cache.last_scanned_at,
    devices: cache.devices.map(device => {
      const relation = relations.get(device.id)
      return {
        ...device,
        inbound_status: relation?.inbound_status || 'none',
        outbound_status: remoteStatuses.get(device.id) || relation?.outbound_status || 'none',
        requested_at: relation?.requested_at || 0,
        decided_at: relation?.decided_at || null,
        outbound_requested_at: relation?.outbound_requested_at || 0,
        outbound_decided_at: relation?.outbound_decided_at || null,
        updated_at: relation?.updated_at || 0,
      }
    }),
    requests: listPendingInboundRequests(),
  }
}

export async function listDevices(ctx: any) {
  ctx.body = await devicesPayload()
}

export async function scanDevices(ctx: any) {
  await scanLanDevices()
  ctx.body = await devicesPayload()
}

function findDiscoveredDevice(id: string): LanDeviceInfo | null {
  return getLanDiscoveryCache().devices.find(device => device.id === id) || null
}

function normalizeIp(ctx: any): string {
  const ip = String(ctx.ip || ctx.request?.ip || '')
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function bodyToDevice(ctx: any, body: any): LanDeviceInfo | null {
  const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
  const publicKey = typeof body?.device_public_key === 'string' ? body.device_public_key : ''
  const httpPort = Number(body?.http_port)
  if (!deviceId || !publicKey || !Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null
  const ip = normalizeIp(ctx)
  const endpointKind = body.endpoint_kind === 'web' || body.endpoint_kind === 'desktop' || body.endpoint_kind === 'custom'
    ? body.endpoint_kind
    : getLanEndpointKind(httpPort)

  return {
    id: deviceId,
    device_id: deviceId,
    device_public_key: publicKey,
    ip,
    http_port: httpPort,
    endpoint_kind: endpointKind,
    url: typeof body?.url === 'string' && body.url ? body.url : `http://${ip}:${httpPort}`,
    computer_name: String(body?.computer_name || ''),
    os: {
      type: String(body?.os?.type || ''),
      platform: String(body?.os?.platform || '') as NodeJS.Platform,
      release: String(body?.os?.release || ''),
      arch: String(body?.os?.arch || ''),
    },
    hermes_agent_version: String(body?.hermes_agent_version || ''),
    hermes_web_ui_version: String(body?.hermes_web_ui_version || ''),
    response_ms: 0,
    last_seen_at: new Date().toISOString(),
  }
}

export async function requestDeviceLinkController(ctx: any) {
  const body = ctx.request.body as any
  const timestamp = Number(body?.timestamp)
  const nonce = typeof body?.nonce === 'string' ? body.nonce : ''
  const signature = typeof body?.signature === 'string' ? body.signature : ''
  const device = bodyToDevice(ctx, body)

  if (!device || !Number.isFinite(timestamp) || !nonce || !signature) {
    ctx.status = 400
    ctx.body = { error: 'Invalid device request' }
    return
  }
  if (Math.abs(Date.now() - timestamp) > REQUEST_TTL_MS) {
    ctx.status = 400
    ctx.body = { error: 'Device request expired' }
    return
  }
  if (!verifyDeviceSignature({
    device_id: device.id,
    device_public_key: device.device_public_key,
    nonce,
    timestamp,
    signature,
  })) {
    ctx.status = 401
    ctx.body = { error: 'Invalid device signature' }
    return
  }
  if (!rememberNonce(device.id, nonce, timestamp)) {
    ctx.status = 409
    ctx.body = { error: 'Device request replayed' }
    return
  }

  try {
    const record = requestInboundDeviceLink(device)
    ctx.body = { status: record.inbound_status }
  } catch (err) {
    if (err instanceof DuplicateDeviceRequestError) {
      ctx.status = 409
      ctx.body = { error: 'Duplicate pairing request' }
      return
    }
    throw err
  }
}

export async function requestDeviceLinkStatusController(ctx: any) {
  const body = ctx.request.body as any
  const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
  const publicKey = typeof body?.device_public_key === 'string' ? body.device_public_key : ''
  const timestamp = Number(body?.timestamp)
  const nonce = typeof body?.nonce === 'string' ? body.nonce : ''
  const signature = typeof body?.signature === 'string' ? body.signature : ''

  if (!deviceId || !publicKey || !Number.isFinite(timestamp) || !nonce || !signature) {
    ctx.status = 400
    ctx.body = { error: 'Invalid device status request' }
    return
  }
  if (Math.abs(Date.now() - timestamp) > REQUEST_TTL_MS) {
    ctx.status = 400
    ctx.body = { error: 'Device status request expired' }
    return
  }
  if (!verifyDeviceSignature({
    device_id: deviceId,
    device_public_key: publicKey,
    nonce,
    timestamp,
    signature,
  })) {
    ctx.status = 401
    ctx.body = { error: 'Invalid device signature' }
    return
  }
  if (!rememberNonce(deviceId, nonce, timestamp)) {
    ctx.status = 409
    ctx.body = { error: 'Device status request replayed' }
    return
  }

  ctx.body = {
    status: getDeviceRelation(deviceId)?.inbound_status || 'none',
  }
}

async function transitionInboundDevice(ctx: any, status: DeviceInboundStatus) {
  try {
    updateInboundStatus(ctx.params.id, status, findDiscoveredDevice(ctx.params.id) || undefined)
    ctx.body = await devicesPayload()
  } catch {
    ctx.status = 404
    ctx.body = { error: 'Device not found' }
  }
}

export async function approveDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'approved')
}

export async function rejectDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'rejected')
}

export async function blockDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'blocked')
}

export async function unblockDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'none')
}

export async function requestDevicePairing(ctx: any) {
  const target = findDiscoveredDevice(ctx.params.id)
  if (!target) {
    ctx.status = 404
    ctx.body = { error: 'Device not found' }
    return
  }

  const timestamp = Date.now()
  const nonce = randomUUID()
  const localInfo = await getPublicSystemInfo()
  const signature = await createDeviceSignature(nonce, timestamp)
  const body = {
    ...localInfo,
    http_port: config.port,
    endpoint_kind: getLanEndpointKind(config.port),
    timestamp,
    nonce,
    signature,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${target.url.replace(/\/$/, '')}/api/devices/link-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({})) as { status?: unknown; error?: unknown }
    if (!response.ok) {
      ctx.status = response.status === 409 ? 409 : 502
      ctx.body = { error: typeof data.error === 'string' ? data.error : `Request failed: ${response.status}` }
      return
    }
    if (parseRemoteStatus(data.status) === 'approved') {
      updateOutboundStatus(target.id, 'approved', target)
    }
    ctx.body = await devicesPayload()
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Failed to request device pairing' }
  } finally {
    clearTimeout(timeout)
  }
}
