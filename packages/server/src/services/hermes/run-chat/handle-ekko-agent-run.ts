import type { Server, Socket } from 'socket.io'
import { createHash, randomUUID } from 'crypto'
import { inspect } from 'util'
import {
  createModelClient,
  resolveModelProviderConfigs,
  type AgentMessage,
  type AgentOutputMessage,
  type AgentToolCall,
  type AgentToolResult,
  type ModelClient,
  type ModelEvent,
  type AgentRuntimeEvent,
  type EkkoLogCategory,
  type EkkoLogLevel,
  type ModelProviderConfig,
  type ModelRequest,
  type ModelResponse,
} from '../../../../../ekko-agent/src'
import { getGlobalEkkoAgent } from '../../ekko-agent/manager'
import { resolveEkkoMcpServers } from '../../ekko-agent/mcp'
import { resolveEkkoProviderRuntimeConfig } from '../../ekko-agent/provider-runtime'
import { createSession, addMessage, addMessages, getSession, updateSession, updateSessionStats } from '../../../db/hermes/session-store'
import type { ChatMessage } from '../../../lib/context-compressor'
import { logger } from '../../logger'
import { recordSessionUsage } from '../../usage-recorder'
import { getProfileDir } from '../hermes-profile'
import { observeRunChatPetEvent } from '../pet-state-socket'
import { contentBlocksToString, convertContentBlocksForAgent, extractTextForPreview } from './content-blocks'
import { buildCompressedHistory, getOrCreateSession } from './compression'
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
  category_id?: number | null
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

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseToolArguments(raw: unknown): { arguments: Record<string, unknown>; rawArguments?: string } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { arguments: raw as Record<string, unknown> }
  const rawArguments = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
  try {
    const parsed = JSON.parse(rawArguments)
    return {
      arguments: parseJsonRecord(parsed) || {},
      rawArguments,
    }
  } catch {
    return { arguments: {}, rawArguments }
  }
}

function normalizeStoredToolCall(raw: unknown): AgentToolCall | null {
  const record = parseJsonRecord(raw)
  if (!record) return null
  const functionRecord = parseJsonRecord(record.function)
  const id = String(record.id || record.call_id || record.tool_call_id || '').trim()
  const name = String(record.name || functionRecord?.name || '').trim()
  if (!id || !name) return null
  const parsed = parseToolArguments(record.arguments ?? functionRecord?.arguments)
  return {
    id,
    name,
    arguments: parsed.arguments,
    rawArguments: parsed.rawArguments,
  }
}

function normalizeStoredToolCalls(value: unknown): AgentToolCall[] | undefined {
  const rawCalls = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? JSON.parse(value)
      : []
  if (!Array.isArray(rawCalls)) return undefined
  const calls = rawCalls
    .map(normalizeStoredToolCall)
    .filter((call): call is AgentToolCall => !!call)
  return calls.length ? calls : undefined
}

function parseStoredContentBlocks(value: unknown): ContentBlock[] | null {
  let parsed = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('[')) return null
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  const valid = parsed.every((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false
    const candidate = block as Record<string, unknown>
    if (candidate.type === 'text') return typeof candidate.text === 'string'
    if (candidate.type === 'image') {
      return typeof candidate.name === 'string' &&
        typeof candidate.path === 'string' &&
        typeof candidate.media_type === 'string'
    }
    if (candidate.type === 'file') {
      return typeof candidate.name === 'string' && typeof candidate.path === 'string'
    }
    return false
  })
  return valid ? parsed as ContentBlock[] : null
}

function imagePartFromDataUri(dataUri: string): NonNullable<AgentMessage['contentParts']>[number] | null {
  const match = /^data:(image\/[^;,]+);base64,([\s\S]+)$/i.exec(dataUri)
  if (!match) return null
  return {
    type: 'image',
    mimeType: match[1].toLowerCase(),
    data: match[2],
  }
}

async function toUserAgentContent(value: unknown): Promise<Pick<AgentMessage, 'content' | 'contentParts'>> {
  const blocks = parseStoredContentBlocks(value)
  if (!blocks) {
    return { content: contentBlocksToString(value as string | ContentBlock[]) }
  }

  const converted = await convertContentBlocksForAgent(blocks)
  const text: string[] = []
  const contentParts: NonNullable<AgentMessage['contentParts']> = []
  for (const part of converted) {
    if (part.type === 'text' && typeof part.text === 'string') {
      text.push(part.text)
      continue
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const imagePart = imagePartFromDataUri(part.image_url.url)
      if (imagePart) contentParts.push(imagePart)
    }
  }
  return {
    content: text.join('\n'),
    contentParts: contentParts.length ? contentParts : undefined,
  }
}

