import { request } from './client'

export type CodingAgentId = 'claude-code' | 'codex'

export interface CodingAgentToolStatus {
  id: CodingAgentId
  name: string
  provider: string
  command: string
  packageName: string
  installed: boolean
  version: string
  rawVersion: string
  error?: string
}

export interface CodingAgentsStatus {
  tools: CodingAgentToolStatus[]
}

export interface CodingAgentInstallResult extends CodingAgentsStatus {
  success: boolean
  tool: CodingAgentToolStatus
  message?: string
}

export async function fetchCodingAgentsStatus(): Promise<CodingAgentsStatus> {
  return request<CodingAgentsStatus>('/api/coding-agents')
}

export async function installCodingAgent(id: CodingAgentId): Promise<CodingAgentInstallResult> {
  return request<CodingAgentInstallResult>(`/api/coding-agents/${id}/install`, { method: 'POST' })
}
