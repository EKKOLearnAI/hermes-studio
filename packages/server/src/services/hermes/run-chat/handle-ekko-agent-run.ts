import type { Server, Socket } from 'socket.io'
import { createHash } from 'crypto'
import { inspect } from 'util'
import {
  createModelClient,
  resolveModelProviderConfigs,
  type AgentMessage,
  type AgentToolCall,
  type ModelClient,
  type ModelEvent,
  type AgentRuntimeEvent,
  type ModelProviderConfig,
  type ModelRequest,
  type ModelResponse,
} from '../../../../../ekko-agent/src'
import { getGlobalEkkoAgent } from '../../ekko-agent/manager'
import { resolveEkkoMcpServers } from '../../ekko-agent/mcp'
import { createSession, addMessage, getSession, updateSessionStats } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import { getProfileDir } from '../hermes-profile'
import { observeRunChatPetEvent } from '../pet-state-socket'
import { contentBlocksToString, extractTextForPreview } from './content-blocks'
import { getOrCreateSession } from './compression'
import { resolveBridgeRunModelConfig, type RunModelGroup } from './model-config'
import { estimateUsageTokensFromMessages } from './usage'
import type { ChatCodingAgentId, ContentBlock, SessionState } from './types'

export interface EkkoAgentRunSocketData {
  input: string | ContentBlock[]
  display_input?: string | ContentBlock[] | null
  display_role?: 'user' | 'command'
  storage_message?: string
  session_id?: string
  profile?: string
  provider?: string
  model?: string
  model_groups?: RunModelGroup[]
  coding_agent_id?: ChatCodingAgentId
  agent_id?: ChatCodingAgentId
  mode?: 'scoped' | 'global'
  workspace?: string | null
  source?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: string
  api_mode?: string
  mcpServers?: Record<string, unknown>
  mcp_servers?: Record<string, unknown>
  peerExcludeSocketId?: string
  queue_id?: string
  onEvent?: (event: string, payload: any) => void
}

function isEkkoAgentId(data: EkkoAgentRunSocketData): boolean {
  return data.coding_agent_id === 'ekko-agent' || data.agent_id === 'ekko-agent'
}

function toAgentMessages(messages: SessionState['messages']): AgentMessage[] {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'command')
    .map((message): AgentMessage => {
      const role: AgentMessage['role'] = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
      return {
        role,
        content: contentBlocksToString(message.content as any),
        reasoning: message.reasoning || message.reasoning_content || undefined,
      }
    })
    .filter(message => message.content.trim().length > 0 || (message.reasoning?.trim().length ?? 0) > 0)
}

function appendStateEvent(state: SessionState, event: string, payload: any): void {
  if (!state.isWorking) return
  state.events.push({ event, data: payload })
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200)
}

function redactProviderConfig(config: ModelProviderConfig): ModelProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey ? apiKeyDebugInfo(config.apiKey) : undefined,
    headers: config.headers
      ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [
          key,
          /authorization|api[-_]?key|token/i.test(key) ? headerSecretDebugInfo(value) : value,
        ]))
      : undefined,
  }
}

function apiKeyDebugInfo(apiKey: string): string {
  return `[present length=${apiKey.length} last4=${apiKey.slice(-4)} sha256=${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}]`
}

function headerSecretDebugInfo(value: unknown): string {
  const raw = String(value ?? '')
  if (!raw) return '[empty]'
  const token = raw.replace(/^Bearer\s+/i, '')
  return raw.startsWith('Bearer ')
    ? `Bearer ${apiKeyDebugInfo(token)}`
    : apiKeyDebugInfo(raw)
}

function consolePayload(value: unknown): string {
  return inspect(value, {
    depth: null,
    colors: false,
    maxArrayLength: null,
    maxStringLength: null,
    breakLength: 120,
    compact: false,
  })
}

function errorPayload(err: unknown): unknown {
  if (!(err instanceof Error)) return err
  const withDetails = err as Error & {
    provider?: string
    statusCode?: number
    retryable?: boolean
    details?: unknown
  }
  return {
    name: err.name,
    message: err.message,
    provider: withDetails.provider,
    statusCode: withDetails.statusCode,
    retryable: withDetails.retryable,
    details: withDetails.details,
    stack: err.stack,
  }
}

function shouldUsePlainChatRequest(config: ModelProviderConfig): boolean {
  const provider = String(config.id || '').toLowerCase()
  const baseUrl = String(config.baseUrl || '').toLowerCase()
  return provider.includes('glm') || baseUrl.includes('bigmodel.cn')
}

