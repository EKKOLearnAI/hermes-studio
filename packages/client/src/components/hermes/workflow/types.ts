import type { SelectOption } from 'naive-ui'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { CodingAgentApiMode } from '@/api/coding-agents'

export interface WorkflowSelectOption extends SelectOption {
  label: string
  value: string
}

export type WorkflowNodeStatus = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'failed' | 'approval_rejected' | 'canceled'

export interface WorkflowAgentNodeData {
  title: string
  agent: string
  provider: string
  model: string
  apiMode: CodingAgentApiMode
  input: string
  skills: string[]
  images: string[]
  approvalRequired: boolean
  status: WorkflowNodeStatus
  statusError?: string | null
  readonly?: boolean
  agentOptions: WorkflowSelectOption[]
  skillOptions: WorkflowSelectOption[]
  skillsLoading: boolean
  modelGroups: AvailableModelGroup[]
  onUpdate: (id: string, patch: Partial<WorkflowAgentNodeEditableData>) => void
  onUploadImages: (id: string, files: File[]) => Promise<string[]>
}

export type WorkflowAgentNodeEditableData = Pick<WorkflowAgentNodeData, 'title' | 'agent' | 'provider' | 'model' | 'apiMode' | 'input' | 'skills' | 'images' | 'approvalRequired'>
