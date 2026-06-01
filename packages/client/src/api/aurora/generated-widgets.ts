import { request } from '@/api/client'

export interface GeneratedWidgetSecurityReportItem {
  id: string
  pattern: string
  message: string
  severity: 'warning' | 'danger'
}

export interface GeneratedWidgetManifestItem {
  widgetName: string
  fileName: string
  componentPath: string
  manifestPath?: string
  permissions?: {
    network: boolean
    localStorage: boolean
    workingMemory: boolean
    cookies: boolean
    filesystem: boolean
  }
  deployedAt: string | null
  buildId: string | null
  spec: string | null
  source: 'vibe-build' | 'filesystem'
  securityStatus: 'passed' | 'blocked'
  securityReport: GeneratedWidgetSecurityReportItem[]
}

export interface GeneratedWidgetManifestResponse {
  generatedAt: string
  root: string
  widgets: GeneratedWidgetManifestItem[]
}

export function fetchGeneratedWidgetManifest(): Promise<GeneratedWidgetManifestResponse> {
  return request<GeneratedWidgetManifestResponse>('/api/aurora/generated-widgets')
}