function requestForProvider(request: ModelRequest, config: ModelProviderConfig): ModelRequest {
  if (!shouldUsePlainChatRequest(config)) return request
  return {
    ...request,
    metadata: undefined,
  }
}

function shouldFallbackProtocol(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number } | null)?.statusCode
  return statusCode === 400 || statusCode === 404 || statusCode === 405 || statusCode === 415 || statusCode === 422
}

function toStoredToolCall(toolCall: AgentToolCall) {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.rawArguments || JSON.stringify(toolCall.arguments || {}),
    },
  }
}

function createConsoleModelClient(
  client: ModelClient,
  context: {
    sessionId: string
    providerConfig: ModelProviderConfig
    fallback?: {
      client: ModelClient
      providerConfig: ModelProviderConfig
    }
  },
): ModelClient {
  return {
    ...client,
    provider: client.provider,
    requestStyle: client.requestStyle,
    capabilities: client.capabilities,
    async create(request: ModelRequest): Promise<ModelResponse> {
      const providerRequest = requestForProvider(request, context.providerConfig)
      console.log('[ekko-agent] model request', consolePayload({
        session_id: context.sessionId,
        provider_config: redactProviderConfig(context.providerConfig),
        request: providerRequest,
      }))
      try {
        const response = await client.create(providerRequest)
        console.log('[ekko-agent] model request success', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
          response,
        }))
        return response
      } catch (err) {
        console.error('[ekko-agent] model request failed', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
          error: errorPayload(err),
        }))
        if (context.fallback && context.fallback.providerConfig.requestStyle !== context.providerConfig.requestStyle && shouldFallbackProtocol(err)) {
          const fallbackRequest = requestForProvider(request, context.fallback.providerConfig)
          console.warn('[ekko-agent] model request protocol fallback', consolePayload({
            session_id: context.sessionId,
            from_request_style: context.providerConfig.requestStyle,
            to_request_style: context.fallback.providerConfig.requestStyle,
            provider_config: redactProviderConfig(context.fallback.providerConfig),
            request: fallbackRequest,
          }))
          try {
            const response = await context.fallback.client.create(fallbackRequest)
            console.log('[ekko-agent] model request fallback success', consolePayload({
              session_id: context.sessionId,
              provider: context.fallback.client.provider,
              request_style: context.fallback.client.requestStyle,
              response,
            }))
            return response
          } catch (fallbackErr) {
            console.error('[ekko-agent] model request fallback failed', consolePayload({
              session_id: context.sessionId,
              provider: context.fallback.client.provider,
              request_style: context.fallback.client.requestStyle,
              error: errorPayload(fallbackErr),
            }))
          }
        }
        throw err
      }
    },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const providerRequest = requestForProvider(request, context.providerConfig)
      console.log('[ekko-agent] model stream request', consolePayload({
        session_id: context.sessionId,
        provider_config: redactProviderConfig(context.providerConfig),
        request: providerRequest,
      }))
      try {
        for await (const event of client.stream(providerRequest)) {
          yield event
        }
        console.log('[ekko-agent] model stream success', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
        }))
      } catch (err) {
        console.error('[ekko-agent] model stream failed', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
          error: errorPayload(err),
        }))
        if (context.fallback && context.fallback.providerConfig.requestStyle !== context.providerConfig.requestStyle && shouldFallbackProtocol(err)) {
          const fallbackRequest = requestForProvider(request, context.fallback.providerConfig)
          console.warn('[ekko-agent] model stream protocol fallback', consolePayload({
            session_id: context.sessionId,
            from_request_style: context.providerConfig.requestStyle,
            to_request_style: context.fallback.providerConfig.requestStyle,
            provider_config: redactProviderConfig(context.fallback.providerConfig),
            request: fallbackRequest,
          }))
          try {
            for await (const event of context.fallback.client.stream(fallbackRequest)) {
              yield event
            }
            console.log('[ekko-agent] model stream fallback success', consolePayload({
              session_id: context.sessionId,
              provider: context.fallback.client.provider,
              request_style: context.fallback.client.requestStyle,
            }))
            return
          } catch (fallbackErr) {
            console.error('[ekko-agent] model stream fallback failed', consolePayload({
              session_id: context.sessionId,
              provider: context.fallback.client.provider,
              request_style: context.fallback.client.requestStyle,
              error: errorPayload(fallbackErr),
            }))
          }
        }
        throw err
      }
    },
  }
}

