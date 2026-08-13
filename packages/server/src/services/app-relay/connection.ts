import { config } from '../../config'
import { getLanEndpointKind } from '../lan-discovery'
import { getDeviceIdentity, getPublicSystemInfo } from '../system-info'
import {
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
  type AppRelayClient,
} from './client'

export const APP_RELAY_CONNECTION_ID = 'app-relay'

export async function ensureAppRelayHostClient(): Promise<AppRelayClient | null> {
  const existing = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  if (existing && !existing.isPreconnectionExpired()) return existing
  if (existing) stopAppRelayHostClient()
  const [identity, info] = await Promise.all([getDeviceIdentity(), getPublicSystemInfo()])
  return startAppRelayClient({
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

export function stopAppRelayHostClient(): void {
  stopAppRelayClient(APP_RELAY_CONNECTION_ID)
}
