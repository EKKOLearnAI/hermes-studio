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
}

export async function fetchAppRelayStatus(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/status')).relay
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
