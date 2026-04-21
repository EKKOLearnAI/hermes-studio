import { request } from '@/api/client'

export interface TunnelStatus {
  running: boolean
  url: string | null
  cloudflaredInstalled: boolean
  error?: string
}

export interface TunnelToken {
  token: string
}

export function getTunnelStatus(): Promise<TunnelStatus> {
  return request<TunnelStatus>('/api/hermes/tunnel/status')
}

export function startTunnel(): Promise<{ success: boolean; url?: string; message?: string; error?: string }> {
  return request('/api/hermes/tunnel/start', { method: 'POST' })
}

export function stopTunnel(): Promise<{ success: boolean; message?: string }> {
  return request('/api/hermes/tunnel/stop', { method: 'POST' })
}

export function getTunnelToken(): Promise<TunnelToken> {
  return request<TunnelToken>('/api/hermes/tunnel/token')
}
