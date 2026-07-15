import { randomUUID } from 'node:crypto'
import { getEncoding } from 'js-tiktoken'
import {
  createSystemMessage,
  createToolResultMessage,
  collectModelEvents,
  modelResponseToAgentMessage,
  normalizeAgentMessages,
} from '../model/messages'
import type { AgentOutputMessage } from '../model/messages'
import type { AgentMessage, AgentToolCall, ModelRequest, ModelResponse } from '../model/types'
import type { AgentSkill } from '../skills/types'
import { AgentToolRegistry, createDefaultToolRegistry } from '../tools/registry'
import { sanitizeAgentToolResult } from '../tools/tool-result-sanitizer'
import type { AgentToolContext, AgentToolResult } from '../tools/types'
import type { AgentRuntimeEvent } from './events'
import { buildSystemPrompt } from './system-prompt'
import type { AgentRuntimeContextEstimate, AgentRuntimeOptions, AgentRuntimeRunInput, AgentRuntimeRunResult, AgentRuntimeStep } from './types'
import type { MemoryContext, MemoryRuntimeIdentity } from '../memory/types'
import type { MemoryCaptureMessage } from '../memory/service'
import { ModelMemoryExtractor } from '../memory/extraction'
import { createMemoryTools } from '../memory/tools'

export const DEFAULT_AGENT_MAX_STEPS = 90
export const DEFAULT_AGENT_MODEL_MAX_RETRIES = 3
export const DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES = 6
export const DEFAULT_AGENT_TOOL_DELAY_MS = 1000

interface ModelResponseResult {
  response: ModelResponse
  emittedReasoning: boolean
}

export class AgentRuntime {
  private readonly modelClient?: AgentRuntimeOptions['modelClient']
  private readonly tools: AgentToolRegistry
  private readonly skills: AgentSkill[]
  private readonly systemPrompt?: string
  private readonly runtimeInstructions: string[]
  private readonly maxSteps: number
  private readonly toolContext?: AgentToolContext
  private readonly modelDefaults?: AgentRuntimeOptions['modelDefaults']
  private readonly maxModelRetries: number
  private readonly maxConsecutiveToolFailures: number
  private readonly toolDelayMs: number
  private readonly defaultContextKey?: string
  private readonly memory?: AgentRuntimeOptions['memory']
  private readonly modelContexts = new Map<string, unknown>()

  constructor(options: AgentRuntimeOptions) {
    this.modelClient = options.modelClient
    this.tools = options.tools ?? createDefaultToolRegistry()
    this.skills = options.skills ?? []
    this.systemPrompt = options.systemPrompt
    this.runtimeInstructions = options.runtimeInstructions ?? []
    this.maxSteps = options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
    this.toolContext = options.toolContext
    this.modelDefaults = options.modelDefaults
    this.maxModelRetries = options.maxModelRetries ?? DEFAULT_AGENT_MODEL_MAX_RETRIES
    this.maxConsecutiveToolFailures = options.maxConsecutiveToolFailures ?? DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES
    this.toolDelayMs = options.toolDelayMs ?? DEFAULT_AGENT_TOOL_DELAY_MS
    this.defaultContextKey = options.contextKey
    this.memory = options.memory
    this.registerSkillTools(this.skills)
    if (this.memory) this.tools.registerMany(createMemoryTools(this.memory))
  }

  registerSkill(skill: AgentSkill): void {
    this.skills.push(skill)
    this.registerSkillTools([skill])
  }

  registerSkills(skills: AgentSkill[]): void {
    for (const skill of skills) {
      this.registerSkill(skill)
    }
  }

