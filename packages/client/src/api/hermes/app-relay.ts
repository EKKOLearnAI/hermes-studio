import { request } from '../client'

export interface AppRelayStatus {
  connected: boolean
  machineId: string
  pairingCode: string
  pairingExpiresAt: number
  expiresAt?: number
}

interface AppRelayResponse {
  relay: AppRelayStatus
  appAuth?: {
    baseUrl?: string
  }
}

export interface AppRelayBootstrap {
  relay: AppRelayStatus
  appAuthBaseUrl: string
}

export async function fetchAppRelayBootstrap(): Promise<AppRelayBootstrap> {
  const response = await request<AppRelayResponse>('/api/app-relay/status')
  return {
    relay: response.relay,
    appAuthBaseUrl: String(response.appAuth?.baseUrl || ''),
  }
}

export async function fetchAppRelayStatus(): Promise<AppRelayStatus> {
  return (await fetchAppRelayBootstrap()).relay
}

export async function connectAppRelay(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/connect', { method: 'POST' })).relay
}

export async function refreshAppRelayPairingCode(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/pairing-code', { method: 'POST' })).relay
}

export async function disconnectAppRelay(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/disconnect', { method: 'POST' })).relay
}
