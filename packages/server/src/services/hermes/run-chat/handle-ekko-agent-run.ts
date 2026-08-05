import type { Server, Socket } from 'socket.io'
import { createHash, randomUUID } from 'crypto'
import {
  createModelClient,
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  resolveModelProviderConfigs,
  type AgentMessage,
  type AgentClarificationRequest,
  type AgentOutputMessage,
  type AgentToolCall,
  type AgentToolApprovalRequest,
  type AgentToolResult,
  type ModelClient,
  type ModelEvent,
  type AgentRuntimeEvent,
  type ModelProviderConfig,
  type ModelReasoningEffort,
  type ModelRequest,
  type ModelResponse,
} from '../../../../../ekko-agent/src'
import { getGlobalEkkoAgent } from '../../ekko-agent/manager'
import { waitForEkkoToolApproval } from '../../ekko-agent/approvals'
import { waitForEkkoClarification } from '../../ekko-agent/clarifications'
import { resolveEkkoMcpServers } from '../../ekko-agent/mcp'
import { resolveEkkoProviderRuntimeConfig } from '../../ekko-agent/provider-runtime'
import {
  createSession,
  addMessage,
  addMessages,
  getSession,
  updateMessageDisplayContent,
  updateSession,
  updateSessionStats,
} from '../../../db/hermes/session-store'
import type { ChatMessage } from '../../../lib/context-compressor'
import { logger } from '../../logger'
import { recordSessionUsage } from '../../usage-recorder'
import { observeRunChatPetEvent } from '../pet-state-socket'
import { contentBlocksToString, convertContentBlocksForAgent, extractTextForPreview } from './content-blocks'
import { buildCompressedHistory, getOrCreateSession } from './compression'
import { resolveBridgeRunModelConfig, type RunModelGroup } from './model-config'
import { estimateUsageTokensFromMessages } from './usage'
import type { ChatCodingAgentId, ContentBlock, QueuedRun, SessionState } from './types'
import { completeWorkspaceRunCheckpoint, startWorkspaceRunCheckpoint } from './workspace-diff-tracker'

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
  instructions?: string
  coding_agent_id?: ChatCodingAgentId
  agent_id?: ChatCodingAgentId
  mode?: 'scoped' | 'global'
  workspace?: string | null
  category_id?: number | null
  source?: string
  session_source?: 'global_agent' | 'workflow'
  context_compression_enabled?: boolean
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
  reasoning_effort?: string
  background_delegation_enabled?: boolean
  background_delegation_id?: string
  autonomous?: boolean
  onEvent?: (event: string, payload: any) => void
}

function isEkkoAgentId(data: EkkoAgentRunSocketData): boolean {
  return data.coding_agent_id === 'ekko-agent' || data.agent_id === 'ekko-agent'
}

function normalizeReasoningEffort(value: unknown): ModelReasoningEffort | undefined {
  const effort = String(value || '').trim()
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
    ? effort as ModelReasoningEffort
    : undefined
}