  async refreshTools(context?: AgentToolContext): Promise<void> {
    await this.tools.refreshTools(context)
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    await this.refreshTools(this.runToolContext(input))

    const runId = randomUUID()
    const events: AgentRuntimeEvent[] = []
    const steps: AgentRuntimeStep[] = []
    const maxSteps = input.maxSteps ?? this.maxSteps
    const maxModelRetries = input.maxModelRetries ?? this.maxModelRetries
    const maxConsecutiveToolFailures = input.maxConsecutiveToolFailures ?? this.maxConsecutiveToolFailures
    const toolDelayMs = input.toolDelayMs ?? this.toolDelayMs
    const emit = (event: AgentRuntimeEvent) => {
      events.push(event)
      input.onEvent?.(event)
    }

    emit({ type: 'run.started', runId, maxSteps })

    const runSkills = [...this.skills, ...(input.skills ?? [])]
    this.registerSkillTools(input.skills ?? [])
    const memoryIdentity = this.memoryIdentityFor(input)
    const memoryContext = await this.prepareMemory(input, memoryIdentity)
    if (memoryContext) {
      emit({
        type: 'memory.retrieved',
        runId,
        diagnostics: memoryContext.diagnostics,
        memoryIds: memoryContext.usedMemoryIds,
      })
    }
    const messages = this.prepareMessages(input, runSkills, memoryContext ? this.memory?.contextPrompt(memoryContext) : undefined)
    let output: AgentOutputMessage = {
      role: 'assistant',
      content: '',
    }
    const contextKey = this.contextKeyFor(input)
    let contextEstimate: AgentRuntimeContextEstimate | undefined
    let consecutiveToolFailures = 0

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        throwIfAborted(input.signal)
        const modelClient = this.modelClientFor(input)
        emit({ type: 'model.started', runId, step })
        const request = this.modelRequest(input, messages, modelClient, contextKey)
        contextEstimate = estimateModelRequestContext(request)
        emit({ type: 'context.estimated', runId, step, estimate: contextEstimate })
        const modelResult = await this.createModelResponseWithRetries(
          request,
          modelClient,
          runId,
          step,
          maxModelRetries,
          emit,
        )
        const response = modelResult.response
        const assistantMessage = modelResponseToAgentMessage(response)
        output = assistantMessage
        messages.push(assistantMessage)
        steps.push({ type: 'model', step, message: assistantMessage })
        if (assistantMessage.reasoning && !modelResult.emittedReasoning) {
          emit({ type: 'model.reasoning', runId, step, text: assistantMessage.reasoning })
        }
        if (assistantMessage.context !== undefined) {
          if (contextKey) this.modelContexts.set(contextKey, assistantMessage.context)
          emit({ type: 'model.context', runId, step, context: assistantMessage.context })
        }
        emit({ type: 'model.message', runId, step, message: assistantMessage })

        const toolCalls = assistantMessage.toolCalls ?? []
        if (toolCalls.length === 0) {
          const context = contextKey ? this.modelContexts.get(contextKey) : assistantMessage.context
          emit({ type: 'run.completed', runId, output, steps: step, context, contextEstimate })
          this.completeMemory(memoryIdentity, messages, input)
          return { runId, messages, output, steps, events, context, contextEstimate, memoryContext }
        }

        for (const toolCall of toolCalls) {
          throwIfAborted(input.signal)
          const result = await this.executeTool(
            runId,
            step,
            toolCall,
            this.runToolContext(input),
            emit,
            input.signal,
          )
          throwIfAborted(input.signal)
          messages.push(createToolResultMessage(toolCall.id, result.content, toolCall.name))
          steps.push({ type: 'tool', step, toolCallId: toolCall.id, toolName: toolCall.name, result })
          consecutiveToolFailures = result.ok ? 0 : consecutiveToolFailures + 1
          if (maxConsecutiveToolFailures > 0 && consecutiveToolFailures >= maxConsecutiveToolFailures) {
            emit({ type: 'run.tool_failure_limit', runId, failures: consecutiveToolFailures })
            output = {
              role: 'assistant',
              content: `Stopped after ${consecutiveToolFailures} consecutive tool failures.`,
              finishReason: 'tool_failure_limit',
            }
            const context = contextKey ? this.modelContexts.get(contextKey) : undefined
            emit({ type: 'run.completed', runId, output, steps: step, context, contextEstimate })
            this.completeMemory(memoryIdentity, messages, input)
            return { runId, messages, output, steps, events, context, contextEstimate, memoryContext }
          }
          await delay(toolDelayMs, input.signal)
        }
      }

