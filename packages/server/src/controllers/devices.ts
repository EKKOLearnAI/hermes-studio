import {
  listDeviceRecords,
  requestDeviceLink,
  updateDeviceStatus,
  upsertDiscoveredDevices,
  type DeviceStatus,
} from '../db/hermes/devices-store'
import { getLanDiscoveryCache, getLanEndpointKind, scanLanDevices, type LanDeviceInfo } from '../services/lan-discovery'
import { verifyDeviceSignature } from '../services/system-info'

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

function devicesPayload() {
  const cache = getLanDiscoveryCache()
  return {
    scanning: cache.scanning,
    last_scanned_at: cache.last_scanned_at,
    devices: listDeviceRecords(),
  }
}

export async function listDevices(ctx: any) {
  ctx.body = devicesPayload()
}

export async function scanDevices(ctx: any) {
  const result = await scanLanDevices()
  upsertDiscoveredDevices(result.devices)
  ctx.body = devicesPayload()
}

function normalizeIp(ctx: any): string {
  const ip = String(ctx.ip || ctx.request?.ip || '')
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function bodyToDevice(ctx: any, body: any): LanDeviceInfo | null {
  const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
  const publicKey = typeof body?.device_public_key === 'string' ? body.device_public_key.trim() : ''
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

  const record = requestDeviceLink(device)
  ctx.body = { status: record.status }
}

function transitionDevice(ctx: any, status: DeviceStatus) {
  try {
    ctx.body = updateDeviceStatus(ctx.params.id, status)
  } catch {
    ctx.status = 404
    ctx.body = { error: 'Device not found' }
  }
}

export async function approveDevice(ctx: any) {
  transitionDevice(ctx, 'approved')
}

export async function rejectDevice(ctx: any) {
  transitionDevice(ctx, 'rejected')
}

export async function blockDevice(ctx: any) {
  transitionDevice(ctx, 'blocked')
}

export async function unblockDevice(ctx: any) {
  transitionDevice(ctx, 'pending')
}
