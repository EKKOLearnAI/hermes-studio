import type { SelectOption } from 'naive-ui'

export interface WorkflowSelectOption extends SelectOption {
  label: string
  value: string
}

export type WorkflowNodeStatus = 'idle' | 'ready' | 'running'

export interface WorkflowAgentNodeData {
  title: string
  agent: string
  model: string
  prompt: string
  status: WorkflowNodeStatus
  agentOptions: WorkflowSelectOption[]
  modelOptions: WorkflowSelectOption[]
  onUpdate: (id: string, patch: Partial<WorkflowAgentNodeEditableData>) => void
}

export type WorkflowAgentNodeEditableData = Pick<WorkflowAgentNodeData, 'agent' | 'model' | 'prompt'>