export async function handleEkkoAgentRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: EkkoAgentRunSocketData,
  profile: string,
  sessionMap: Map<string, SessionState>,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => boolean,
  skipUserMessage = false,
) {
  const sessionId = String(data.session_id || '').trim()
  if (!sessionId) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for ekko-agent runs' })
    return
  }
  if (!isEkkoAgentId(data)) {
    socket.emit('run.failed', { event: 'run.failed', session_id: sessionId, error: 'ekko-agent run requires coding_agent_id=ekko-agent' })
    return
  }

  socket.join(`session:${sessionId}`)
  const state = getOrCreateSession(sessionMap, sessionId)
  state.isWorking = true
  state.isAborting = false
  state.profile = profile
  state.source = data.source === 'workflow' ? 'workflow' : 'coding_agent'
  state.events = []
  const abortController = new AbortController()
  state.abortController = abortController

  const storedSession = getSession(sessionId)
  const modelConfig = await resolveBridgeRunModelConfig({
    profile,
    sessionModel: storedSession?.model,
    sessionProvider: storedSession?.provider,
    requestedModel: data.model,
    requestedProvider: data.provider,
    modelGroups: data.model_groups,
    preferRequested: true,
  })
  const workspace = data.workspace || storedSession?.workspace || getProfileDir(profile)
  const displayInput = data.display_input === undefined ? data.input : data.display_input
  const inputText = contentBlocksToString(data.input)
  const displayText = displayInput == null ? '' : contentBlocksToString(displayInput)
  const storageText = data.storage_message !== undefined ? data.storage_message : displayText
  const shouldPersistUserMessage = !skipUserMessage && displayInput !== null
  const now = Math.floor(Date.now() / 1000)
  const emit = (event: string, payload: any) => {
    const tagged = { ...payload, session_id: sessionId }
    observeRunChatPetEvent(profile, event, tagged)
    data.onEvent?.(event, tagged)
    appendStateEvent(state, event, tagged)
    nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!data.onEvent && !nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  if (!storedSession) {
    const previewText = extractTextForPreview(displayInput === null ? data.input : displayInput || data.input)
    const title = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
    createSession({
      id: sessionId,
      profile,
      source: 'coding_agent',
      agent: 'ekko-agent',
      agent_mode: 'scoped',
      model: modelConfig.model,
      provider: modelConfig.provider,
      title,
      workspace,
    })
  }

  if (shouldPersistUserMessage) {
    const role = data.display_role === 'command' ? 'command' : 'user'
    const messageId = addMessage({
      session_id: sessionId,
      role,
      content: storageText,
      timestamp: now,
    })
    state.messages.push({
      id: data.queue_id || messageId || state.messages.length + 1,
      session_id: sessionId,
      role,
      content: storageText,
      timestamp: now,
    })
    const peerTarget = data.peerExcludeSocketId
      ? nsp.to(`session:${sessionId}`).except(data.peerExcludeSocketId)
      : socket.to(`session:${sessionId}`)
    peerTarget.emit('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id: sessionId,
      message: {
        id: data.queue_id || messageId,
        role,
        content: storageText,
        timestamp: now,
      },
    })
  }

  const baseUrl = data.baseUrl || data.base_url || ''
  const apiMode = data.apiMode || data.api_mode
  const apiKey = data.apiKey || data.api_key || undefined
  const { providerConfig, fallbackProviderConfig } = resolveModelProviderConfigs({
    provider: modelConfig.provider,
    baseUrl,
    apiKey,
    model: modelConfig.model,
    apiMode,
    timeoutMs: 120_000,
  })
  const mcpServers = resolveEkkoMcpServers(profile, data.mcpServers || data.mcp_servers)
  const modelClient = createConsoleModelClient(createModelClient(providerConfig), {
    sessionId,
    providerConfig,
    fallback: fallbackProviderConfig
      ? {
          client: createModelClient(fallbackProviderConfig),
          providerConfig: fallbackProviderConfig,
        }
      : undefined,
  })
  const agent = getGlobalEkkoAgent()

  let assistantText = ''
  let assistantReasoning = ''
  let runId = ''
  let usageInput = 0
  let usageOutput = 0
  let sawStreamUsage = false
  let contextEstimate: any
  const handleRuntimeEvent = (event: AgentRuntimeEvent) => {
    if ('runId' in event) runId = event.runId
    if (event.type === 'run.started') {
      state.runId = event.runId
      emit('run.started', {
        event: 'run.started',
        run_id: event.runId,
        model: modelConfig.model,
        provider: modelConfig.provider,
      })
    } else if (event.type === 'context.estimated') {
      contextEstimate = event.estimate
      state.contextTokens = event.estimate.contextTokens
      emit('usage.updated', {
        event: 'usage.updated',
        run_id: event.runId,
        input_tokens: state.inputTokens || 0,
        output_tokens: state.outputTokens || 0,
        total_tokens: (state.inputTokens || 0) + (state.outputTokens || 0),
        contextTokens: event.estimate.contextTokens,
        context_tokens: event.estimate.contextTokens,
        systemPromptTokens: event.estimate.systemPromptTokens,
        toolTokens: event.estimate.toolTokens,
        messageTokens: event.estimate.messageTokens,
        toolCount: event.estimate.toolCount,
      })
    } else if (event.type === 'model.message') {
      const text = event.message.content || ''
      if (text && !event.message.toolCalls?.length) {
        const shouldEmitFullMessage = assistantText.length === 0
        assistantText = text
        if (shouldEmitFullMessage) {
          emit('message.delta', {
            event: 'message.delta',
            run_id: event.runId,
            delta: text,
          })
        }
      }
      if (event.message.usage && !sawStreamUsage) {
        usageInput += event.message.usage.inputTokens || 0
        usageOutput += event.message.usage.outputTokens || 0
      }
    } else if (event.type === 'model.delta') {
      assistantText += event.text
      emit('message.delta', {
        event: 'message.delta',
        run_id: event.runId,
        delta: event.text,
      })
    } else if (event.type === 'model.usage') {
      sawStreamUsage = true
      usageInput += event.usage.inputTokens || 0
      usageOutput += event.usage.outputTokens || 0
    } else if (event.type === 'model.context') {
      emit('context.updated', {
        event: 'context.updated',
        run_id: event.runId,
        context: event.context,
      })
    } else if (event.type === 'model.reasoning') {
      if (event.text) {
        assistantReasoning += event.text
        emit('reasoning.delta', {
          event: 'reasoning.delta',
          run_id: event.runId,
          delta: event.text,
        })
      }
    } else if (event.type === 'tool.started') {
      emit('tool.started', {
        event: 'tool.started',
        run_id: event.runId,
        tool: event.toolName,
        name: event.toolName,
        arguments: event.arguments,
        preview: JSON.stringify(event.arguments || {}),
        tool_call_id: event.toolCallId,
      })
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      emit(event.type, {
        event: event.type,
        run_id: event.runId,
        tool: event.toolName,
        name: event.toolName,
        output: event.result.content,
        preview: event.result.content,
        tool_call_id: event.toolCallId,
        duration: Math.round(event.durationMs / 10) / 100,
        error: event.result.error,
      })
    }
  }

  try {
    logger.info('[chat-run-socket] starting ekko-agent run for session %s', sessionId)
    const result = await agent.run({
      modelClient,
      model: modelConfig.model,
      modelDefaults: {
        model: modelConfig.model,
      },
      messages: toAgentMessages(state.messages),
      signal: abortController.signal,
      onEvent: handleRuntimeEvent,
      toolContext: {
        cwd: workspace,
        workspaceRoot: workspace,
        sessionId,
        browserSessionId: sessionId,
        mcpServers,
        timeoutMs: 120_000,
        signal: abortController.signal,
      },
      metadata: {
        session_id: sessionId,
        profile,
      },
    })
    assistantText = result.output.content || assistantText
    const outputUsage = result.output.usage
    if (outputUsage && !usageInput && !usageOutput) {
      usageInput += outputUsage.inputTokens || 0
      usageOutput += outputUsage.outputTokens || 0
    }
    for (const step of result.steps) {
      if (step.type === 'model' && step.message.toolCalls?.length) {
        const toolCalls = step.message.toolCalls.map(toStoredToolCall)
        const timestamp = Math.floor(Date.now() / 1000)
        const assistantId = addMessage({
          session_id: sessionId,
          role: 'assistant',
          content: step.message.content || '',
          tool_calls: toolCalls,
          timestamp,
          finish_reason: 'tool_calls',
          reasoning: step.message.reasoning || null,
          reasoning_content: step.message.reasoning || null,
        })
        state.messages.push({
          id: assistantId || state.messages.length + 1,
          session_id: sessionId,
          role: 'assistant',
          content: step.message.content || '',
          tool_calls: toolCalls,
          timestamp,
          finish_reason: 'tool_calls',
          reasoning: step.message.reasoning || null,
          reasoning_content: step.message.reasoning || null,
        })
      } else if (step.type === 'tool') {
        const timestamp = Math.floor(Date.now() / 1000)
        const toolId = addMessage({
          session_id: sessionId,
          role: 'tool',
          content: step.result.content,
          tool_call_id: step.toolCallId,
          tool_name: step.toolName,
          timestamp,
          finish_reason: step.result.ok ? null : 'error',
        })
        state.messages.push({
          id: toolId || state.messages.length + 1,
          session_id: sessionId,
          role: 'tool',
          content: step.result.content,
          tool_call_id: step.toolCallId,
          tool_name: step.toolName,
          timestamp,
          finish_reason: step.result.ok ? null : 'error',
        })
      }
    }
    assistantReasoning = result.output.reasoning || assistantReasoning
    const hadToolActivity = result.steps.some(step => step.type === 'tool')
    if (!assistantText.trim() && !assistantReasoning.trim() && !hadToolActivity) {
      const error = 'Model provider returned an empty response after streaming and non-streaming attempts.'
      logger.warn({
        session_id: sessionId,
        provider_config: redactProviderConfig(providerConfig),
        response: result.output,
      }, '[chat-run-socket] ekko-agent model returned empty output')
      emit('run.failed', {
        event: 'run.failed',
        run_id: runId || result.runId,
        error,
        queue_remaining: state.queue.length,
      })
      return
    }
    if (assistantText.trim() || assistantReasoning.trim()) {
      const assistantId = addMessage({
        session_id: sessionId,
        role: 'assistant',
        content: assistantText,
        timestamp: Math.floor(Date.now() / 1000),
        finish_reason: result.output.finishReason || null,
        reasoning: assistantReasoning || null,
        reasoning_content: assistantReasoning || null,
      })
      state.messages.push({
        id: assistantId || state.messages.length + 1,
        session_id: sessionId,
        role: 'assistant',
        content: assistantText,
        timestamp: Math.floor(Date.now() / 1000),
        finish_reason: result.output.finishReason || null,
        reasoning: assistantReasoning || null,
        reasoning_content: assistantReasoning || null,
      })
    }
    if (!usageInput && !usageOutput) {
      const usage = estimateUsageTokensFromMessages([
        { role: 'user', content: inputText },
        { role: 'assistant', content: assistantText },
      ])
      usageInput = usage.inputTokens
      usageOutput = usage.outputTokens
    }
    state.inputTokens = (state.inputTokens || 0) + usageInput
    state.outputTokens = (state.outputTokens || 0) + usageOutput
    updateSessionStats(sessionId)
    emit('usage.updated', {
      event: 'usage.updated',
      run_id: runId || result.runId,
      input_tokens: state.inputTokens || 0,
      output_tokens: state.outputTokens || 0,
      total_tokens: (state.inputTokens || 0) + (state.outputTokens || 0),
      contextTokens: contextEstimate?.contextTokens ?? state.contextTokens,
      context_tokens: contextEstimate?.contextTokens ?? state.contextTokens,
    })
    emit('run.completed', {
      event: 'run.completed',
      run_id: runId || result.runId,
      output: assistantText,
      context: result.context,
      contextTokens: contextEstimate?.contextTokens,
      context_tokens: contextEstimate?.contextTokens,
      contextEstimate,
      usage: {
        input_tokens: usageInput,
        output_tokens: usageOutput,
        total_tokens: usageInput + usageOutput,
      },
      queue_remaining: state.queue.length,
    })
  } catch (err) {
    if (abortController.signal.aborted || isAbortError(err)) {
      logger.info('[chat-run-socket] ekko-agent run aborted for session %s', sessionId)
      return
    }
    const error = err instanceof Error ? err.message : String(err)
    logger.warn(err, '[chat-run-socket] ekko-agent run failed for session %s', sessionId)
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      error,
      queue_remaining: state.queue.length,
    })
  } finally {
    if (!abortController.signal.aborted || state.abortController === abortController) {
      state.isWorking = false
      state.isAborting = false
      state.runId = undefined
      state.abortController = undefined
      state.activeRunMarker = undefined
      state.responseRun = undefined
      state.profile = undefined
      state.events = []
      if (state.queue.length > 0) {
        dequeueNextQueuedRun(socket, sessionId, profile)
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Run aborted.')
}