      emit({ type: 'run.max_steps', runId, maxSteps })
      output = {
        role: 'assistant',
        content: `Stopped after reaching maxSteps (${maxSteps}).`,
        finishReason: 'max_steps',
      }
      const context = contextKey ? this.modelContexts.get(contextKey) : undefined
      emit({ type: 'run.completed', runId, output, steps: maxSteps, context, contextEstimate })
      this.completeMemory(memoryIdentity, messages, input)
      return { runId, messages, output, steps, events, context, contextEstimate, memoryContext }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'run.failed', runId, error: message, steps: steps.length })
      throw error
    }
  }

  private async createModelResponseWithRetries(
    request: ModelRequest,
    modelClient: NonNullable<AgentRuntimeOptions['modelClient']>,
    runId: string,
    step: number,
    maxRetries: number,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<ModelResponseResult> {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        throwIfAborted(request.signal)
        if (request.stream && modelClient.capabilities.streaming) {
          return await this.streamModelResponse(request, modelClient, runId, step, emit)
        }
        const response = await modelClient.create(request)
        if (response.usage) emit({ type: 'model.usage', runId, step, usage: response.usage })
        return {
          response,
          emittedReasoning: false,
        }
      } catch (error) {
        throwIfAborted(request.signal)
        if (attempt > maxRetries) throw error
        emit({
          type: 'model.retry',
          runId,
          step,
          retry: attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    throw new Error('Model request retry loop exited unexpectedly.')
  }

  private async streamModelResponse(
    request: ModelRequest,
    modelClient: NonNullable<AgentRuntimeOptions['modelClient']>,
    runId: string,
    step: number,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<ModelResponseResult> {
    let emittedReasoning = false
    const events = modelClient.stream({ ...request, stream: true })
    const output = await collectModelEvents((async function *streamAndEmit() {
      for await (const event of events) {
        if (event.type === 'text-delta') {
          emit({ type: 'model.delta', runId, step, text: event.text })
        } else if (event.type === 'reasoning-delta') {
          emittedReasoning = true
          emit({ type: 'model.reasoning', runId, step, text: event.text })
        } else if (event.type === 'tool-call') {
          emit({ type: 'model.tool_call', runId, step, toolCall: event.toolCall })
        } else if (event.type === 'error') {
          throw new Error(event.error)
        }
        yield event
      }
    })())
    if (output.message.usage) {
      emit({ type: 'model.usage', runId, step, usage: output.message.usage })
    }
    if (isEmptyModelResponse(output.message)) {
      const response = await modelClient.create({ ...request, stream: false })
      if (response.usage) emit({ type: 'model.usage', runId, step, usage: response.usage })
      return {
        response,
        emittedReasoning: false,
      }
    }
    return {
      response: output.message,
      emittedReasoning,
    }
  }

  private prepareMessages(input: AgentRuntimeRunInput, skills: AgentSkill[], memoryContext?: string): AgentMessage[] {
    const normalized = normalizeAgentMessages(input.messages)
    const userSystemMessages = normalized.filter(message => message.role === 'system').map(message => message.content)
    const nonSystemMessages = normalized.filter(message => message.role !== 'system')
    const modelClient = this.modelClientFor(input)
    const toolContext = input.toolContext ?? this.toolContext
    const systemPrompt = buildSystemPrompt({
      basePrompt: input.systemPrompt ?? this.systemPrompt,
      runtimeInstructions: this.runtimeInstructions,
      userSystemMessages,
      skills,
      memoryContext,
      context: {
        provider: modelClient.provider,
        model: input.model ?? input.modelDefaults?.model ?? this.modelDefaults?.model,
        cwd: toolContext?.cwd,
        workspaceRoot: toolContext?.workspaceRoot,
      },
    })

    return [
      createSystemMessage(systemPrompt),
      ...nonSystemMessages,
    ]
  }

  private memoryIdentityFor(input: AgentRuntimeRunInput): MemoryRuntimeIdentity | undefined {
    if (!this.memory || input.memoryEnabled === false) return undefined
    const sessionId = this.contextKeyFor(input)
    if (!sessionId) return undefined
    const context = input.toolContext ?? this.toolContext
    return {
      sessionId,
      workspaceId: stringMetadata(input.metadata?.workspace_id) || context?.workspaceId || context?.workspaceRoot || context?.cwd,
      userId: stringMetadata(input.metadata?.user_id) || context?.userId,
    }
  }

  private async prepareMemory(
    input: AgentRuntimeRunInput,
    identity: MemoryRuntimeIdentity | undefined,
  ): Promise<MemoryContext | undefined> {
    if (!this.memory || !identity) return undefined
    await this.memory.drain()
    const normalized = normalizeAgentMessages(input.messages)
      .filter(message => message.role !== 'system')
      .map(toMemoryCaptureMessage)
    await this.memory.captureMessages(identity, normalized)
    const queryText = [...normalized].reverse().find(message => message.role === 'user')?.content
    return this.memory.retrieve(identity, queryText)
  }

  private completeMemory(
    identity: MemoryRuntimeIdentity | undefined,
    messages: AgentMessage[],
    input: AgentRuntimeRunInput,
  ): void {
    if (!this.memory || !identity) return
    const modelClient = this.modelClientFor(input)
    this.memory.scheduleRunCompletion(
      identity,
      messages.filter(message => message.role !== 'system').map(toMemoryCaptureMessage),
      new ModelMemoryExtractor({
        modelClient,
        memory: this.memory,
        model: input.model ?? input.modelDefaults?.model ?? this.modelDefaults?.model,
        signal: input.signal,
        onUsage: input.onMemoryUsage,
      }),
    )
  }

  private modelRequest(
    input: AgentRuntimeRunInput,
    messages: AgentMessage[],
    modelClient: NonNullable<AgentRuntimeOptions['modelClient']>,
    contextKey: string | undefined,
  ): ModelRequest {
    const modelDefaults = input.modelDefaults ?? this.modelDefaults
    return {
      ...modelDefaults,
      model: input.model ?? modelDefaults?.model,
      temperature: input.temperature ?? modelDefaults?.temperature,
      maxTokens: input.maxTokens ?? modelDefaults?.maxTokens,
      metadata: input.metadata ?? modelDefaults?.metadata,
      messages,
      signal: input.signal,
      tools: this.tools.definitions(),
      stream: modelClient.capabilities.streaming,
      context: input.context ?? (contextKey ? this.modelContexts.get(contextKey) : modelDefaults?.context),
    }
  }

  private contextKeyFor(input: AgentRuntimeRunInput): string | undefined {
    return input.contextKey ||
      (typeof input.metadata?.session_id === 'string' ? input.metadata.session_id : undefined) ||
      input.toolContext?.sessionId ||
      this.defaultContextKey
  }

  private modelClientFor(input: AgentRuntimeRunInput): NonNullable<AgentRuntimeOptions['modelClient']> {
    const modelClient = input.modelClient ?? this.modelClient
    if (!modelClient) {
      throw new Error('AgentRuntime requires a modelClient in constructor options or run input.')
    }
    return modelClient
  }

  private runToolContext(input: AgentRuntimeRunInput): AgentToolContext | undefined {
    const context = input.toolContext ?? this.toolContext
    if (!input.signal) return context
    return {
      ...context,
      signal: input.signal,
    }
  }

  private async executeTool(
    runId: string,
    step: number,
    toolCall: AgentToolCall,
    context: AgentToolContext | undefined,
    emit: (event: AgentRuntimeEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const startedAt = Date.now()
    emit({
      type: 'tool.started',
      runId,
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    })

    try {
      throwIfAborted(signal)
      const rawResult = await this.tools.execute(toolCall.name, toolCall.arguments, context)
      const result = await sanitizeAgentToolResult(rawResult)
      throwIfAborted(signal)
      emit({
        type: result.ok ? 'tool.completed' : 'tool.failed',
        runId,
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: AgentToolResult = {
        ok: false,
        content: message,
        error: message,
      }
      emit({
        type: 'tool.failed',
        runId,
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        durationMs: Date.now() - startedAt,
      })
      return result
    }
  }

  private registerSkillTools(skills: AgentSkill[]): void {
    for (const skill of skills) {
      if (skill.tools?.length) {
        this.tools.registerMany(skill.tools)
      }
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve()
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('Run aborted.')
  error.name = 'AbortError'
  return error
}

function isEmptyModelResponse(response: ModelResponse): boolean {
  return (
    !response.content?.trim() &&
    !response.reasoning?.trim() &&
    !(response.toolCalls?.length)
  )
}

function estimateModelRequestContext(request: ModelRequest): AgentRuntimeContextEstimate {
  const systemMessages = request.messages.filter(message => message.role === 'system')
  const nonSystemMessages = request.messages.filter(message => message.role !== 'system')
  const systemPrompt = systemMessages.map(message => message.content || '').join('\n\n')
  const systemPromptTokens = countTokensLocal(systemPrompt)
  const messageTokens = nonSystemMessages.reduce((sum, message) => {
    return sum + countTokensLocal(message.content || '') + countTokensLocal(JSON.stringify(message.toolCalls || ''))
  }, 0)
  const toolTokens = countTokensLocal(JSON.stringify(request.tools || []))
  const modelContextTokens = request.context == null ? 0 : countTokensLocal(JSON.stringify(request.context))

  return {
    contextTokens: systemPromptTokens + messageTokens + toolTokens + modelContextTokens,
    systemPromptTokens,
    messageTokens,
    toolTokens,
    modelContextTokens,
    messageCount: request.messages.length,
    toolCount: request.tools?.length || 0,
    systemPromptChars: systemPrompt.length,
  }
}

function countTokensLocal(text: string): number {
  if (!text) return 0
  if (hasPathologicalRun(text)) return heuristicTokens(text)
  try {
    return getEncoder().encode(text).length
  } catch {
    return heuristicTokens(text)
  }
}

let cachedEncoder: ReturnType<typeof getEncoding> | null = null

function getEncoder(): ReturnType<typeof getEncoding> {
  if (!cachedEncoder) cachedEncoder = getEncoding('cl100k_base')
  return cachedEncoder
}

function heuristicTokens(text: string): number {
  const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk * 1.5 + other / 4)
}

function hasPathologicalRun(text: string): boolean {
  const maxRun = 20_000
  let run = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    const isLetterOrDigit =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    if (isLetterOrDigit) {
      run += 1
      if (run > maxRun) return true
    } else {
      run = 0
    }
  }
  return false
}

function toMemoryCaptureMessage(message: AgentMessage): MemoryCaptureMessage {
  return {
    role: message.role,
    content: message.content,
  }
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
