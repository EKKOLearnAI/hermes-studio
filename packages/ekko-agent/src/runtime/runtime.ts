import { randomUUID } from 'node:crypto'
import {
  createSystemMessage,
  createToolResultMessage,
  modelResponseToAgentMessage,
  normalizeAgentMessages,
} from '../model/messages'
import type { AgentOutputMessage } from '../model/messages'
import type { AgentMessage, AgentToolCall, ModelRequest } from '../model/types'
import type { AgentSkill } from '../skills/types'
import { AgentToolRegistry, createDefaultToolRegistry } from '../tools/registry'
import type { AgentToolContext, AgentToolResult } from '../tools/types'
import type { AgentRuntimeEvent } from './events'
import { buildSystemPrompt } from './system-prompt'
import type { AgentRuntimeOptions, AgentRuntimeRunInput, AgentRuntimeRunResult, AgentRuntimeStep } from './types'

export const DEFAULT_AGENT_MAX_STEPS = 90

export class AgentRuntime {
  private readonly modelClient: AgentRuntimeOptions['modelClient']
  private readonly tools: AgentToolRegistry
  private readonly skills: AgentSkill[]
  private readonly systemPrompt?: string
  private readonly runtimeInstructions: string[]
  private readonly maxSteps: number
  private readonly toolContext?: AgentToolContext
  private readonly modelDefaults?: AgentRuntimeOptions['modelDefaults']

  constructor(options: AgentRuntimeOptions) {
    this.modelClient = options.modelClient
    this.tools = options.tools ?? createDefaultToolRegistry()
    this.skills = options.skills ?? []
    this.systemPrompt = options.systemPrompt
    this.runtimeInstructions = options.runtimeInstructions ?? []
    this.maxSteps = options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
    this.toolContext = options.toolContext
    this.modelDefaults = options.modelDefaults
    this.registerSkillTools(this.skills)
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

  async refreshTools(): Promise<void> {
    await this.tools.refreshTools()
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    await this.refreshTools()

    const runId = randomUUID()
    const events: AgentRuntimeEvent[] = []
    const steps: AgentRuntimeStep[] = []
    const maxSteps = input.maxSteps ?? this.maxSteps
    const emit = (event: AgentRuntimeEvent) => {
      events.push(event)
      input.onEvent?.(event)
    }

    emit({ type: 'run.started', runId, maxSteps })

    const runSkills = [...this.skills, ...(input.skills ?? [])]
    this.registerSkillTools(input.skills ?? [])
    const messages = this.prepareMessages(input, runSkills)
    let output: AgentOutputMessage = {
      role: 'assistant',
      content: '',
    }

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        emit({ type: 'model.started', runId, step })
        const response = await this.modelClient.create(this.modelRequest(input, messages))
        const assistantMessage = modelResponseToAgentMessage(response)
        output = assistantMessage
        messages.push(assistantMessage)
        steps.push({ type: 'model', step, message: assistantMessage })
        emit({ type: 'model.message', runId, step, message: assistantMessage })

        const toolCalls = assistantMessage.toolCalls ?? []
        if (toolCalls.length === 0) {
          emit({ type: 'run.completed', runId, output, steps: step })
          return { runId, messages, output, steps, events }
        }

        for (const toolCall of toolCalls) {
          const result = await this.executeTool(runId, step, toolCall, input.toolContext ?? this.toolContext, emit)
          messages.push(createToolResultMessage(toolCall.id, result.content, toolCall.name))
          steps.push({ type: 'tool', step, toolCallId: toolCall.id, toolName: toolCall.name, result })
        }
      }

      emit({ type: 'run.max_steps', runId, maxSteps })
      output = {
        role: 'assistant',
        content: `Stopped after reaching maxSteps (${maxSteps}).`,
        finishReason: 'max_steps',
      }
      emit({ type: 'run.completed', runId, output, steps: maxSteps })
      return { runId, messages, output, steps, events }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'run.failed', runId, error: message, steps: steps.length })
      throw error
    }
  }

  private prepareMessages(input: AgentRuntimeRunInput, skills: AgentSkill[]): AgentMessage[] {
    const normalized = normalizeAgentMessages(input.messages)
    const userSystemMessages = normalized.filter(message => message.role === 'system').map(message => message.content)
    const nonSystemMessages = normalized.filter(message => message.role !== 'system')
    const systemPrompt = buildSystemPrompt({
      basePrompt: input.systemPrompt ?? this.systemPrompt,
      runtimeInstructions: this.runtimeInstructions,
      userSystemMessages,
      skills,
      tools: this.tools.definitions(),
      context: input.toolContext ?? this.toolContext,
    })

    return [
      createSystemMessage(systemPrompt),
      ...nonSystemMessages,
    ]
  }

  private modelRequest(input: AgentRuntimeRunInput, messages: AgentMessage[]): ModelRequest {
    return {
      ...this.modelDefaults,
      model: input.model ?? this.modelDefaults?.model,
      temperature: input.temperature ?? this.modelDefaults?.temperature,
      maxTokens: input.maxTokens ?? this.modelDefaults?.maxTokens,
      metadata: input.metadata ?? this.modelDefaults?.metadata,
      messages,
      tools: this.tools.definitions(),
      stream: false,
    }
  }

  private async executeTool(
    runId: string,
    step: number,
    toolCall: AgentToolCall,
    context: AgentToolContext | undefined,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentToolResult> {
    emit({
      type: 'tool.started',
      runId,
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    })

    try {
      const result = await this.tools.execute(toolCall.name, toolCall.arguments, context)
      emit({
        type: result.ok ? 'tool.completed' : 'tool.failed',
        runId,
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
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
