import { request } from '../client'

export interface TunnelStatus {
  running: boolean
  url: string | null
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  return request<TunnelStatus>('/api/tunnel/status')
}

export async function startTunnel(): Promise<{ success: boolean; url: string | null; message?: string }> {
  return request('/api/tunnel/start', { method: 'POST' })
}

export async function stopTunnel(): Promise<{ success: boolean; message?: string }> {
  return request('/api/tunnel/stop', { method: 'POST' })
}