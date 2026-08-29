import type { AgentMessage, ModelClient, ModelRequest, ModelUsage } from '../model/types'
import type { AgentMessageInput, AgentOutputMessage } from '../model/messages'
import type { AgentSkill } from '../skills/types'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentToolAuthorizer, AgentToolContext, AgentToolResult } from '../tools/types'
import type { AgentRuntimeEvent } from './events'
import type { MemoryContext, MemoryEvidenceMessageInput, MemoryOrigin, MemoryReviewPolicy, MemoryScope } from '../memory/types'
import type { MemoryService } from '../memory/service'
import type { SkillReviewUsageEvent } from '../skills/review'
import type { EkkoLogWriter } from '../logging/file-logger'
import type { EkkoRuntimeLogContext } from '../logging/runtime-logger'
import type { EkkoExternalSkillDirectory } from '../skills/external-directories'

export interface AgentRuntimeContextEstimate {
  contextTokens: number
  systemPromptTokens: number
  messageTokens: number
  toolTokens: number
  modelContextTokens: number
  messageCount: number
  toolCount: number
  systemPromptChars: number
}

export interface EkkoBackgroundContinuationContext {
  version: 1
  subagentId: string
  originRunId: string
  originStep: number
  messages: AgentMessage[]
  memoryPolicy: 'disabled'
}

export interface AgentRuntimeOptions {
  /** Fixed profile identity for tool and memory operations. Per-run input cannot override it. */
  profileId?: string
  modelClient?: ModelClient
  /** Disable every tool source, including built-ins, MCP, memory, and skill tools. */
  toolsEnabled?: boolean
  tools?: AgentToolRegistry
  /** Optional human authorization gate applied before every registered tool executes. */
  toolAuthorizer?: AgentToolAuthorizer
  /** Disable every skill source, including constructor and per-run skills. */
  skillsEnabled?: boolean
  skills?: AgentSkill[]
  /** Fixed directory used by this agent instance for skill discovery and management. */
  skillDirectory?: string
  /** Read-only Skill roots referenced by the current Profile. */
  externalSkillDirectories?: EkkoExternalSkillDirectory[]
  /** Skill names excluded from prompt injection and deterministic routing. */
  disabledSkillNames?: string[]
  /** Trigger a background skill review after this many tool calls in one session. Set to 0 to disable. */
  skillReviewEveryToolCalls?: number
  systemPrompt?: string
  runtimeInstructions?: string[]
  maxSteps?: number
  maxModelRetries?: number
  maxConsecutiveToolFailures?: number
  /** Default background delegation policy for runs that do not override it. */
  backgroundDelegationEnabled?: boolean
  /** Maximum step budget for each delegated subagent. */
  subtaskMaxSteps?: number
  toolContext?: AgentToolContext
  modelDefaults?: Omit<ModelRequest, 'messages' | 'tools' | 'stream'>
  contextKey?: string
  memory?: MemoryService
  /** Internal structured log sink owned by the Ekko runtime. */
  logWriter?: EkkoLogWriter
  logProfile?: string
}

export interface AgentRuntimeRunInput {
  messages: AgentMessageInput[]
  signal?: AbortSignal
  systemPrompt?: string
  skills?: AgentSkill[]
  maxSteps?: number
  maxModelRetries?: number
  maxConsecutiveToolFailures?: number
  toolContext?: AgentToolContext
  model?: string
  temperature?: number
  maxTokens?: number
  reasoningEffort?: ModelRequest['reasoningEffort']
  reasoningSummary?: ModelRequest['reasoningSummary']
  metadata?: Record<string, unknown>
  modelClient?: ModelClient
  modelDefaults?: Omit<ModelRequest, 'messages' | 'tools' | 'stream'>
  contextKey?: string
  context?: unknown
  memoryEnabled?: boolean
  /**
   * Trusted conversation input used for memory retrieval and review. Hosts that
   * augment a user turn with routing instructions, derived summaries, or quoted
   * history should pass only the underlying conversation evidence here.
   */
  memoryInput?: {
    messages: Array<AgentMessageInput | MemoryEvidenceMessageInput>
    reviewPolicy?: MemoryReviewPolicy
    /** Opaque provenance stamped by the host; never chosen by the model. */
    origin?: MemoryOrigin
    /** Long-term node scopes visible during this run. Defaults to profile scope. */
    recallScopes?: MemoryScope[]
    /** Scopes the memory curator may select for new or corrected nodes. */
    writeScopes?: MemoryScope[]
    /** Suggested scope when a caller or safe fallback does not choose one. */
    defaultWriteScope?: MemoryScope
  }
  /** Delete provider-native continuation state when this run exits. */
  ephemeralContext?: boolean
  /** Disable session-global skill review side effects for an isolated callback run. */
  skillReviewEnabled?: boolean
  /** When false, delegate_task only accepts foreground mode for this run. */
  backgroundDelegationEnabled?: boolean
  /** Correlation fields only; log events and payloads remain runtime-owned. */
  logContext?: EkkoRuntimeLogContext
  onMemoryUsage?: (input: {
    purpose: 'ekko-memory-review' | 'ekko-memory-summary'
    usage: ModelUsage
    model?: string
    callIndex: number
  }) => void
  onSkillReviewUsage?: (input: SkillReviewUsageEvent) => void
  onEvent?: (event: AgentRuntimeEvent) => void
}

/**
 * Requests that the matching foreground run stop without cancelling an
 * in-flight tool batch. The session identifier is the runtime context key used
 * by the run; callers should include expectedRunId once they have observed the
 * run.started event so a stale request cannot affect a newer run.
 */
export interface AgentRuntimeBoundaryInterruptRequest {
  sessionId: string
  expectedRunId?: string
}

export type AgentRuntimeBoundaryPhase = 'model' | 'tool_batch'

export type AgentRuntimeBoundaryInterruptResult =
  | {
      status: 'accepted' | 'already_pending'
      runId: string
      phase: AgentRuntimeBoundaryPhase
    }
  | { status: 'not_running' | 'run_mismatch' | 'ambiguous' }

export type AgentRuntimeStep =
  | { type: 'model'; step: number; message: AgentOutputMessage }
  | { type: 'tool'; step: number; toolCallId: string; toolName: string; result: AgentToolResult }

export interface AgentRuntimeRunResult {
  runId: string
  messages: AgentMessage[]
  output: AgentOutputMessage
  steps: AgentRuntimeStep[]
  events: AgentRuntimeEvent[]
  context?: unknown
  contextEstimate?: AgentRuntimeContextEstimate
  memoryContext?: MemoryContext
}
