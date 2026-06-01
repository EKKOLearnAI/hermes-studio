import { request } from './client'

export type CodingAgentId = 'claude-code' | 'codex'
export type CodingAgentApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages'
export type CodingAgentLaunchMode = 'scoped' | 'global'

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
  code?: string
}

export interface CodingAgentConfigFileContent {
  key: string
  path: string
  absolutePath: string
  language: string
  content: string
  exists: boolean
  size: number
  profile: string
  provider: string
  rootDir: string
}

export interface CodingAgentConfigScope {
  profile?: string | null
  provider?: string | null
}

export interface CodingAgentLaunchRequest {
  mode?: CodingAgentLaunchMode
  profile?: string | null
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: CodingAgentApiMode
}

export interface CodingAgentLaunchResult {
  agentId: CodingAgentId
  mode: CodingAgentLaunchMode
  profile: string
  provider: string
  model: string
  rootDir: string
  workspaceDir: string
  command: string
  args: string[]
  env: Record<string, string>
  shellCommand: string
  files: Array<{ key: string; path: string; absolutePath: string }>
}

export interface CodingAgentNativeLaunchResult extends CodingAgentLaunchResult {
  nativeTerminal: true
  terminal: string
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
  scope: CodingAgentConfigScope = {},
): Promise<CodingAgentConfigFileContent> {
  const params = new URLSearchParams()
  if (scope.profile) params.set('profile', scope.profile)
  if (scope.provider) params.set('provider', scope.provider)
  const query = params.toString()
  return request<CodingAgentConfigFileContent>(
    `/api/coding-agents/${id}/config-files/${encodeURIComponent(key)}${query ? `?${query}` : ''}`,
  )
}

export async function writeCodingAgentConfigFile(
  id: CodingAgentId,
  key: string,
  content: string,
  scope: CodingAgentConfigScope = {},
): Promise<CodingAgentConfigFileContent> {
  return request<CodingAgentConfigFileContent>(`/api/coding-agents/${id}/config-files/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ content, profile: scope.profile, provider: scope.provider }),
  })
}

export async function prepareCodingAgentLaunch(
  id: CodingAgentId,
  data: CodingAgentLaunchRequest,
): Promise<CodingAgentLaunchResult> {
  return request<CodingAgentLaunchResult>(`/api/coding-agents/${id}/launch/prepare`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function launchCodingAgentNativeTerminal(
  id: CodingAgentId,
  data: CodingAgentLaunchRequest,
): Promise<CodingAgentNativeLaunchResult> {
  return request<CodingAgentNativeLaunchResult>(`/api/coding-agents/${id}/launch/native`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
