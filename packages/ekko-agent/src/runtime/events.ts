import type { AgentOutputMessage } from '../model/messages'
import type { AgentToolCall, ModelUsage } from '../model/types'
import type { AgentToolResult } from '../tools/types'

export type AgentRuntimeEvent =
  | { type: 'run.started'; runId: string; maxSteps: number }
  | { type: 'model.started'; runId: string; step: number }
  | { type: 'model.message'; runId: string; step: number; message: AgentOutputMessage }
  | { type: 'model.delta'; runId: string; step: number; text: string }
  | { type: 'model.tool_call'; runId: string; step: number; toolCall: AgentToolCall }
  | { type: 'model.usage'; runId: string; step: number; usage: ModelUsage }
  | { type: 'tool.started'; runId: string; step: number; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool.completed'; runId: string; step: number; toolCallId: string; toolName: string; result: AgentToolResult }
  | { type: 'tool.failed'; runId: string; step: number; toolCallId: string; toolName: string; result: AgentToolResult }
  | { type: 'run.completed'; runId: string; output: AgentOutputMessage; steps: number }
  | { type: 'run.failed'; runId: string; error: string; steps: number }
  | { type: 'run.max_steps'; runId: string; maxSteps: number }
