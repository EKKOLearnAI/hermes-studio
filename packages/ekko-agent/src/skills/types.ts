import type { AgentTool } from '../tools/types'

export interface AgentSkill {
  id: string
  name: string
  description?: string
  instructions: string
  tools?: AgentTool[]
}
