import type { Context } from 'koa'
import {
  createAppAuthorizationCode,
  listAppConnections,
  markCloudAppConnectionRevocationSynced,
  revokeAppConnection,
  findUserById,
} from '../services/app-relay/app-connections'
import { config } from '../public/config'
import { getLanBackendUrlForRequest } from '../services/network/lan-discovery'
import { getAppRelayClient } from '../services/app-relay/client'
import {
  APP_RELAY_CONNECTION_ID,
  ensureAppRelayHostClient,
  stopAppRelayHostClient,
} from '../services/app-relay/connection'
import {
  isLocalAppConnectionOnline,
  getLatestLocalAppEntitlementFailure,
  notifyLocalAppConnectionDeleted,
} from '../services/app-relay/server'
import { getDeviceId } from '../public/system-info'
import { getAppRelayRoute, isAppRelayRoute, type AppRelayRoute } from '../services/app-relay/route'

const APP_CONNECTION_QR_TYPE = 'hermes-studio.app-connection'
const APP_CONNECTION_QR_VERSION = 1

function connectionPayload(now = Math.floor(Date.now() / 1000)) {
  return listAppConnections().map(connection => ({
    id: connection.id,
    device_code: connection.device_code,
    device_name: connection.device_name,
    device_brand: connection.device_brand,
    device_model: connection.device_model,
    connection_type: connection.connection_type,
    user_id: connection.user_id,
    cloud_user_id: connection.cloud_user_id,
    username: findUserById(connection.user_id)?.username || '',
    token_expires_at: connection.token_expires_at,
    last_connected_at: connection.last_connected_at,
    active: connection.revoked_at == null && connection.token_expires_at > now,
    online: connection.connection_type === 'lan'
      ? isLocalAppConnectionOnline(connection.device_code, connection.connection_type)
      : getAppRelayClient(APP_RELAY_CONNECTION_ID)?.isCloudDeviceOnline(
          connection.device_code,
          connection.cloud_user_id,
        ) || false,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
  }))
}

export async function listAppConnectionsController(ctx: Context) {
  const connections = connectionPayload()
  const accessFailure = getLatestLocalAppEntitlementFailure()
  const failedConnection = accessFailure
    ? connections.find(connection => (
        connection.connection_type === 'lan'
        && connection.device_code === accessFailure.deviceCode
        && (!accessFailure.cloudUserId || connection.cloud_user_id === accessFailure.cloudUserId)
      )) || connections.find(connection => (
        connection.device_code === accessFailure.deviceCode
        && (!accessFailure.cloudUserId || connection.cloud_user_id === accessFailure.cloudUserId)
      ))
    : null
  ctx.body = {
    connections,
    access_failure: accessFailure
      ? {
          ...accessFailure,
          deviceName: failedConnection?.device_name || '',
        }
      : null,
  }
}

export async function deleteAppConnectionController(ctx: Context) {
  const id = Number(ctx.params.id)
  const connection = revokeAppConnection(id)
  if (!connection) {
    ctx.status = 404
    ctx.body = { error: 'App connection not found' }
    return
  }

  let notified = 0
  if (connection.connection_type === 'lan') {
    notified = notifyLocalAppConnectionDeleted(connection.device_code, connection.connection_type)
  } else {
    const client = getAppRelayClient(APP_RELAY_CONNECTION_ID)
    const revoked = await client?.revokeCloudConnection(
      connection.device_code,
      connection.cloud_user_id,
    ) || false
    if (revoked) {
      markCloudAppConnectionRevocationSynced(connection.device_code, connection.cloud_user_id)
    }
    notified = revoked ? 1 : 0
  }
  ctx.body = { success: true, notified }
}