async function toAgentMessages(messages: Array<ChatMessage | SessionState['messages'][number]>): Promise<AgentMessage[]> {
  const toolCallIds = new Set<string>()
  const result: AgentMessage[] = []

  for (const message of messages) {
    if (message.role === 'user' || message.role === 'command' || message.role === 'system') {
      const normalized = message.role === 'system'
        ? { content: contentBlocksToString(message.content as any) }
        : await toUserAgentContent(message.content)
      const content = normalized.content
      if (content.trim()) {
        result.push({
          role: message.role === 'system' ? 'system' : 'user',
          content,
          contentParts: normalized.contentParts,
        })
      }
      continue
    }

    if (message.role === 'assistant') {
      let toolCalls: AgentToolCall[] | undefined
      try {
        toolCalls = normalizeStoredToolCalls(message.tool_calls)
      } catch {
        toolCalls = undefined
      }
      for (const call of toolCalls || []) toolCallIds.add(call.id)
      const agentMessage: AgentMessage = {
        role: 'assistant',
        content: contentBlocksToString(message.content as any),
        reasoning: ('reasoning' in message ? message.reasoning : undefined) || message.reasoning_content || undefined,
        toolCalls,
      }
      if (agentMessage.content.trim() || (agentMessage.reasoning?.trim().length ?? 0) > 0 || toolCalls?.length) {
        result.push(agentMessage)
      }
      continue
    }

    if (message.role === 'tool') {
      const toolCallId = String(message.tool_call_id || '').trim()
      if (!toolCallId || !toolCallIds.has(toolCallId)) continue
      const content = contentBlocksToString(message.content as any)
      result.push({
        role: 'tool',
        content: content.trim() ? content : '(no output)',
        toolCallId,
        name: ('tool_name' in message ? message.tool_name : undefined) ||
          ('name' in message ? message.name : undefined) ||
          undefined,
      })
      toolCallIds.delete(toolCallId)
    }
  }

  return result
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

function modelRequestDebugInfo(request: ModelRequest): ModelRequest {
  return {
    ...request,
    messages: request.messages.map(message => ({
      ...message,
      contentParts: message.contentParts?.map(part => part.type === 'image'
        ? {
            ...part,
            data: `[base64 omitted length=${part.data.length}]`,
          }
        : part),
    })),
  }
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

interface PendingToolGroup {
  runId: string
  step: number
  message: AgentOutputMessage
  results: Map<string, { toolName: string; result: AgentToolResult }>
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
        request: modelRequestDebugInfo(providerRequest),
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
            request: modelRequestDebugInfo(fallbackRequest),
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
        request: modelRequestDebugInfo(providerRequest),
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
            request: modelRequestDebugInfo(fallbackRequest),
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
  const requestedApiMode = data.apiMode || data.api_mode
  const storedApiMode = storedSession?.provider === modelConfig.provider
    ? storedSession.api_mode || undefined
    : undefined
  const runtimeConfig = await resolveEkkoProviderRuntimeConfig({
    profile,
    provider: modelConfig.provider,
    baseUrl: data.baseUrl || data.base_url,
    apiKey: data.apiKey || data.api_key,
    apiMode: requestedApiMode || storedApiMode,
  })
  const baseUrl = runtimeConfig.baseUrl || ''
  const apiMode = runtimeConfig.apiMode
  const apiKey = runtimeConfig.apiKey
  const workspace = data.workspace || storedSession?.workspace || getProfileDir(profile)
  const shouldEmitWorkspaceUpdate = Boolean(workspace && !storedSession?.workspace)
  if (storedSession && !storedSession.workspace) updateSession(sessionId, { workspace })
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
      api_mode: apiMode || '',
      title,
      workspace,
      category_id: data.category_id,
    })
  }
  if (storedSession && apiMode && storedSession.api_mode !== apiMode) {
    updateSession(sessionId, { api_mode: apiMode })
  }
  if (shouldEmitWorkspaceUpdate) {
    emit('session.workspace.updated', {
      event: 'session.workspace.updated',
      workspace,
    })
  }
  try {
    updateSession(sessionId, {
      ended_at: null,
      end_reason: null,
      last_active: now,
      ...(data.category_id !== undefined ? { category_id: data.category_id } : {}),
    })
  } catch (err) {
    logger.warn(err, '[chat-run-socket] failed to reopen ekko-agent session %s', sessionId)
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
  const agent = getGlobalEkkoAgent(profile)
  const memoryUsageBatchId = randomUUID()
  const skillReviewUsageBatchId = randomUUID()
  const turnId = randomUUID()
  const currentInputTokens = estimateUsageTokensFromMessages([
    { role: 'user', content: inputText },
  ]).inputTokens

  let assistantText = ''
  let assistantReasoning = ''
  let runId = ''
  let usageInput = 0
  let usageOutput = 0
  let usageCallIndex = 0
  let contextEstimate: any
  const modelStepStartedAt = new Map<number, number>()
  const pendingToolGroups = new Map<string, PendingToolGroup>()
  const toolCallGroupKeys = new Map<string, string>()
  const persistedToolCallIds = new Set<string>()
  const writeRunLog = (
    category: EkkoLogCategory,
    event: string,
    data?: unknown,
    level: EkkoLogLevel = 'info',
    eventRunId = runId,
  ) => {
    agent.writeLog({
      category,
      event,
      level,
      sessionId,
      runId: eventRunId || undefined,
      turnId,
      data,
    })
  }
  const toolGroupKey = (eventRunId: string, step: number) => `${eventRunId}:${step}`
  const scopedToolCallId = (eventRunId: string, toolCallId: string) => `${eventRunId}:${toolCallId}`
  const rememberToolGroup = (eventRunId: string, step: number, message: AgentOutputMessage) => {
    const toolCalls = message.toolCalls || []
    if (!toolCalls.length) return
    const key = toolGroupKey(eventRunId, step)
    pendingToolGroups.set(key, {
      runId: eventRunId,
      step,
      message,
      results: new Map(),
    })
    for (const toolCall of toolCalls) {
      toolCallGroupKeys.set(scopedToolCallId(eventRunId, toolCall.id), key)
    }
  }
  const persistCompletedToolGroup = (group: PendingToolGroup): boolean => {
    const toolCalls = group.message.toolCalls || []
    if (!toolCalls.length || toolCalls.some(call => !group.results.has(call.id))) return false
    const timestamp = Math.floor(Date.now() / 1000)
    const storedToolCalls = toolCalls.map(toStoredToolCall)
    const rows = [
      {
        session_id: sessionId,
        role: 'assistant',
        content: group.message.content || '',
        tool_calls: storedToolCalls,
        timestamp,
        finish_reason: 'tool_calls',
        reasoning: group.message.reasoning || null,
        reasoning_content: group.message.reasoning || null,
      },
      ...toolCalls.map((toolCall) => {
        const completed = group.results.get(toolCall.id)!
        return {
          session_id: sessionId,
          role: 'tool',
          content: completed.result.content,
          tool_call_id: toolCall.id,
          tool_name: completed.toolName || toolCall.name,
          timestamp,
          finish_reason: completed.result.ok ? null : 'error',
        }
      }),
    ]
    try {
      const ids = addMessages(rows)
      rows.forEach((row, index) => {
        state.messages.push({
          id: ids[index] || state.messages.length + 1,
          ...row,
        })
      })
      for (const toolCall of toolCalls) {
        persistedToolCallIds.add(toolCall.id)
        toolCallGroupKeys.delete(scopedToolCallId(group.runId, toolCall.id))
      }
      pendingToolGroups.delete(toolGroupKey(group.runId, group.step))
      writeRunLog('run', 'run.tool_group_persisted', {
        step: group.step,
        toolCallIds: toolCalls.map(call => call.id),
        toolNames: toolCalls.map(call => call.name),
      }, 'debug', group.runId)
      return true
    } catch (err) {
      logger.warn(err, '[chat-run-socket] failed to incrementally persist Ekko tool group for session %s', sessionId)
      return false
    }
  }
  const rememberToolResult = (
    eventRunId: string,
    toolCallId: string,
    toolName: string,
    result: AgentToolResult,
  ) => {
    const groupKey = toolCallGroupKeys.get(scopedToolCallId(eventRunId, toolCallId))
    if (!groupKey) return
    const group = pendingToolGroups.get(groupKey)
    if (!group) return
    group.results.set(toolCallId, { toolName, result })
    persistCompletedToolGroup(group)
  }
  const logRuntimeEvent = (event: AgentRuntimeEvent) => {
    const eventRunId = event.runId
    if (event.type === 'model.delta' || event.type === 'model.reasoning') return
    if (event.type === 'model.started') {
      modelStepStartedAt.set(event.step, Date.now())
      writeRunLog('model', event.type, { step: event.step }, 'info', eventRunId)
      return
    }
    if (event.type === 'model.retry') {
      const startedAt = modelStepStartedAt.get(event.step)
      writeRunLog('model', event.type, {
        step: event.step,
        retry: event.retry,
        maxRetries: event.maxRetries,
        durationMs: startedAt == null ? undefined : Date.now() - startedAt,
        error: event.error,
      }, 'warn', eventRunId)
      modelStepStartedAt.set(event.step, Date.now())
      return
    }
    if (event.type === 'model.message') {
      const startedAt = modelStepStartedAt.get(event.step)
      modelStepStartedAt.delete(event.step)
      writeRunLog('model', event.type, {
        step: event.step,
        durationMs: startedAt == null ? undefined : Date.now() - startedAt,
        id: event.message.id,
        model: event.message.model,
        finishReason: event.message.finishReason,
        contentChars: event.message.content.length,
        reasoningChars: event.message.reasoning?.length || 0,
        toolCalls: event.message.toolCalls?.map(call => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })) || [],
      }, 'info', eventRunId)
      return
    }
    if (event.type === 'model.tool_call') {
      writeRunLog('model', event.type, {
        step: event.step,
        toolCall: {
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
        },
      }, 'info', eventRunId)
      return
    }
    if (event.type === 'model.usage') {
      writeRunLog('model', event.type, { step: event.step, usage: event.usage }, 'debug', eventRunId)
      return
    }
    if (event.type === 'model.context') {
      writeRunLog('context', event.type, { step: event.step, context: event.context }, 'debug', eventRunId)
      return
    }
    if (event.type === 'context.estimated') {
      writeRunLog('context', event.type, { step: event.step, estimate: event.estimate }, 'debug', eventRunId)
      return
    }
    if (event.type === 'tool.started') {
      writeRunLog(toolLogCategory(event.toolName), event.type, {
        step: event.step,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        arguments: event.arguments,
      }, 'info', eventRunId)
      return
    }
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      writeRunLog(toolLogCategory(event.toolName), event.type, {
        step: event.step,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        ok: event.result.ok,
        error: event.result.error,
        contentChars: event.result.content.length,
        contentPreview: logPreview(event.result.content),
      }, event.type === 'tool.failed' ? 'warn' : 'info', eventRunId)
      return
    }
    if (event.type === 'memory.retrieved') {
      writeRunLog('memory', event.type, {
        diagnostics: event.diagnostics,
        memoryIds: event.memoryIds,
      }, 'debug', eventRunId)
      return
    }
    if (
      event.type === 'skill.review.started' ||
      event.type === 'skill.review.completed' ||
      event.type === 'skill.review.failed'
    ) {
      writeRunLog('skill', event.type, {
        reviewId: event.reviewId,
        ...('mutations' in event ? { mutations: event.mutations } : {}),
        ...('error' in event ? { error: event.error } : {}),
      }, event.type === 'skill.review.failed' ? 'warn' : 'info', eventRunId)
      return
    }
    if (event.type === 'run.started') {
      writeRunLog('run', event.type, { maxSteps: event.maxSteps }, 'info', eventRunId)
      return
    }
    if (event.type === 'run.completed') {
      writeRunLog('run', event.type, {
        steps: event.steps,
        finishReason: event.output.finishReason,
        outputChars: event.output.content.length,
        outputPreview: logPreview(event.output.content),
        contextEstimate: event.contextEstimate,
      }, 'info', eventRunId)
      return
    }
    if (event.type === 'run.failed') {
      writeRunLog('run', event.type, { steps: event.steps, error: event.error }, 'error', eventRunId)
      return
    }
    if (event.type === 'run.tool_failure_limit') {
      writeRunLog('run', event.type, { failures: event.failures }, 'warn', eventRunId)
      return
    }
    if (event.type === 'run.max_steps') {
      writeRunLog('run', event.type, { maxSteps: event.maxSteps }, 'warn', eventRunId)
    }
  }
  writeRunLog('run', 'run.requested', {
    model: modelConfig.model,
    provider: modelConfig.provider,
    requestStyle: providerConfig.requestStyle,
    workspace,
    inputChars: inputText.length,
    currentInputTokens,
    queueId: data.queue_id,
  })
  const handleRuntimeEvent = (event: AgentRuntimeEvent) => {
    if ('runId' in event) runId = event.runId
    logRuntimeEvent(event)
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
      emit('context.estimated', {
        event: 'context.estimated',
        run_id: event.runId,
        contextTokens: event.estimate.contextTokens,
        context_tokens: event.estimate.contextTokens,
        systemPromptTokens: event.estimate.systemPromptTokens,
        toolTokens: event.estimate.toolTokens,
        messageTokens: event.estimate.messageTokens,
        toolCount: event.estimate.toolCount,
      })
    } else if (event.type === 'model.message') {
      rememberToolGroup(event.runId, event.step, event.message)
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
    } else if (event.type === 'model.delta') {
      assistantText += event.text
      emit('message.delta', {
        event: 'message.delta',
        run_id: event.runId,
        delta: event.text,
      })
    } else if (event.type === 'model.usage') {
      usageInput += event.usage.inputTokens || 0
      usageOutput += event.usage.outputTokens || 0
      usageCallIndex += 1
      recordSessionUsage({
        sessionId,
        runId: `${event.runId}:step:${event.step}:call:${usageCallIndex}`,
        source: 'ekko_agent',
        agent: 'ekko_agent',
        usageScope: 'model_call',
        apiCalls: 1,
        usage: event.usage,
        profile,
        model: modelConfig.model,
        provider: modelConfig.provider,
        isEstimated: false,
      })
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
      rememberToolResult(event.runId, event.toolCallId, event.toolName, event.result)
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
    } else if (
      event.type === 'skill.review.started' ||
      event.type === 'skill.review.completed' ||
      event.type === 'skill.review.failed'
    ) {
      emit(event.type, {
        event: event.type,
        run_id: event.runId,
        review_id: event.reviewId,
        ...('mutations' in event ? { mutations: event.mutations } : {}),
        ...('error' in event ? { error: event.error } : {}),
      })
    }
  }

  try {
    logger.info('[chat-run-socket] starting ekko-agent run for session %s', sessionId)
    const authenticatedUserId = socket.data?.user?.id == null ? undefined : String(socket.data.user.id)
    const toolContext = {
      cwd: workspace,
      workspaceRoot: workspace,
      workspaceId: workspace,
      userId: authenticatedUserId,
      sessionId,
      profileId: profile,
      browserSessionId: sessionId,
      mcpServers,
      timeoutMs: 120_000,
      signal: abortController.signal,
    }
    const metadata = {
      session_id: sessionId,
      workspace_id: workspace,
      user_id: authenticatedUserId,
      profile,
    }
    let fixedContextEstimate: Promise<number> | undefined
    const compressedHistory = await buildCompressedHistory(
      sessionId,
      profile,
      baseUrl,
      apiKey,
      emit,
      sessionMap,
      {
        model: modelConfig.model,
        provider: modelConfig.provider,
        allowHermesFallback: false,
      },
      async (_messages, localMessageTokens) => {
        fixedContextEstimate ||= agent.estimateContext({
          modelClient,
          model: modelConfig.model,
          modelDefaults: { model: modelConfig.model },
          messages: [],
          signal: abortController.signal,
          memoryEnabled: false,
          toolContext,
          metadata,
        }).then(estimate => estimate.contextTokens)
        return (await fixedContextEstimate) + localMessageTokens
      },
      currentInputTokens,
      shouldPersistUserMessage && data.display_role !== 'command',
    )
    writeRunLog('context', 'context.history_prepared', {
      historyMessages: compressedHistory.length,
      currentInputTokens,
      contextTokens: contextEstimate?.contextTokens,
    }, 'debug')
    const currentMessage: AgentMessage = {
      role: 'user',
      ...await toUserAgentContent(data.input),
    }
    const result = await agent.run({
      modelClient,
      model: modelConfig.model,
      modelDefaults: {
        model: modelConfig.model,
      },
      messages: [
        ...await toAgentMessages(compressedHistory),
        currentMessage,
      ],
      signal: abortController.signal,
      onEvent: handleRuntimeEvent,
      onMemoryUsage: event => {
        writeRunLog('memory', 'memory.model_usage', event, 'debug')
        recordSessionUsage({
          sessionId,
          runId: `memory-summary:${memoryUsageBatchId}:call:${event.callIndex}`,
          source: 'ekko_agent',
          agent: 'ekko_agent',
          usageScope: 'model_call',
          purpose: event.purpose,
          apiCalls: 1,
          usage: event.usage,
          profile,
          model: event.model || modelConfig.model,
          provider: modelConfig.provider,
          isEstimated: false,
        })
      },
      onSkillReviewUsage: event => {
        writeRunLog('skill', 'skill.review.model_usage', event, 'debug')
        recordSessionUsage({
          sessionId,
          runId: `skill-review:${skillReviewUsageBatchId}:call:${event.callIndex}`,
          source: 'ekko_agent',
          agent: 'ekko_agent',
          usageScope: 'model_call',
          purpose: event.purpose,
          apiCalls: 1,
          usage: event.usage,
          profile,
          model: event.model || modelConfig.model,
          provider: modelConfig.provider,
          isEstimated: false,
        })
      },
      toolContext,
      metadata,
    })
    assistantText = result.output.content || assistantText
    const outputUsage = result.output.usage
    if (outputUsage && !usageInput && !usageOutput) {
      usageInput += outputUsage.inputTokens || 0
      usageOutput += outputUsage.outputTokens || 0
    }
    for (const step of result.steps) {
      if (step.type === 'model' && step.message.toolCalls?.length) {
        const unpersistedToolCalls = step.message.toolCalls.filter(call => !persistedToolCallIds.has(call.id))
        if (!unpersistedToolCalls.length) continue
        const toolCalls = unpersistedToolCalls.map(toStoredToolCall)
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
        if (persistedToolCallIds.has(step.toolCallId)) continue
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
      writeRunLog('run', 'run.empty_response', { error }, 'error', result.runId)
      logger.warn({
        session_id: sessionId,
        provider_config: redactProviderConfig(providerConfig),
        response: result.output,
      }, '[chat-run-socket] ekko-agent model returned empty output')
      if (state.queue.length === 0) {
        try {
          updateSession(sessionId, {
            ended_at: Math.floor(Date.now() / 1000),
            end_reason: 'error',
          })
        } catch (err) {
          logger.warn(err, '[chat-run-socket] failed to write ekko-agent empty-response end marker for %s', sessionId)
        }
      }
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
    if (contextEstimate?.contextTokens != null) state.contextTokens = contextEstimate.contextTokens
    updateSessionStats(sessionId)
    if (state.queue.length === 0) {
      try {
        updateSession(sessionId, {
          ended_at: Math.floor(Date.now() / 1000),
          end_reason: 'complete',
        })
      } catch (err) {
        logger.warn(err, '[chat-run-socket] failed to write ekko-agent session end marker for %s', sessionId)
      }
    }
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
    writeRunLog('run', 'run.persisted', {
      inputTokens: usageInput,
      outputTokens: usageOutput,
      contextTokens: contextEstimate?.contextTokens,
      queueRemaining: state.queue.length,
    }, 'info', result.runId)
  } catch (err) {
    if (abortController.signal.aborted || isAbortError(err)) {
      writeRunLog('run', 'run.aborted', {
        error: err instanceof Error ? err.message : String(err),
      }, 'warn')
      logger.info('[chat-run-socket] ekko-agent run aborted for session %s', sessionId)
      return
    }
    const error = err instanceof Error ? err.message : String(err)
    writeRunLog('run', 'run.handler_failed', { error, exception: err }, 'error')
    logger.warn(err, '[chat-run-socket] ekko-agent run failed for session %s', sessionId)
    if (state.queue.length === 0) {
      try {
        updateSession(sessionId, {
          ended_at: Math.floor(Date.now() / 1000),
          end_reason: 'error',
        })
      } catch (updateErr) {
        logger.warn(updateErr, '[chat-run-socket] failed to write ekko-agent error end marker for %s', sessionId)
      }
    }
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      error,
      queue_remaining: state.queue.length,
    })
  } finally {
    writeRunLog('run', 'run.released', {
      aborted: abortController.signal.aborted,
      queueRemaining: state.queue.length,
    }, 'debug')
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

function logPreview(value: string, maxChars = 4_000): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`
}

function toolLogCategory(toolName: string): EkkoLogCategory {
  if (toolName.startsWith('skill_')) return 'skill'
  if (toolName.startsWith('memory_')) return 'memory'
  return 'tool'
}