function resolveReasoningEffort(value: unknown): ModelReasoningEffort {
  return normalizeReasoningEffort(value) ?? 'medium'
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function ekkoBackgroundPendingCount(state: SessionState): number {
  return Object.values(state.backgroundTasks || {}).filter(task =>
    task.runtime === 'ekko' && task.status === 'running',
  ).length
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

function createProviderModelClient(
  client: ModelClient,
  context: {
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
    requestTarget: request => client.requestTarget?.(request) || '',
    async create(request: ModelRequest): Promise<ModelResponse> {
      try {
        return await client.create(request)
      } catch (err) {
        if (context.fallback && context.fallback.providerConfig.requestStyle !== context.providerConfig.requestStyle && shouldFallbackProtocol(err)) {
          try {
            return await context.fallback.client.create(request)
          } catch {}
        }
        throw err
      }
    },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      try {
        for await (const event of client.stream(request)) {
          yield event
        }
      } catch (err) {
        if (context.fallback && context.fallback.providerConfig.requestStyle !== context.providerConfig.requestStyle && shouldFallbackProtocol(err)) {
          try {
            for await (const event of context.fallback.client.stream(request)) {
              yield event
            }
            return
          } catch {}
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
    model: modelConfig.model,
    baseUrl: data.baseUrl || data.base_url,
    apiKey: data.apiKey || data.api_key,
    apiMode: requestedApiMode || storedApiMode,
  })
  const baseUrl = runtimeConfig.baseUrl || ''
  const apiMode = runtimeConfig.apiMode
  const apiKey = runtimeConfig.apiKey
  const reasoningEffort = resolveReasoningEffort(data.reasoning_effort)
  const agent = getGlobalEkkoAgent(profile)
  const workspace = data.workspace || storedSession?.workspace || agent.sessionWorkspaceDirectory(sessionId)
  const shouldEmitWorkspaceUpdate = Boolean(workspace && !storedSession?.workspace)
  if (storedSession && !storedSession.workspace) updateSession(sessionId, { workspace })
  const displayInput = data.display_input === undefined ? data.input : data.display_input
  const inputText = contentBlocksToString(data.input)
  const displayText = displayInput == null ? '' : contentBlocksToString(displayInput)
  const storageText = data.storage_message !== undefined ? data.storage_message : displayText
  const shouldPersistUserMessage = !skipUserMessage && displayInput !== null
  const now = Math.floor(Date.now() / 1000)
  const instructions = String(data.instructions || '').trim()
  const instructionMessages: AgentMessage[] = instructions
    ? [{ role: 'system', content: instructions }]
    : []
  const sessionSource = data.session_source === 'global_agent'
    ? 'global_agent'
    : data.session_source === 'workflow' || data.source === 'workflow'
      ? 'workflow'
      : 'coding_agent'
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
      source: sessionSource,
      agent: 'ekko-agent',
      agent_mode: 'scoped',
      model: modelConfig.model,
      provider: modelConfig.provider,
      api_mode: apiMode || '',
      title,
      workspace,
      category_id: data.category_id,
    })
  } else if (
    storedSession.source !== sessionSource ||
    storedSession.agent !== 'ekko-agent' ||
    storedSession.agent_mode !== 'scoped' ||
    storedSession.agent_session_id ||
    storedSession.agent_native_session_id
  ) {
    updateSession(sessionId, {
      source: sessionSource,
      agent: 'ekko-agent',
      agent_mode: 'scoped',
      agent_session_id: '',
      agent_native_session_id: '',
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
    timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  })
  const mcpServers = resolveEkkoMcpServers(profile, data.mcpServers || data.mcp_servers)
  const modelClient = createProviderModelClient(createModelClient(providerConfig), {
    providerConfig,
    fallback: fallbackProviderConfig
      ? {
          client: createModelClient(fallbackProviderConfig),
          providerConfig: fallbackProviderConfig,
        }
      : undefined,
  })
  const memoryUsageBatchId = randomUUID()
  const skillReviewUsageBatchId = randomUUID()
  const turnId = randomUUID()
  const currentInputTokens = estimateUsageTokensFromMessages([
    { role: 'user', content: inputText },
  ]).inputTokens

  let assistantText = ''
  let assistantReasoning = ''
  let assistantMessageId: string | null = null
  let runId = ''
  let workspaceDiffRunId = ''
  let workspaceDiffCompleted = false
  let usageInput = 0
  let usageOutput = 0
  let usageCallIndex = 0
  let contextEstimate: any
  let parentUsagePersisted = false
  const pendingToolGroups = new Map<string, PendingToolGroup>()
  const toolCallGroupKeys = new Map<string, string>()
  const persistedToolCallIds = new Set<string>()
  const streamedSubagentOutput = new Map<string, string>()
  const scheduledBackgroundContinuations = new Set<string>()
  const pendingBackgroundDisplayContent = new Map<string, string>()
  const startWorkspaceRunDiff = (eventRunId: string) => {
    if (workspaceDiffRunId) return
    workspaceDiffRunId = eventRunId
    try {
      startWorkspaceRunCheckpoint({
        sessionId,
        runId: eventRunId,
        workspace,
      })
    } catch (err) {
      logger.warn({ err, sessionId, runId: eventRunId }, '[workspace-diff] failed to start ekko-agent run checkpoint')
    }
  }
  const completeWorkspaceRunDiff = () => {
    if (workspaceDiffCompleted || !workspaceDiffRunId) return null
    workspaceDiffCompleted = true
    try {
      const change = completeWorkspaceRunCheckpoint({
        sessionId,
        runId: workspaceDiffRunId,
        workspace,
        assistantMessageId,
      })
      if (!change) return null
      emit('workspace.diff.completed', {
        event: 'workspace.diff.completed',
        run_id: workspaceDiffRunId,
        change_id: change.change_id,
        change,
      })
      return change
    } catch (err) {
      logger.warn({ err, sessionId, runId: workspaceDiffRunId }, '[workspace-diff] failed to complete ekko-agent run checkpoint')
      return null
    }
  }
  const appendSubagentOutput = (subagentId: string, text: string) => {
    const previous = streamedSubagentOutput.get(subagentId) || ''
    const next = text.startsWith(previous) ? text : `${previous}${text}`
    const bounded = next.slice(-20_000)
    streamedSubagentOutput.set(subagentId, bounded)
    return bounded
  }
  const scheduleBackgroundContinuation = (
    event: Extract<AgentRuntimeEvent, { type: 'subagent.complete' }>,
  ) => {
    if (
      !event.background ||
      event.status === 'interrupted' ||
      scheduledBackgroundContinuations.has(event.subagentId)
    ) return
    scheduledBackgroundContinuations.add(event.subagentId)
    const result = String(event.output || '').trim() || event.summary.trim() || event.outputTail.trim()
    const continuationMessage = [
      'A background subtask requested earlier has finished.',
      `Subtask ID: ${event.subagentId}`,
      `Goal: ${event.goal}`,
      `Status: ${event.status}`,
      'Use the result below to continue the original task and give the user the relevant final response.',
      'Do not merely acknowledge receipt, do not repeat the result unnecessarily, and do not delegate the same work again.',
      '',
      'Background subtask result:',
      result || '(No result was returned.)',
    ].join('\n')
    const queuedRun: QueuedRun = {
      queue_id: `ekko_subagent_${event.subagentId}`,
      input: continuationMessage,
      displayInput: null,
      storageMessage: continuationMessage,
      model: modelConfig.model,
      provider: modelConfig.provider,
      instructions,
      profile,
      workspace,
      source: state.source,
      sessionSource: data.session_source,
      codingAgentId: 'ekko-agent',
      mode: data.mode,
      baseUrl,
      apiKey,
      apiMode,
      mcpServers,
      reasoningEffort,
      backgroundDelegationId: event.subagentId,
      autonomous: true,
    }
    state.queue.push(queuedRun)
    logger.info(
      '[chat-run-socket] queued Ekko background subtask result %s for session %s (busy: %s)',
      event.subagentId,
      sessionId,
      state.isWorking,
    )
    if (!state.isWorking) dequeueNextQueuedRun(socket, sessionId, profile)
  }
  const backgroundSubagentIdFromToolResult = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      const parsed = parseJsonRecord(JSON.parse(value))
      if (parsed?.mode !== 'background') return null
      const subagentId = String(parsed.subagent_id || '').trim()
      return subagentId || null
    } catch {
      return null
    }
  }
  const persistBackgroundDisplayContent = (subagentId: string, displayContent: string) => {
    pendingBackgroundDisplayContent.set(subagentId, displayContent)
    const message = [...state.messages].reverse().find(item =>
      item.role === 'tool' &&
      item.tool_name === 'delegate_task' &&
      backgroundSubagentIdFromToolResult(item.content) === subagentId,
    )
    if (!message) return
    message.display_content = displayContent
    try {
      if (updateMessageDisplayContent(sessionId, message.id, displayContent)) {
        pendingBackgroundDisplayContent.delete(subagentId)
      }
    } catch (err) {
      logger.warn(err, '[chat-run-socket] failed to persist Ekko subagent display state for session %s', sessionId)
    }
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
        const backgroundSubagentId = backgroundSubagentIdFromToolResult(completed.result.content)
        const backgroundDisplayContent = backgroundSubagentId
          ? pendingBackgroundDisplayContent.get(backgroundSubagentId)
          : undefined
        return {
          session_id: sessionId,
          role: 'tool',
          content: completed.result.content,
          display_content: backgroundDisplayContent,
          tool_call_id: toolCall.id,
          tool_name: completed.toolName || toolCall.name,
          timestamp,
          finish_reason: completed.result.ok ? null : 'error',
        }
      }),
    ]
    try {
      const ids = addMessages(rows)
      if (ids[0] != null) assistantMessageId = String(ids[0])
      rows.forEach((row, index) => {
        state.messages.push({
          id: ids[index] || state.messages.length + 1,
          ...row,
        })
      })
      for (const toolCall of toolCalls) {
        persistedToolCallIds.add(toolCall.id)
        toolCallGroupKeys.delete(scopedToolCallId(group.runId, toolCall.id))
        const completed = group.results.get(toolCall.id)!
        const backgroundSubagentId = backgroundSubagentIdFromToolResult(completed.result.content)
        if (backgroundSubagentId && pendingBackgroundDisplayContent.has(backgroundSubagentId)) {
          pendingBackgroundDisplayContent.delete(backgroundSubagentId)
        }
      }
      pendingToolGroups.delete(toolGroupKey(group.runId, group.step))
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
  const handleRuntimeEvent = (event: AgentRuntimeEvent) => {
    if ('runId' in event) runId = event.runId
    if (event.type === 'run.started') {
      startWorkspaceRunDiff(event.runId)
      state.runId = event.runId
      emit('run.started', {
        event: 'run.started',
        run_id: event.runId,
        model: modelConfig.model,
        provider: modelConfig.provider,
        queue_id: data.queue_id,
        autonomous: data.autonomous === true,
        delegation_id: data.background_delegation_id,
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
      event.type === 'subagent.start' ||
      event.type === 'subagent.text' ||
      event.type === 'subagent.thinking' ||
      event.type === 'subagent.tool' ||
      event.type === 'subagent.complete'
    ) {
      const timestamp = Date.now() / 1000
      const currentStreamedOutput = event.type === 'subagent.text'
        ? appendSubagentOutput(event.subagentId, event.text)
        : undefined
      const terminalStreamedOutput = event.type === 'subagent.complete'
        ? streamedSubagentOutput.get(event.subagentId)?.trim()
        : undefined
      const terminalDeliveredSummary = event.type === 'subagent.complete'
        ? event.status === 'completed' && terminalStreamedOutput
          ? terminalStreamedOutput
          : event.summary
        : undefined
      if (event.background) {
        state.backgroundTasks = state.backgroundTasks || {}
        const previous = state.backgroundTasks[event.subagentId] || {}
        const snapshot: Record<string, unknown> = {
          ...previous,
          runtime: 'ekko',
          subagent_id: event.subagentId,
          goal: event.goal,
          background: true,
          last_event: event.type,
          updated_at: timestamp,
        }
        if (event.type === 'subagent.start') {
          Object.assign(snapshot, {
            status: 'running',
            model: event.model,
            started_at: event.startedAt / 1000,
          })
        } else if (event.type === 'subagent.text') {
          snapshot.status = 'running'
          snapshot.output_tail = currentStreamedOutput!.slice(-4_000)
          snapshot.preview = snapshot.output_tail
        } else if (event.type === 'subagent.thinking') {
          snapshot.status = 'running'
          snapshot.preview = event.text
        } else if (event.type === 'subagent.tool') {
          Object.assign(snapshot, {
            status: 'running',
            last_tool: event.toolName,
            arguments: event.arguments,
            tool_count: event.toolCount,
            preview: JSON.stringify(event.arguments || {}),
          })
        } else {
          Object.assign(snapshot, {
            status: event.status,
            summary: event.summary,
            output_tail: event.outputTail,
            duration_seconds: event.durationMs / 1000,
            tool_count: event.toolCount,
            api_calls: event.apiCalls,
            input_tokens: event.inputTokens,
            output_tokens: event.outputTokens,
            cache_read_tokens: event.cacheReadTokens,
            cache_write_tokens: event.cacheWriteTokens,
            reasoning_tokens: event.reasoningTokens,
            completed_at: timestamp,
          })
        }
        state.backgroundTasks[event.subagentId] = snapshot
      }

      if (event.type === 'subagent.complete') {
        if (event.background) {
          const snapshot = state.backgroundTasks?.[event.subagentId] || {}
          persistBackgroundDisplayContent(event.subagentId, JSON.stringify({
            runtime: 'ekko',
            mode: 'background',
            subagent_id: event.subagentId,
            parent_run_id: event.runId,
            child_run_id: event.childRunId,
            task_index: 0,
            task_count: 1,
            goal: event.goal,
            status: event.status,
            summary: terminalDeliveredSummary,
            output_tail: event.outputTail,
            duration_seconds: event.durationMs / 1000,
            tool_count: event.toolCount,
            api_calls: event.apiCalls,
            input_tokens: event.inputTokens,
            output_tokens: event.outputTokens,
            cache_read_tokens: event.cacheReadTokens,
            cache_write_tokens: event.cacheWriteTokens,
            reasoning_tokens: event.reasoningTokens,
            started_at: snapshot.started_at,
            completed_at: timestamp,
          }))
        }
        usageInput += event.inputTokens
        usageOutput += event.outputTokens
        if (event.apiCalls > 0) {
          recordSessionUsage({
            sessionId,
            runId: `${event.runId}:subagent:${event.subagentId}`,
            source: 'ekko_agent',
            agent: 'ekko_agent',
            usageScope: 'model_call',
            purpose: event.background ? 'ekko-background-subtask' : 'ekko-subtask',
            apiCalls: event.apiCalls,
            usage: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              reasoningTokens: event.reasoningTokens,
            },
            profile,
            model: modelConfig.model,
            provider: modelConfig.provider,
            isEstimated: false,
          })
        }
        if (parentUsagePersisted) {
          state.inputTokens = (state.inputTokens || 0) + event.inputTokens
          state.outputTokens = (state.outputTokens || 0) + event.outputTokens
          updateSessionStats(sessionId)
          emit('usage.updated', {
            event: 'usage.updated',
            run_id: event.runId,
            input_tokens: state.inputTokens || 0,
            output_tokens: state.outputTokens || 0,
            total_tokens: (state.inputTokens || 0) + (state.outputTokens || 0),
            contextTokens: state.contextTokens,
            context_tokens: state.contextTokens,
          })
        }
      }

      if (event.type === 'subagent.start') {
        emit(event.type, {
          event: event.type,
          run_id: event.runId,
          parent_run_id: event.runId,
          subagent_id: event.subagentId,
          task_index: 0,
          task_count: 1,
          goal: event.goal,
          background: event.background,
          model: event.model,
          timestamp: event.startedAt / 1000,
        })
      } else if (event.type === 'subagent.text' || event.type === 'subagent.thinking') {
        emit(event.type, {
          event: event.type,
          run_id: event.runId,
          parent_run_id: event.runId,
          child_run_id: event.childRunId,
          subagent_id: event.subagentId,
          task_index: 0,
          task_count: 1,
          goal: event.goal,
          background: event.background,
          text: event.text,
          timestamp,
        })
      } else if (event.type === 'subagent.tool') {
        emit(event.type, {
          event: event.type,
          run_id: event.runId,
          parent_run_id: event.runId,
          child_run_id: event.childRunId,
          subagent_id: event.subagentId,
          task_index: 0,
          task_count: 1,
          goal: event.goal,
          background: event.background,
          tool: event.toolName,
          name: event.toolName,
          arguments: event.arguments,
          preview: JSON.stringify(event.arguments || {}),
          tool_count: event.toolCount,
          timestamp,
        })
      } else {
        emit(event.type, {
          event: event.type,
          run_id: event.runId,
          parent_run_id: event.runId,
          child_run_id: event.childRunId,
          subagent_id: event.subagentId,
          task_index: 0,
          task_count: 1,
          goal: event.goal,
          background: event.background,
          status: event.status,
          summary: terminalDeliveredSummary,
          output_tail: event.outputTail,
          duration_seconds: event.durationMs / 1000,
          tool_count: event.toolCount,
          api_calls: event.apiCalls,
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          cache_read_tokens: event.cacheReadTokens,
          cache_write_tokens: event.cacheWriteTokens,
          reasoning_tokens: event.reasoningTokens,
          timestamp,
        })
        streamedSubagentOutput.delete(event.subagentId)
        scheduleBackgroundContinuation(event)
      }
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
      requestToolApproval: (request: AgentToolApprovalRequest) => waitForEkkoToolApproval(request, {
        sessionId,
        signal: abortController.signal,
        onRequested: pending => {
          emit('approval.requested', {
            event: 'approval.requested',
            run_id: runId || turnId,
            approval_id: pending.approvalId,
            command: pending.command,
            description: pending.description,
            choices: pending.choices,
            allow_permanent: pending.allowPermanent,
            timeout_ms: pending.timeoutMs,
            tool: pending.toolName,
            permission_key: pending.key,
          })
        },
        onResolved: choice => {
          emit('approval.resolved', {
            event: 'approval.resolved',
            run_id: runId || turnId,
            approval_id: request.approvalId,
            choice,
            resolved: true,
          })
        },
      }),
      requestUserClarification: (request: AgentClarificationRequest) => waitForEkkoClarification(request, {
        sessionId,
        signal: abortController.signal,
        onRequested: pending => {
          emit('clarify.requested', {
            event: 'clarify.requested',
            run_id: runId || turnId,
            clarify_id: pending.clarifyId,
            question: pending.question,
            choices: pending.choices || null,
            timeout_ms: pending.timeoutMs,
          })
        },
        onResolved: resolution => {
          emit('clarify.resolved', {
            event: 'clarify.resolved',
            run_id: runId || turnId,
            clarify_id: request.clarifyId,
            resolved: resolution.reason === 'response',
            reason: resolution.reason,
          })
        },
      }),
    }
    const metadata = {
      session_id: sessionId,
      workspace_id: workspace,
      user_id: authenticatedUserId,
      profile,
    }
    let fixedContextEstimate: Promise<number> | undefined
    const compressedHistory = data.context_compression_enabled === false ? [] : await buildCompressedHistory(
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
          messages: instructionMessages,
          signal: abortController.signal,
          memoryEnabled: false,
          toolContext,
          metadata,
          backgroundDelegationEnabled: data.background_delegation_enabled !== false,
        }).then(estimate => estimate.contextTokens)
        return (await fixedContextEstimate) + localMessageTokens
      },
      currentInputTokens,
      shouldPersistUserMessage && data.display_role !== 'command',
    )
    const currentMessage: AgentMessage = {
      role: 'user',
      ...await toUserAgentContent(data.input),
    }
    const result = await agent.run({
      modelClient,
      model: modelConfig.model,
      reasoningEffort,
      reasoningSummary: 'auto',
      modelDefaults: {
        model: modelConfig.model,
        reasoningEffort,
        reasoningSummary: 'auto',
      },
      messages: [
        ...instructionMessages,
        ...await toAgentMessages(compressedHistory),
        currentMessage,
      ],
      signal: abortController.signal,
      logContext: {
        profile,
        sessionId,
        turnId,
      },
      onEvent: handleRuntimeEvent,
      onMemoryUsage: event => {
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
      backgroundDelegationEnabled: data.background_delegation_enabled !== false,
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
        if (assistantId != null) assistantMessageId = String(assistantId)
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
        background_pending: ekkoBackgroundPendingCount(state),
        queue_id: data.queue_id,
        autonomous: data.autonomous === true,
        delegation_id: data.background_delegation_id,
        workspace_run_change: completeWorkspaceRunDiff(),
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
      if (assistantId != null) assistantMessageId = String(assistantId)
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
    parentUsagePersisted = true
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
    const workspaceRunChange = completeWorkspaceRunDiff()
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
      background_pending: ekkoBackgroundPendingCount(state),
      queue_id: data.queue_id,
      autonomous: data.autonomous === true,
      delegation_id: data.background_delegation_id,
      workspace_run_change: workspaceRunChange,
    })
  } catch (err) {
    if (abortController.signal.aborted || isAbortError(err)) {
      logger.info('[chat-run-socket] ekko-agent run aborted for session %s', sessionId)
      completeWorkspaceRunDiff()
      return
    }
    const error = err instanceof Error ? err.message : String(err)
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
      background_pending: ekkoBackgroundPendingCount(state),
      queue_id: data.queue_id,
      autonomous: data.autonomous === true,
      delegation_id: data.background_delegation_id,
      workspace_run_change: completeWorkspaceRunDiff(),
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
