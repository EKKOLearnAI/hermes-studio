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

export interface CodingAgentMutationResult extends CodingAgentsStatus {
  success: boolean
  tool: CodingAgentToolStatus
  message?: string
}

export interface CodingAgentConfigFileContent {
  key: string
  path: string
  absolutePath: string
  language: string
  content: string
  exists: boolean
  size: number
}

export async function fetchCodingAgentsStatus(): Promise<CodingAgentsStatus> {
  return request<CodingAgentsStatus>('/api/coding-agents')
}

export async function installCodingAgent(id: CodingAgentId): Promise<CodingAgentMutationResult> {
  return request<CodingAgentMutationResult>(`/api/coding-agents/${id}/install`, { method: 'POST' })
}

export async function deleteCodingAgent(id: CodingAgentId): Promise<CodingAgentMutationResult> {
  return request<CodingAgentMutationResult>(`/api/coding-agents/${id}`, { method: 'DELETE' })
}

export async function readCodingAgentConfigFile(
  id: CodingAgentId,
  key: string,
): Promise<CodingAgentConfigFileContent> {
  return request<CodingAgentConfigFileContent>(`/api/coding-agents/${id}/config-files/${encodeURIComponent(key)}`)
}

export async function writeCodingAgentConfigFile(
  id: CodingAgentId,
  key: string,
  content: string,
): Promise<CodingAgentConfigFileContent> {
  return request<CodingAgentConfigFileContent>(`/api/coding-agents/${id}/config-files/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}
