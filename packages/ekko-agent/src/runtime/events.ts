import type { AgentOutputMessage } from '../model/messages'
import type { AgentToolCall, ModelUsage } from '../model/types'
import type { AgentToolResult } from '../tools/types'
import type { AgentRuntimeContextEstimate } from './types'
import type { MemoryContextDiagnostics } from '../memory/types'

export type AgentRuntimeEvent =
  | { type: 'run.started'; runId: string; maxSteps: number }
  | { type: 'memory.retrieved'; runId: string; diagnostics: MemoryContextDiagnostics; memoryIds: string[] }
  | { type: 'model.started'; runId: string; step: number }
  | { type: 'context.estimated'; runId: string; step: number; estimate: AgentRuntimeContextEstimate }
  | { type: 'model.retry'; runId: string; step: number; retry: number; maxRetries: number; error: string }
  | { type: 'model.message'; runId: string; step: number; message: AgentOutputMessage }
  | { type: 'model.delta'; runId: string; step: number; text: string }
  | { type: 'model.reasoning'; runId: string; step: number; text: string }
  | { type: 'model.tool_call'; runId: string; step: number; toolCall: AgentToolCall }
  | { type: 'model.usage'; runId: string; step: number; usage: ModelUsage }
  | { type: 'model.context'; runId: string; step: number; context: unknown }
  | { type: 'tool.started'; runId: string; step: number; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool.completed'; runId: string; step: number; toolCallId: string; toolName: string; result: AgentToolResult; durationMs: number }
  | { type: 'tool.failed'; runId: string; step: number; toolCallId: string; toolName: string; result: AgentToolResult; durationMs: number }
  | { type: 'run.tool_failure_limit'; runId: string; failures: number }
  | { type: 'run.completed'; runId: string; output: AgentOutputMessage; steps: number; context?: unknown; contextEstimate?: AgentRuntimeContextEstimate }
  | { type: 'run.failed'; runId: string; error: string; steps: number }
  | { type: 'run.max_steps'; runId: string; maxSteps: number }
