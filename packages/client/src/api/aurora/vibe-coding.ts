import { request } from '@/api/client'

export interface VibeSecurityReportItem {
  id: string
  pattern: string
  message: string
  severity: 'warning' | 'danger'
}

export interface VibeBuildResponse {
  buildId: string
  widgetName: string
  componentPath: string
  spec: string
  uiMock: string
  code: string
  patchDiff: string
  securityReport: VibeSecurityReportItem[]
  blocked: boolean
  runtime?: {
    mode: string
    provider: string
    model: string
  }
}

export interface VibeApplyResponse {
  ok: boolean
  path: string
  manifestPath?: string
  manifest?: {
    schemaVersion: 1
    widgetName: string
    componentPath: string
    permissions: {
      network: boolean
      localStorage: boolean
      workingMemory: boolean
      cookies: boolean
      filesystem: boolean
    }
    security: {
      status: 'passed' | 'blocked'
      scannedAt: string
      blockedPatterns: VibeSecurityReportItem[]
    }
  }
  audit: {
    buildId?: string
    widgetName: string
    path: string
    manifestPath?: string
    appliedAt: string
    securityReport: VibeSecurityReportItem[]
  }
}

export function buildVibeWidget(intent: string, signal?: AbortSignal): Promise<VibeBuildResponse> {
  return request<VibeBuildResponse>('/api/aurora/vibe-build', {
    method: 'POST',
    signal,
    body: JSON.stringify({ intent }),
  })
}

export function applyVibeWidget(payload: {
  buildId: string
  widgetName: string
  code: string
  spec: string
}, signal?: AbortSignal): Promise<VibeApplyResponse> {
  return request<VibeApplyResponse>('/api/aurora/vibe-apply', {
    method: 'POST',
    signal,
    body: JSON.stringify(payload),
  })
}
