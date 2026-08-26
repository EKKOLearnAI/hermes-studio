export type PublicSystemInfo = {
  device_id: string
  device_public_key: string
  computer_name: string
  os: {
    type: string
    platform: NodeJS.Platform
    release: string
    arch: string
  }
  hermes_agent_version: string
  hermes_web_ui_version: string
}

export type LanEndpointKind = 'web' | 'desktop' | 'custom'

export type LanDeviceInfo = PublicSystemInfo & {
  id: string
  ip: string
  http_port: number
  endpoint_kind: LanEndpointKind
  url: string
  response_ms: number
  last_seen_at: string
}
