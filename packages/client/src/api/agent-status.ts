import { request } from './client'

export type AgentStatusId = 'hermes' | 'ekko-agent' | 'claude-code' | 'codex' | 'pi'
export type AgentStatusSource = 'managed-runtime' | 'user-cli' | 'built-in' | 'not-installed'

export interface AgentStatusRecord {
  id: AgentStatusId
  installed: boolean
  source: AgentStatusSource
  path: string
  version: string
}

export interface AgentStatusSnapshot {
  revision: number
  updatedAt: string
  agents: AgentStatusRecord[]
}

export async function fetchAgentStatusSnapshot(): Promise<AgentStatusSnapshot> {
  return request<AgentStatusSnapshot>('/api/agents/status')
}