export async function createCloudAppAuthorizationCodeController(ctx: Context) {
  const userId = Number(ctx.state.user?.id || 0)
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const body = ctx.request.body as Record<string, unknown> | undefined
  const requestedRoute = body?.route
  if (requestedRoute != null && !isAppRelayRoute(requestedRoute)) {
    ctx.status = 400
    ctx.body = { error: 'invalid_app_relay_route' }
    return
  }
  const route: AppRelayRoute = isAppRelayRoute(requestedRoute) ? requestedRoute : await getAppRelayRoute()
  let client = await ensureAppRelayHostClient(route)
  if (!client || !await client.waitForConnected(8000)) {
    ctx.status = 502
    ctx.body = { error: 'app_relay_unavailable' }
    return
  }
  try {
    const refresh = Boolean(body?.refresh)
    const cached = refresh ? null : client.getCachedPreconnection(userId)
    if (cached) {
      ctx.status = 200
      ctx.body = cloudAuthorizationPayload(cached, route)
      return
    }
    const { authorizationCode } = createAppAuthorizationCode(userId)
    const preconnection = await client.requestPreconnection(authorizationCode, refresh, 8000, userId)
    ctx.status = 201
    ctx.body = cloudAuthorizationPayload(preconnection, route)
  } catch (error) {
    if (client.isPreconnectionExpired()) {
      stopAppRelayHostClient()
      client = null
    }
    const code = error instanceof Error ? error.message : 'preconnection_request_failed'
    const details = error as Error & { retryAfter?: number; refreshRemaining?: number }
    ctx.status = code === 'preconnection_refresh_rate_limited' ? 429
      : code === 'preconnection_refresh_limit_reached' ? 409
        : code === 'preconnection_expired' ? 410
          : 502
    ctx.body = {
      error: code,
      ...(details.retryAfter ? { retry_after: details.retryAfter } : {}),
      ...(Number.isFinite(details.refreshRemaining) ? { refresh_remaining: details.refreshRemaining } : {}),
    }
  }
}

function cloudAuthorizationPayload(
  preconnection: import('../services/app-relay/client').CloudAppPreconnection,
  relayRoute: AppRelayRoute,
) {
  return {
    type: preconnection.type,
    version: preconnection.version,
    connection_type: preconnection.connectionType,
    machine_id: preconnection.machineId,
    preconnect_id: preconnection.preconnectId,
    matching_code: preconnection.matchingCode,
    expires_at: preconnection.expiresAt,
    hard_expires_at: preconnection.hardExpiresAt,
    refresh_remaining: preconnection.refreshRemaining,
    relay_route: relayRoute,
    qr_payload: JSON.stringify({
      t: 'hsac',
      v: 1,
      c: 'cloud',
      m: preconnection.machineId,
      p: preconnection.preconnectId,
      k: preconnection.matchingCode,
      e: preconnection.expiresAt,
      r: relayRoute,
    }),
  }
}

export async function createAppAuthorizationCodeController(ctx: Context) {
  const userId = Number(ctx.state.user?.id || 0)
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  const { authorizationCode, record } = createAppAuthorizationCode(userId)
  const remoteAddress = String(ctx.req?.socket?.remoteAddress || ctx.ip || '')
  const forwardedProto = String(typeof ctx.get === 'function' ? ctx.get('x-forwarded-proto') : '').split(',')[0]?.trim().toLowerCase()
  const protocol = forwardedProto === 'https' || ctx.protocol === 'https' ? 'https' : 'http'
  const requestHost = String(ctx.host || (typeof ctx.get === 'function' ? ctx.get('host') : '') || '').trim()
  const requestOrigin = requestHost ? `${protocol}://${requestHost}` : ''
  const connection = {
    type: APP_CONNECTION_QR_TYPE,
    version: APP_CONNECTION_QR_VERSION,
    connection_type: 'lan' as const,
    backend_url: getLanBackendUrlForRequest(remoteAddress, requestOrigin, config.port),
    machine_id: await getDeviceId(),
    authorization_code: authorizationCode,
    expires_at: record.expires_at,
  }
  ctx.status = 201
  ctx.body = {
    ...connection,
    qr_payload: JSON.stringify(connection),
  }
}
