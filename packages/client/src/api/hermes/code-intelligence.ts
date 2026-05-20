import { request } from '../client'

export type CodeLanguageStatus = 'detected' | 'not_detected' | 'partial'

export interface CodeLanguageSummary {
  files: number
  lines: number
  status: CodeLanguageStatus
}

export interface CodeManifestSummary {
  name: string
  path: string
}

export interface CodeCapabilitySummary {
  status: CodeLanguageStatus
  reason: string
}

export interface CodeIntelligenceSummary {
  root: string
  languages: Record<string, CodeLanguageSummary>
  manifests: CodeManifestSummary[]
  capabilities: Record<string, CodeCapabilitySummary>
  recommendedSkills: string[]
  generatedAt: string
}

export async function fetchCodeIntelligenceSummary(): Promise<CodeIntelligenceSummary> {
  return request<CodeIntelligenceSummary>('/api/hermes/code-intelligence/summary')
}
