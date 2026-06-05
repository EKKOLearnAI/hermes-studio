import { request } from '../client'

export type LanEndpointKind = 'web' | 'desktop' | 'custom'
export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'blocked'

export interface LanDeviceInfo {
  id: string
  status: DeviceStatus
  device_public_key: string
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
  requested_at: number
  decided_at: number | null
  last_seen_at: number
  updated_at: number
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

export async function approveDevice(id: string): Promise<LanDeviceInfo> {
  return request<LanDeviceInfo>(`/api/devices/${encodeURIComponent(id)}/approve`, { method: 'POST' })
}

export async function rejectDevice(id: string): Promise<LanDeviceInfo> {
  return request<LanDeviceInfo>(`/api/devices/${encodeURIComponent(id)}/reject`, { method: 'POST' })
}

export async function blockDevice(id: string): Promise<LanDeviceInfo> {
  return request<LanDeviceInfo>(`/api/devices/${encodeURIComponent(id)}/block`, { method: 'POST' })
}

export async function unblockDevice(id: string): Promise<LanDeviceInfo> {
  return request<LanDeviceInfo>(`/api/devices/${encodeURIComponent(id)}/unblock`, { method: 'POST' })
}
