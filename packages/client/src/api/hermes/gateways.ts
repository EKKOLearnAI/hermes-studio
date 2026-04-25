import { request } from '../client'

export interface GatewayStatus {
  profile: string
  port: number
  host: string
  url: string
  running: boolean
  pid?: number
}

export async function fetchGateways(): Promise<GatewayStatus[]> {
  const res = await request<{ gateways: GatewayStatus[] }>('/api/hermes/gateways', { forceLocal: true })
  return res.gateways
}

export async function startGateway(name: string): Promise<GatewayStatus> {
  const res = await request<{ success: boolean; gateway: GatewayStatus }>(`/api/hermes/gateways/${name}/start`, { method: 'POST', forceLocal: true })
  return res.gateway
}

export async function stopGateway(name: string): Promise<void> {
  await request(`/api/hermes/gateways/${name}/stop`, { method: 'POST', forceLocal: true })
}

export async function checkGatewayHealth(name: string): Promise<GatewayStatus> {
  const res = await request<{ gateway: GatewayStatus }>(`/api/hermes/gateways/${name}/health`, { forceLocal: true })
  return res.gateway
}
