import { request } from '../client'

export type LanEndpointKind = 'web' | 'desktop' | 'custom'

export interface LanDeviceInfo {
  id: string
  ip: string
  http_port: number
  endpoint_kind: LanEndpointKind
  url: string
  computer_name: string
  os: {
    type: string
    platform: string
    release: string
    arch: string
  }
  hermes_agent_version: string
  hermes_web_ui_version: string
  response_ms: number
  last_seen_at: string
}

export interface LanDiscoveryState {
  scanning: boolean
  last_scanned_at: string | null
  devices: LanDeviceInfo[]
}

export async function fetchLanDevices(): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>('/api/devices')
}

export async function scanLanDevices(): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>('/api/devices/scan', { method: 'POST' })
}
