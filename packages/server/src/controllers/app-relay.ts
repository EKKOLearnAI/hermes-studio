import type { Context } from 'koa'
import { config } from '../config'
import { getLanEndpointKind } from '../services/lan-discovery'
import {
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
} from '../services/app-relay/client'
import { getDeviceIdentity, getPublicSystemInfo } from '../services/system-info'

const APP_RELAY_CONNECTION_ID = 'app-relay'

function appRelayResponse(relay: Record<string, unknown>) {
  return {
    relay,
    appAuth: {
      baseUrl: config.appRelay.url,
    },
  }
}

export async function getAppRelayStatusController(ctx: Context) {
  const client = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  ctx.body = appRelayResponse(
    client?.status() || {
      connected: false,
      machineId: (await getDeviceIdentity()).device_id,
      pairingCode: '',
      pairingExpiresAt: 0,
    },
  )
}

export async function connectAppRelayController(ctx: Context) {
  let client = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  if (!client) {
    const [identity, info] = await Promise.all([getDeviceIdentity(), getPublicSystemInfo()])
    client = startAppRelayClient({
      connectionId: APP_RELAY_CONNECTION_ID,
      relayUrl: config.appRelay.url,
      machineId: identity.device_id,
      publicKey: identity.device_public_key,
      machineInfo: {
        ...info,
        http_port: config.port,
        endpoint_kind: getLanEndpointKind(config.port),
      },
      localBaseUrl: `http://127.0.0.1:${config.port}`,
    })
  }
  if (!client || !await client.waitForConnected(8000)) {
    stopAppRelayClient(APP_RELAY_CONNECTION_ID)
    ctx.status = 502
    ctx.body = { error: 'Failed to connect App relay' }
    return
  }

  const pairing = await client.requestPairingCode(8000)
  ctx.body = appRelayResponse({ ...client.status(), ...pairing })
}

export async function refreshAppRelayPairingController(ctx: Context) {
  const client = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  if (!client?.isConnected()) {
    ctx.status = 409
    ctx.body = { error: 'App relay is not connected' }
    return
  }
  const pairing = await client.requestPairingCode(8000)
  ctx.body = appRelayResponse({ ...client.status(), ...pairing })
}

export async function disconnectAppRelayController(ctx: Context) {
  stopAppRelayClient(APP_RELAY_CONNECTION_ID)
  ctx.body = appRelayResponse({
      connected: false,
      machineId: (await getDeviceIdentity()).device_id,
      pairingCode: '',
      pairingExpiresAt: 0,
  })
}
