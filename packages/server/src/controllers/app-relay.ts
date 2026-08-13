import type { Context } from 'koa'
import { getAppRelayClient } from '../services/app-relay/client'
import {
  APP_RELAY_CONNECTION_ID,
  ensureAppRelayHostClient,
  stopAppRelayHostClient,
} from '../services/app-relay/connection'
import { getDeviceIdentity } from '../services/system-info'

function appRelayResponse(relay: Record<string, unknown>) {
  return { relay }
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
  const client = await ensureAppRelayHostClient()
  if (!client || !await client.waitForConnected(8000)) {
    stopAppRelayHostClient()
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
  stopAppRelayHostClient()
  ctx.body = appRelayResponse({
      connected: false,
      machineId: (await getDeviceIdentity()).device_id,
      pairingCode: '',
      pairingExpiresAt: 0,
  })
}
