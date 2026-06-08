/**
 * CLI Bridge run handler — handles runs that use the agent bridge
 * to communicate with Hermes CLI agent.
 */

import type { Server, Socket } from 'socket.io'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession, getSessionDetail, createSession, addMessage, updateSession, updateSessionStats } from '../../../db/hermes/session-store'
import { updateUsage } from '../../../db/hermes/usage-store'
import { logger, bridgeLogger } from '../../logger'
import { AgentBridgeClient, type AgentBridgeContextEstimate, type AgentBridgeMessage, type AgentBridgeOutput } from '../agent-bridge'
import { contentBlocksToString, convertContentBlocksForAgent, extractTextForPreview, isContentBlockArray } from './content-blocks'
import { buildCompressedHistory, buildDbHistory, buildSnapshotAwareHistory, forceCompressBridgeHistory, pushState, replaceState } from './compression'
import {
  calcAndUpdateUsage,
  contextTokensWithCachedOverhead,
  estimateUsageTokensFromMessages,
  getCachedBridgeContextOverhead,
  updateMessageContextTokenUsage,
} from './usage'
import {
  flushBridgePendingToDb,
  ensureOpenBridgeAssistantMessage,
  syncBridgeReasoningToMessage,
  recordBridgeToolStarted,
  recordBridgeToolCompleted,
} from './bridge-message'
import { summarizeToolArguments } from './response-utils'
import type { ContentBlock, QueuedRun, SessionState } from './types'
import type { ChatMessage } from '../../../lib/context-compressor'
import { resolveBridgeRunModelConfig, type RunModelGroup } from './model-config'
import { filterBridgeToolCallMarkupDelta, flushPendingToolCallMarkup } from './bridge-delta'
import { markAbortCompleted } from './abort'

const BRIDGE_USAGE_FLUSH_DELAY_MS = 200
const BRIDGE_TITLE_EVENT_POLL_INTERVAL_MS = 500
const BRIDGE_TITLE_EVENT_POLL_TIMEOUT_MS = 45_000

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTitleText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function fallbackTitleFromText(text: string, limit: number, ellipsis: boolean): string {
  const normalized = normalizeTitleText(text)
  if (!normalized) return ''
  if (normalized.length <= limit) return normalized
  return ellipsis ? `${normalized.slice(0, limit)}...` : normalized.slice(0, limit)
}

function isReplaceableLocalTitle(sessionId: string): boolean {
  const detail = getSessionDetail(sessionId)
  if (!detail) return false
  const current = normalizeTitleText(detail.title)
  if (!current) return true
  const variants = new Set<string>([''])
  const preview = normalizeTitleText(detail.preview)
  if (preview) {
    variants.add(preview)
    variants.add(fallbackTitleFromText(preview, 40, true))
    variants.add(fallbackTitleFromText(preview, 63, false))
    variants.add(fallbackTitleFromText(preview, 100, false))
  }
  const firstUser = detail.messages.find(message => message.role === 'user' && normalizeTitleText(message.content))
  const firstUserText = normalizeTitleText(firstUser?.content)
  if (firstUserText) {
    variants.add(firstUserText)
    variants.add(fallbackTitleFromText(firstUserText, 40, true))
    variants.add(fallbackTitleFromText(firstUserText, 63, false))
    variants.add(fallbackTitleFromText(firstUserText, 100, false))
  }
  return variants.has(current)
}

function syncBridgeGeneratedTitle(sessionId: string, title: unknown, emit: (event: string, payload: any) => void): boolean {
  const nextTitle = normalizeTitleText(title)
  if (!nextTitle) return false
  const session = getSession(sessionId)
  if (!session || session.source !== 'cli') return false
  if (!isReplaceableLocalTitle(sessionId)) {
    logger.info('[chat-run-socket] skipped Hermes generated title for manually titled session %s', sessionId)
    return false
  }
  if (normalizeTitleText(session.title) === nextTitle) return false
  updateSession(sessionId, {
    title: nextTitle,
    last_active: Math.floor(Date.now() / 1000),
  } as any)
  emit('session.title.updated', {
    event: 'session.title.updated',
    session_id: sessionId,
    title: nextTitle,
  })
  return true
}

function shouldPollBridgeGeneratedTitle(sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session || session.source !== 'cli') return false
  const detail = getSessionDetail(sessionId)
  if (!detail) return false
  const userMessageCount = detail.messages.filter(message => message.role === 'user').length
  return userMessageCount <= 2 && isReplaceableLocalTitle(sessionId)
}

function looksLikeAgentFailure(value: string): boolean {
  return /\bAPI call failed after\b/i.test(value)
    || /\bHTTP\s+(?:4\d\d|5\d\d)\b/i.test(value)
    || /\b(?:401|403|429|500|502|503|504)\b/.test(value) && /\b(?:unauthorized|forbidden|rate limit|unavailable|failed|error)\b/i.test(value)
}

export function bridgeTerminalError(chunk: Pick<AgentBridgeOutput, 'status' | 'error' | 'result'>): string | null {
  const result = chunk.result && typeof chunk.result === 'object' && !Array.isArray(chunk.result)
    ? chunk.result as Record<string, unknown>
    : null
  const resultError = result
    ? stringValue(result.error)
      || stringValue(result.exception)
      || stringValue(result.message)
    : ''
  const finalResponse = result ? stringValue(result.final_response) : ''

  if (chunk.status === 'error') {
    return stringValue(chunk.error) || resultError || finalResponse || 'Agent run failed'
  }

  if (result?.failed === true || result?.completed === false) {
    return resultError || finalResponse || 'Agent reported failure'
  }

  if (resultError) return resultError
  if (finalResponse && looksLikeAgentFailure(finalResponse)) return finalResponse

  return null
}

function findOpenAssistantMessage(state: SessionState, runMarker: string) {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]
    if (message.runMarker === runMarker && message.role === 'assistant' && message.finish_reason == null) return message
  }
  return undefined
}

function flushPendingToolMarkupToAssistant(
  state: SessionState,
  runMarker: string,
  runId: string,
  emit: (event: string, payload: any) => void,
): string {
  const pendingMarkup = flushPendingToolCallMarkup(state)
  if (!pendingMarkup) return ''

  state.bridgeOutput = (state.bridgeOutput || '') + pendingMarkup
  state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + pendingMarkup
  const last = findOpenAssistantMessage(state, runMarker)
  if (last) {
    last.content += pendingMarkup
  }
  emit('message.delta', {
    event: 'message.delta',
    run_id: runId,
    delta: pendingMarkup,
    output: state.bridgeOutput,
  })
  return pendingMarkup
}

function processBridgeTextDelta(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  runId: string,
  rawDelta: string,
  emit: (event: string, payload: any) => void,
): void {
  const delta = filterBridgeToolCallMarkupDelta(state, rawDelta)
  if (!delta) return
  state.bridgeOutput = (state.bridgeOutput || '') + delta
  state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + delta
  const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
  if (last?.role === 'assistant' && last.finish_reason == null) {
    last.content += delta
    syncBridgeReasoningToMessage(last, state.bridgePendingReasoningContent)
  } else {
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      role: 'assistant',
      content: delta,
      reasoning: state.bridgePendingReasoningContent || null,
      reasoning_content: state.bridgePendingReasoningContent || null,
      timestamp: Math.floor(Date.now() / 1000),
    })
  }
  emit('message.delta', {
    event: 'message.delta',
    run_id: runId,
    delta,
    output: state.bridgeOutput,
  })
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function cacheBridgeContext(state: SessionState, data: Record<string, unknown> | AgentBridgeContextEstimate) {
  const fixedContextTokens = finiteToken(data.fixed_context_tokens)
  if (fixedContextTokens == null) return
  state.bridgeContext = {
    fixedContextTokens,
    systemPromptTokens: finiteToken(data.system_prompt_tokens),
    toolTokens: finiteToken(data.tool_tokens),
    systemPromptChars: finiteToken(data.system_prompt_chars),
    toolCount: finiteToken(data.tool_count),
    toolNames: Array.isArray(data.tool_names) ? data.tool_names.map(String) : undefined,
    profile: typeof data.profile === 'string' ? data.profile : state.bridgeContext?.profile,
    model: typeof data.model === 'string' ? data.model : state.bridgeContext?.model,
    provider: typeof data.provider === 'string' ? data.provider : state.bridgeContext?.provider,
  }
}

function bridgeContextMatches(
  state: SessionState,
  expected: { profile: string; model?: string | null; provider?: string | null },
): boolean {
  const context = state.bridgeContext
  if (!context) return false
  if (context.profile && context.profile !== expected.profile) return false
  if (expected.model && context.model && context.model !== expected.model) return false
  if (expected.provider && context.provider && context.provider !== expected.provider) return false
  return true
}

async function ensureBridgeFixedContext(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  instructions: string
  state: SessionState
  bridge: AgentBridgeClient
  refresh?: boolean
}): Promise<number | undefined> {
  const cached = bridgeContextMatches(args.state, args)
    ? getCachedBridgeContextOverhead(args.state)
    : undefined
  if (!args.refresh && cached != null) return cached

  try {
    const estimate = await args.bridge.contextEstimate(
      args.sessionId,
      [],
      args.instructions,
      args.profile,
      { model: args.model ?? undefined, provider: args.provider ?? undefined },
    )
    cacheBridgeContext(args.state, estimate)
    const fixedContextTokens = getCachedBridgeContextOverhead(args.state)
    bridgeLogger.info({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      toolCount: estimate.tool_count,
      systemPromptChars: estimate.system_prompt_chars,
      fixedContextTokens,
    }, '[chat-run-socket] fixed context estimate')
    return fixedContextTokens
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      cachedFixedContextTokens: cached,
    }, '[chat-run-socket] fixed context estimate failed')
    return cached
  }
}

export async function handleBridgeRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: { input: string | ContentBlock[]; display_input?: string | ContentBlock[] | null; display_role?: 'user' | 'command'; storage_message?: string; session_id?: string; model?: string; provider?: string; model_groups?: RunModelGroup[]; instructions?: string; workspace?: string | null; source?: string; queue_id?: string; peerExcludeSocketId?: string; reasoning_effort?: string },
  profile: string,
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  skipUserMessage = false,
  loadSessionStateFromDbFn: (sid: string, sessionMap: Map<string, SessionState>) => Promise<SessionState>,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
) {
  const { input, session_id, instructions } = data
  if (!session_id) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for cli source' })
    return
  }

  let fullInstructions = instructions
    ? `${getSystemPrompt()}\n${instructions}`
    : getSystemPrompt()
  const sessionRow = getSession(session_id)
  const workspace = sessionRow?.workspace || String(data.workspace || '').trim()
  const sessionModel = sessionRow?.model || ''
  const sessionProvider = sessionRow?.provider || ''
  const { model: resolvedModel, provider: resolvedProvider } = await resolveBridgeRunModelConfig({
    profile,
    sessionModel,
    sessionProvider,
    requestedModel: data.model,
    requestedProvider: data.provider,
    modelGroups: data.model_groups,
  })
  if (sessionRow) {
    const updates: { model?: string; provider?: string } = {}
    if (resolvedModel && sessionRow.model !== resolvedModel) updates.model = resolvedModel
    if (resolvedProvider && sessionRow.provider !== resolvedProvider) updates.provider = resolvedProvider
    if (Object.keys(updates).length > 0) updateSession(session_id, updates)
  }
  const runContext = [
    `[Current Hermes profile: ${profile}]`,
    workspace ? `[Current working directory: ${workspace}]` : '',
    'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header if the endpoint supports profile-scoped behavior.',
  ].filter(Boolean).join('\n')
  fullInstructions = `\n${runContext}\n${fullInstructions}`

  const runMarker = `cli_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = Math.floor(Date.now() / 1000)
  let state = sessionMap.get(session_id)
  if (!state) {
    state = getSession(session_id)
      ? await loadSessionStateFromDbFn(session_id, sessionMap)
      : { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(session_id, state)
  }

  state.isWorking = true
  state.isAborting = false
  state.events = []
  state.profile = profile
  state.source = 'cli'
  state.activeRunMarker = runMarker
  state.runId = undefined
  state.abortController = undefined
  state.bridgeOutput = ''
  state.bridgePendingAssistantContent = ''
  state.bridgePendingReasoningContent = ''
  state.bridgePendingToolCallMarkup = ''
  state.bridgeToolCounter = 0
  state.bridgePendingTools = []
  state.responseRun = undefined

  const displayInput = data.display_input === undefined ? input : data.display_input
  const inputStr = displayInput == null ? '' : contentBlocksToString(displayInput)
  const actualInputStr = contentBlocksToString(input)
  const currentInputUsage = estimateUsageTokensFromMessages([{ role: 'user', content: actualInputStr }])
  const currentInputTokens = currentInputUsage.inputTokens
  const shouldPersistUserMessage = !skipUserMessage && displayInput !== null
  const displayRole = data.display_role === 'command' ? 'command' : 'user'
  let messageId: number | string | undefined

  if (shouldPersistUserMessage) {
    state.messages.push({
      id: state.messages.length + 1,
      session_id,
      runMarker,
      role: displayRole,
      content: inputStr,
      timestamp: now,
    })

    if (!getSession(session_id)) {
      const previewText = extractTextForPreview(displayInput || input)
      const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
      createSession({ id: session_id, profile, source: 'cli', model: resolvedModel, provider: resolvedProvider, title: preview, workspace: data.workspace || undefined })
    }
    messageId = addMessage({
      session_id,
      role: displayRole,
      content: inputStr,
      timestamp: now,
    })
  } else if (!getSession(session_id)) {
    const previewText = displayInput === null ? extractTextForPreview(input) : extractTextForPreview(displayInput || input)
    const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
    createSession({ id: session_id, profile, source: 'cli', model: resolvedModel, provider: resolvedProvider, title: preview, workspace: data.workspace || undefined })
  }

  socket.join(`session:${session_id}`)
  if (shouldPersistUserMessage) {
    const peerTarget = data.peerExcludeSocketId
      ? nsp.to(`session:${session_id}`).except(data.peerExcludeSocketId)
      : socket.to(`session:${session_id}`)
    peerTarget.emit('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id,
      message: {
        id: data.queue_id || messageId,
        role: displayRole,
        content: inputStr,
        timestamp: now,
      },
    })
  }
  const emit = (event: string, payload: any) => {
    const tagged = { ...payload, session_id }
    nsp.to(`session:${session_id}`).emit(event, tagged)
    if (!nsp.adapter.rooms.get(`session:${session_id}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  const history = await buildCompressedHistory(
    session_id, profile,
    '',
    undefined,
    emit,
    sessionMap,
    { model: resolvedModel, provider: resolvedProvider },
    async (_messages, localMessageTokens) => {
      const fixedContextTokens = await ensureBridgeFixedContext({
        sessionId: session_id,
        profile,
        model: resolvedModel,
        provider: resolvedProvider,
        instructions: fullInstructions,
        state,
        bridge,
        refresh: true,
      })
      const contextTokens = fixedContextTokens == null
        ? localMessageTokens
        : fixedContextTokens + localMessageTokens
      bridgeLogger.info({
        sessionId: session_id,
        profile,
        model: resolvedModel,
        provider: resolvedProvider,
        fixedContextTokens,
        messageTokens: localMessageTokens,
        contextTokens,
      }, '[chat-run-socket] local context estimate')
      return contextTokens
    },
    currentInputTokens,
  )
  const bridgeHistory = history

  try {
    const bridgeInput = isContentBlockArray(input)
      ? await convertContentBlocksForAgent(input)
      : input
    const bridgeStorageInput = data.storage_message !== undefined
      ? data.storage_message
      : isContentBlockArray(input)
        ? inputStr
        : undefined
    logger.info('[chat-run-socket] starting CLI bridge run for session %s', session_id)
    bridgeLogger.info({
      sessionId: session_id,
      profile,
      inputChars: inputStr.length,
      historyMessages: history.length,
      hasInstructions: Boolean(fullInstructions),
      multimodalInput: isContentBlockArray(input),
    }, '[chat-run-socket] starting CLI bridge run')
    const started = await bridge.chat(
      session_id,
      bridgeInput as AgentBridgeMessage,
      bridgeHistory,
      fullInstructions,
      profile,
      {
        ...(bridgeStorageInput !== undefined ? { storage_message: bridgeStorageInput } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedProvider ? { provider: resolvedProvider } : {}),
        // Local patch (reasoning-effort): per-session reasoning effort override.
        ...(data.reasoning_effort ? { reasoning_effort: data.reasoning_effort } : {}),
      },
    )
    state.runId = started.run_id
    bridgeLogger.info({
      sessionId: session_id,
      runId: started.run_id,
      status: started.status,
    }, '[chat-run-socket] CLI bridge run started')
    pushState(sessionMap, session_id, 'run.started', {
      event: 'run.started',
      run_id: started.run_id,
      queue_length: state.queue.length || 0,
    })
    emit('run.started', {
      event: 'run.started',
      run_id: started.run_id,
      queue_length: state.queue.length || 0,
    })

    for await (const chunk of bridge.streamOutput(started.run_id)) {
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        session_id,
        runMarker,
        chunk,
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        fullInstructions,
        { model: resolvedModel, provider: resolvedProvider },
        currentInputTokens,
        shouldPersistUserMessage && displayRole === 'user',
        data.model_groups,
      )
      if (chunk.done) {
        void pollBridgeGeneratedTitleAfterRun(bridge, session_id, profile, emit)
        break
      }
    }
  } catch (err: any) {
    if (state.activeRunMarker !== runMarker) return
    if (!state.isWorking) return
    const queueLen = state.queue?.length ?? 0
    state.isWorking = false
    state.isAborting = false
    state.profile = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    state.bridgePendingToolCallMarkup = undefined
    flushBridgePendingToDb(state, session_id)
    updateSessionStats(session_id)
    const message = err instanceof Error ? err.message : String(err)
    const errUsage = await calcAndUpdateUsage(session_id, state, emit)
    const errContextTokens = await refreshFinalContextUsage({
      sessionId: session_id,
      profile,
      model: resolvedModel,
      provider: resolvedProvider,
      instructions: fullInstructions,
      state,
      usage: errUsage,
      emit,
      bridge,
    })
    updateUsage(session_id, {
      inputTokens: errUsage.inputTokens,
      outputTokens: errUsage.outputTokens,
      profile,
    })
    emit('run.failed', {
      event: 'run.failed',
      error: message,
      inputTokens: errUsage.inputTokens,
      outputTokens: errUsage.outputTokens,
      contextTokens: errContextTokens,
      queue_remaining: queueLen,
    })
    if (queueLen > 0) dequeueNextQueuedRun(socket, session_id)
  }
}

function latestAssistantText(state: SessionState): string {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]
    if (message.role === 'assistant') return message.content || ''
  }
  return ''
}

export async function resumeBridgeRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  args: {
    sessionId: string
    runId: string
    profile: string
    instructions: string
    model?: string | null
    provider?: string | null
  },
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
) {
  const { sessionId, runId, profile, instructions } = args
  let state = sessionMap.get(sessionId)
  if (!state) {
    state = { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(sessionId, state)
  }

  const runMarker = state.activeRunMarker || `cli_resume_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  state.isWorking = true
  state.isAborting = state.isAborting === true
  state.profile = profile
  state.source = 'cli'
  state.runId = runId
  state.activeRunMarker = runMarker
  state.bridgeOutput = state.bridgeOutput || latestAssistantText(state)
  state.bridgePendingAssistantContent = state.bridgePendingAssistantContent || ''
  state.bridgePendingReasoningContent = state.bridgePendingReasoningContent || ''
  state.bridgePendingToolCallMarkup = state.bridgePendingToolCallMarkup || ''
  state.bridgePendingTools = state.bridgePendingTools || []
  state.bridgeToolCounter = state.bridgeToolCounter || 0

  const emit = (event: string, payload: any) => {
    const tagged = { ...payload, session_id: sessionId }
    nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  let cursor = 0
  let eventCursor = 0
  try {
    const snapshot = await bridge.getResult(runId)
    const deltas = Array.isArray(snapshot.deltas) ? snapshot.deltas.map(String) : []
    const output = typeof snapshot.output === 'string' ? snapshot.output : deltas.join('')
    const persisted = state.bridgeOutput || ''
    const missingOutput = output && output.startsWith(persisted) ? output.slice(persisted.length) : ''
    if (missingOutput) {
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        sessionId,
        runMarker,
        {
          ok: true,
          run_id: runId,
          session_id: sessionId,
          status: 'running',
          delta: missingOutput,
          cursor: deltas.length,
          output,
          done: false,
          events: [],
          event_cursor: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
          error: null,
        },
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        instructions,
        { model: args.model, provider: args.provider },
      )
    }
    cursor = deltas.length
    eventCursor = Array.isArray(snapshot.events) ? snapshot.events.length : 0
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId,
      runId,
    }, '[chat-run-socket] failed to snapshot running bridge run before resume')
  }

  try {
    for (;;) {
      const chunk = await bridge.getOutput(runId, cursor, eventCursor)
      cursor = chunk.cursor
      eventCursor = chunk.event_cursor
      if (chunk.delta || chunk.done || (chunk.events && chunk.events.length > 0)) {
        await applyBridgeChunkAsync(
          nsp,
          socket,
          state,
          sessionId,
          runMarker,
          chunk,
          emit,
          profile,
          sessionMap,
          bridge,
          dequeueNextQueuedRun,
          instructions,
          { model: args.model, provider: args.provider },
        )
      }
      if (chunk.done) return
      await delay(100)
    }
  } catch (err) {
    if (state.activeRunMarker !== runMarker) return
    state.isWorking = false
    state.isAborting = false
    state.profile = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
      resumed: true,
    })
  }
}

async function refreshFinalContextUsage(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  instructions: string
  state: SessionState
  usage: { inputTokens: number; outputTokens: number }
  emit: (event: string, payload: any) => void
  bridge: AgentBridgeClient
}): Promise<number | undefined> {
  try {
    const dbHistory = await buildDbHistory(args.sessionId, { excludeLastUser: false })
    const finalHistory = await buildSnapshotAwareHistory(
      args.sessionId,
      args.profile,
      dbHistory,
      { model: args.model, provider: args.provider },
    )
    const finalMessageUsage = estimateUsageTokensFromMessages(finalHistory)
    const finalMessageTokens = finalMessageUsage.inputTokens + finalMessageUsage.outputTokens
    await ensureBridgeFixedContext({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      instructions: args.instructions,
      state: args.state,
      bridge: args.bridge,
    })
    const contextTokens = updateMessageContextTokenUsage(
      args.sessionId,
      args.state,
      args.emit,
      finalMessageTokens,
      args.usage,
    )
    bridgeLogger.info({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      messages: finalHistory.length,
      fixedContextTokens: args.state.bridgeContext?.fixedContextTokens,
      messageTokens: finalMessageTokens,
      contextTokens,
    }, '[chat-run-socket] final local context estimate')
    return contextTokens
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId: args.sessionId,
      profile: args.profile,
    }, '[chat-run-socket] final local context estimate failed')
    return args.state.contextTokens
  }
}

async function estimateSnapshotAwareMessageTokens(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  currentInputTokens?: number
  currentInputIncludedInDb?: boolean
}): Promise<{ messageTokens: number; messages: number }> {
  const dbHistory = await buildDbHistory(args.sessionId, { excludeLastUser: false })
  const snapshotHistory = await buildSnapshotAwareHistory(
    args.sessionId,
    args.profile,
    dbHistory,
    { model: args.model, provider: args.provider },
  )
  const usage = estimateUsageTokensFromMessages(snapshotHistory)
  const extraInputTokens = args.currentInputIncludedInDb
    ? 0
    : finiteToken(args.currentInputTokens) ?? 0
  return {
    messageTokens: usage.inputTokens + usage.outputTokens + extraInputTokens,
    messages: snapshotHistory.length,
  }
}

async function applyBridgeChunkAsync(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  state: SessionState,
  sessionId: string,
  runMarker: string,
  chunk: AgentBridgeOutput,
  emit: (event: string, payload: any) => void,
  profile: string,
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
  instructions: string,
  modelContext: { model?: string | null; provider?: string | null },
  currentInputTokens = 0,
  currentInputIncludedInDb = true,
  modelGroups?: RunModelGroup[],
): Promise<void> {
  if (state.activeRunMarker !== runMarker) {
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      runMarker,
      activeRunMarker: state.activeRunMarker,
    }, '[chat-run-socket] ignoring stale CLI bridge chunk')
    return
  }

  state.runId = chunk.run_id

  // When the bridge emits text as ordered `stream.delta` events (interleaved
  // with tool.started/tool.completed in the SAME events list), we process the
  // text here in true order and must NOT also process the aggregated
  // `chunk.delta` below (that would duplicate the text). This flag tracks it.
  let sawStreamDeltaEvent = false

  for (const ev of chunk.events || []) {
    const evType = ev.event as string | undefined
    if (evType === 'stream.delta') {
      sawStreamDeltaEvent = true
      processBridgeTextDelta(state, sessionId, runMarker, chunk.run_id, String((ev as any).delta || ''), emit)
      continue
    }
    if (evType === 'session.title.updated') {
      syncBridgeGeneratedTitle(sessionId, (ev as any).title, emit)
    } else if (evType === 'bridge.context.ready') {
      cacheBridgeContext(state, ev)
      const usage = await calcAndUpdateUsage(sessionId, state, emit)
      const snapshotAware = await estimateSnapshotAwareMessageTokens({
        sessionId,
        profile,
        model: modelContext.model,
        provider: modelContext.provider,
        currentInputTokens,
        currentInputIncludedInDb,
      })
      updateMessageContextTokenUsage(
        sessionId,
        state,
        emit,
        snapshotAware.messageTokens,
        usage,
      )
    } else if (evType === 'tool.started') {
      // Flush any partial tool-call-marker prefix that was held back by
      // the markup filter. Without this, deltas ending in `[`, `[C`,
      // `[Ca`, etc. are silently dropped because no follow-up delta will
      // come for this assistant message — the next chunk is the tool call
      // itself. See bridge-delta.ts for full rationale.
      flushPendingToolMarkupToAssistant(state, runMarker, chunk.run_id, emit)
      flushBridgePendingToDb(state, sessionId, runMarker)
      const toolName = (ev.tool_name as string) || ''
      const args = ev.args as Record<string, unknown> | undefined
      const tool = recordBridgeToolStarted(state, sessionId, runMarker, toolName, args, ev.tool_call_id)
      const payload = {
        event: 'tool.started',
        run_id: chunk.run_id,
        tool_call_id: tool.id,
        tool: toolName,
        name: toolName,
        arguments: tool.arguments,
        preview: ev.preview || summarizeToolArguments(tool.arguments),
      }
      pushState(sessionMap, sessionId, 'tool.started', payload)
      emit('tool.started', payload)
    } else if (evType === 'tool.completed') {
      const toolName = (ev.tool_name as string) || ''
      const completed = recordBridgeToolCompleted(state, sessionId, runMarker, toolName, ev)
      const payload = {
        event: 'tool.completed',
        run_id: chunk.run_id,
        tool_call_id: completed.id,
        tool: toolName,
        name: toolName,
        output: completed.output,
        duration: completed.duration ?? ev.duration,
        error: ev.is_error || undefined,
      }
      pushState(sessionMap, sessionId, 'tool.completed', payload)
      emit('tool.completed', payload)
    } else if (evType?.startsWith('subagent.')) {
      const payload = {
        event: evType,
        run_id: chunk.run_id,
        subagent_id: ev.subagent_id,
        parent_id: ev.parent_id,
        depth: ev.depth,
        task_index: ev.task_index,
        task_count: ev.task_count,
        goal: ev.goal,
        model: ev.model,
        toolsets: ev.toolsets,
        tool_count: ev.tool_count,
        tool: ev.tool_name,
        name: ev.tool_name,
        preview: ev.text || ev.summary || ev.tool_preview || '',
        text: ev.text || '',
        status: ev.status,
        summary: ev.summary,
        duration: ev.duration_seconds,
        duration_seconds: ev.duration_seconds,
        input_tokens: ev.input_tokens,
        output_tokens: ev.output_tokens,
        reasoning_tokens: ev.reasoning_tokens,
        api_calls: ev.api_calls,
        cost_usd: ev.cost_usd,
        files_read: ev.files_read,
        files_written: ev.files_written,
        output_tail: ev.output_tail,
      }
      pushState(sessionMap, sessionId, evType, payload)
      emit(evType, payload)
    } else if (evType === 'turn.boundary') {
      flushBridgePendingToDb(state, sessionId, runMarker)
    } else if (evType === 'reasoning.delta' || evType === 'thinking.delta') {
      const text = String(ev.text || '')
      if (text) {
        state.bridgePendingReasoningContent = (state.bridgePendingReasoningContent || '') + text
        const message = ensureOpenBridgeAssistantMessage(state, sessionId, runMarker)
        message.reasoning = (message.reasoning || '') + text
        message.reasoning_content = (message.reasoning_content || '') + text
      }
      emit(evType, {
        event: evType,
        run_id: chunk.run_id,
        text,
      })
    } else if (evType === 'reasoning.available') {
      emit('reasoning.available', {
        event: 'reasoning.available',
        run_id: chunk.run_id,
      })
    } else if (evType === 'approval.requested') {
      const payload = {
        event: 'approval.requested',
        run_id: chunk.run_id,
        approval_id: ev.approval_id,
        command: ev.command,
        description: ev.description,
        choices: ev.choices,
        allow_permanent: ev.allow_permanent,
        timeout_ms: ev.timeout_ms,
      }
      replaceState(sessionMap, sessionId, 'approval.requested', payload)
      emit('approval.requested', payload)
    } else if (evType === 'approval.resolved') {
      const payload = {
        event: 'approval.resolved',
        run_id: chunk.run_id,
        approval_id: ev.approval_id,
        choice: ev.choice,
      }
      replaceState(sessionMap, sessionId, 'approval.resolved', payload)
      emit('approval.resolved', payload)
    } else if (evType === 'clarify.requested') {
      const payload = {
        event: 'clarify.requested',
        run_id: chunk.run_id,
        clarify_id: ev.clarify_id,
        question: ev.question,
        choices: Array.isArray(ev.choices) ? ev.choices : null,
        timeout_ms: ev.timeout_ms,
      }
      replaceState(sessionMap, sessionId, 'clarify.requested', payload)
      emit('clarify.requested', payload)
    } else if (evType === 'clarify.resolved') {
      const payload = {
        event: 'clarify.resolved',
        run_id: chunk.run_id,
        clarify_id: ev.clarify_id,
      }
      replaceState(sessionMap, sessionId, 'clarify.resolved', payload)
      emit('clarify.resolved', payload)
    } else if (evType === 'bridge.compression.requested') {
      const bridgeHistory = await buildDbHistory(sessionId, { excludeLastUser: true })
      const bridgeUsage = estimateUsageTokensFromMessages(bridgeHistory)
      const messageOnlyTokens = bridgeUsage.inputTokens + bridgeUsage.outputTokens
      const runInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
        ? Math.floor(currentInputTokens)
        : 0
      const runMessageTokens = messageOnlyTokens + runInputTokens
      const tokenCount = contextTokensWithCachedOverhead(state, runMessageTokens)
      bridgeLogger.info({
        sessionId,
        profile,
        bridgeMessages: ev.message_count,
        dbMessages: bridgeHistory.length,
        messageOnlyTokens,
        currentInputTokens: runInputTokens,
        fixedContextTokens: state.bridgeContext?.fixedContextTokens,
        contextTokens: tokenCount,
        bridgeApproxTokens: ev.approx_tokens,
        source: 'local',
      }, '[chat-run-socket] bridge compression token estimate')
      const payload = {
        event: 'compression.started',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        message_count: bridgeHistory.length || ev.message_count,
        token_count: tokenCount,
        source: 'bridge',
      }
      replaceState(sessionMap, sessionId, 'compression.started', payload)
      emit('compression.started', payload)
      if (ev.request_id && Array.isArray(ev.messages)) {
        try {
          const compressed = await forceCompressBridgeHistory(
            sessionId,
            profile,
            ev.messages as ChatMessage[],
            tokenCount,
          )
          state.bridgeCompressionResults = state.bridgeCompressionResults || {}
          state.bridgeCompressionResults[String(ev.request_id)] = compressed
          await bridge.compressionRespond(String(ev.request_id), { messages: compressed.messages })
        } catch (err: any) {
          await bridge.compressionRespond(String(ev.request_id), {
            error: err?.message || String(err),
          }).catch(() => undefined)
        }
      }
    } else if (evType === 'bridge.compression.completed') {
      const compressionResult = ev.request_id
        ? state.bridgeCompressionResults?.[String(ev.request_id)]
        : undefined
      const messageAfterTokens = finiteToken(compressionResult?.afterTokens)
      const runInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
        ? Math.floor(currentInputTokens)
        : 0
      const messageAfterTokensWithInput = messageAfterTokens != null
        ? messageAfterTokens + runInputTokens
        : undefined
      const afterContextTokens = messageAfterTokensWithInput != null
        ? contextTokensWithCachedOverhead(state, messageAfterTokensWithInput)
        : undefined
      const payload = {
        event: 'compression.completed',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        compressed: compressionResult?.compressed ?? ev.compressed !== false,
        llmCompressed: compressionResult?.llmCompressed,
        totalMessages: compressionResult?.beforeMessages ?? ev.message_count,
        resultMessages: compressionResult?.resultMessages ?? ev.result_messages,
        beforeTokens: compressionResult?.beforeTokens ?? ev.approx_tokens,
        afterTokens: messageAfterTokensWithInput,
        contextTokens: afterContextTokens,
        summaryTokens: compressionResult?.summaryTokens,
        verbatimCount: compressionResult?.verbatimCount,
        compressedStartIndex: compressionResult?.compressedStartIndex,
        source: 'bridge',
      }
      if (ev.request_id && state.bridgeCompressionResults) {
        delete state.bridgeCompressionResults[String(ev.request_id)]
      }
      replaceState(sessionMap, sessionId, 'compression.completed', payload)
      emit('compression.completed', payload)
      const usage = await calcAndUpdateUsage(sessionId, state, emit)
      if (messageAfterTokensWithInput != null) {
        updateMessageContextTokenUsage(sessionId, state, emit, messageAfterTokensWithInput, usage)
      }
    } else if (evType === 'bridge.compression.failed') {
      const payload = {
        event: 'compression.completed',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        compressed: false,
        totalMessages: ev.message_count,
        resultMessages: ev.message_count,
        beforeTokens: ev.approx_tokens,
        error: ev.error,
        source: 'bridge',
      }
      if (ev.request_id && state.bridgeCompressionResults) {
        delete state.bridgeCompressionResults[String(ev.request_id)]
      }
      replaceState(sessionMap, sessionId, 'compression.completed', payload)
      emit('compression.completed', payload)
    } else if (evType === 'status') {
      const payload = {
        ...ev,
        event: 'agent.event',
        run_id: chunk.run_id,
      }
      replaceState(sessionMap, sessionId, 'agent.event', payload)
      emit('agent.event', payload)
    }
  }

  // Only process the aggregated chunk.delta when the bridge did NOT emit
  // ordered stream.delta events for this chunk. With ordered events, the text
  // was already handled above in true interleaved order; processing it again
  // here would duplicate it.
  if (chunk.delta && !sawStreamDeltaEvent) {
    const delta = filterBridgeToolCallMarkupDelta(state, chunk.delta)
    if (delta) {
      state.bridgeOutput = (state.bridgeOutput || '') + delta
      state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + delta
      const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
      if (last?.role === 'assistant' && last.finish_reason == null) {
        last.content += delta
        syncBridgeReasoningToMessage(last, state.bridgePendingReasoningContent)
      } else {
        state.messages.push({
          id: state.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: delta,
          reasoning: state.bridgePendingReasoningContent || null,
          reasoning_content: state.bridgePendingReasoningContent || null,
          timestamp: Math.floor(Date.now() / 1000),
        })
      }
      emit('message.delta', {
        event: 'message.delta',
        run_id: chunk.run_id,
        delta,
        output: state.bridgeOutput,
      })
    }
  }

  if (!chunk.done) return
  if (!state.isWorking) return
  if (state.isAborting) {
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      status: chunk.status,
    }, '[chat-run-socket][abort] completing CLI bridge abort after terminal chunk')
    await markAbortCompleted(
      nsp,
      socket,
      sessionId,
      chunk.run_id || runMarker,
      sessionMap,
      (queuedSocket, queuedSessionId, nextQueuedRun, fallbackProfile) => {
        const queuedState = sessionMap.get(queuedSessionId)
        if (queuedState) queuedState.queue.unshift(nextQueuedRun)
        dequeueNextQueuedRun(queuedSocket, queuedSessionId, fallbackProfile)
      },
    )
    return
  }

  // If the run terminated while we still had a partial tool-call-marker
  // prefix buffered, flush it to the user-visible stream now. Discarding
  // it (which the line below was doing implicitly) silently drops the
  // final characters of the assistant message.
  flushPendingToolMarkupToAssistant(state, runMarker, chunk.run_id, emit)
  flushBridgePendingToDb(state, sessionId)
  state.bridgePendingToolCallMarkup = undefined
  updateSessionStats(sessionId)
  await delay(BRIDGE_USAGE_FLUSH_DELAY_MS)
  const usage = await calcAndUpdateUsage(sessionId, state, emit)
  const contextTokens = await refreshFinalContextUsage({
    sessionId,
    profile,
    model: modelContext.model,
    provider: modelContext.provider,
    instructions,
    state,
    usage,
    emit,
    bridge,
  })
  updateUsage(sessionId, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    profile: state.profile,
  })
  const terminalError = bridgeTerminalError(chunk)
  const hadQueuedRunBeforeGoalEvaluation = state.queue.length > 0
  state.isWorking = hadQueuedRunBeforeGoalEvaluation
  state.isAborting = false
  state.profile = hadQueuedRunBeforeGoalEvaluation ? (state.queue[0]?.profile || profile) : undefined
  state.source = hadQueuedRunBeforeGoalEvaluation ? state.queue[0]?.source : state.source
  state.runId = undefined
  state.activeRunMarker = undefined
  state.events = []
  const eventName = terminalError ? 'run.failed' : 'run.completed'
  const payload = {
    event: eventName,
    run_id: chunk.run_id,
    output: chunk.output || state.bridgeOutput || '',
    result: chunk.result,
    error: terminalError || chunk.error,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    contextTokens,
    queue_remaining: state.queue.length,
  }
  emit(eventName, payload)

  if (!terminalError) {
    await maybeEnqueueGoalContinuation({
      nsp,
      socket,
      sessionId,
      state,
      bridge,
      profile,
      modelContext,
      modelGroups,
      instructions,
      finalResponse: bridgeFinalResponse(chunk, state),
    })
  }

  if (state.queue.length > 0 && !state.activeRunMarker) {
    const nextQueuedRun = state.queue[0]
    state.isWorking = true
    state.profile = nextQueuedRun.profile || profile
    state.source = nextQueuedRun.source
    dequeueNextQueuedRun(socket, sessionId)
  } else if (!state.activeRunMarker) {
    state.isWorking = false
    state.profile = undefined
  }
}

async function pollBridgeGeneratedTitleAfterRun(
  bridge: AgentBridgeClient,
  sessionId: string,
  profile: string,
  emit: (event: string, payload: any) => void,
) {
  if (!shouldPollBridgeGeneratedTitle(sessionId)) return
  const deadline = Date.now() + BRIDGE_TITLE_EVENT_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(BRIDGE_TITLE_EVENT_POLL_INTERVAL_MS)
    let title = ''
    try {
      const result = await bridge.getSessionTitle(sessionId, profile, { timeoutMs: 2000 })
      title = normalizeTitleText(result.title)
    } catch (err) {
      logger.debug(err, '[chat-run-socket] stopped polling bridge generated title for session %s', sessionId)
      return
    }
    if (title) {
      syncBridgeGeneratedTitle(sessionId, title, emit)
      return
    }
  }
}

function bridgeFinalResponse(chunk: AgentBridgeOutput, state: SessionState): string {
  const result = chunk.result && typeof chunk.result === 'object' && !Array.isArray(chunk.result)
    ? chunk.result as Record<string, unknown>
    : null
  const finalResponse = result && typeof result.final_response === 'string'
    ? result.final_response
    : ''
  return finalResponse || chunk.output || state.bridgeOutput || ''
}

function hasRealQueuedRun(state: SessionState): boolean {
  return state.queue.some(item => !item.goalContinuation)
}

async function maybeEnqueueGoalContinuation(args: {
  nsp: ReturnType<Server['of']>
  socket: Socket
  sessionId: string
  state: SessionState
  bridge: AgentBridgeClient
  profile: string
  modelContext: { model?: string | null; provider?: string | null }
  modelGroups?: RunModelGroup[]
  instructions: string
  finalResponse: string
}) {
  const finalResponse = args.finalResponse || ''
  if (!finalResponse.trim()) return
  if (hasRealQueuedRun(args.state)) return

  let decision
  try {
    decision = await args.bridge.goalEvaluate(args.sessionId, finalResponse, args.profile)
  } catch (err) {
    logger.warn(err, '[chat-run-socket] /goal evaluation failed for session %s', args.sessionId)
    return
  }

  if (isGoalJudgeUnavailable(decision.reason)) {
    emitGoalStatus(
      args.nsp,
      args.socket,
      args.sessionId,
      args.state,
      'judge_unavailable',
      'Goal judge is not configured; automatic goal continuation was skipped. The goal remains active, but Hermes cannot mark it done automatically.',
    )
    return
  }

  const message = typeof decision.message === 'string' ? decision.message.trim() : ''
  if (message) emitGoalStatus(args.nsp, args.socket, args.sessionId, args.state, decision.verdict || 'goal', message)

  if (!decision.should_continue) return
  if (hasRealQueuedRun(args.state)) return

  const prompt = typeof decision.continuation_prompt === 'string'
    ? decision.continuation_prompt.trim()
    : ''
  if (!prompt) return

  const next: QueuedRun = {
    queue_id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    input: prompt,
    displayInput: null,
    storageMessage: prompt,
    model: args.modelContext.model || undefined,
    provider: args.modelContext.provider || undefined,
    model_groups: args.modelGroups,
    instructions: undefined,
    profile: args.profile,
    source: 'cli',
    goalContinuation: true,
  }
  args.state.queue.push(next)
}

function isGoalJudgeUnavailable(reason?: string | null): boolean {
  const value = String(reason || '').toLowerCase()
  return value.includes('no auxiliary client configured') || value.includes('auxiliary client unavailable')
}

function emitGoalStatus(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  state: SessionState,
  action: string,
  message: string,
) {
  const now = Math.floor(Date.now() / 1000)
  const id = addMessage({
    session_id: sessionId,
    role: 'command',
    content: message,
    timestamp: now,
  })
  state.messages.push({
    id: id || `goal_${now}_${state.messages.length}`,
    session_id: sessionId,
    role: 'command',
    content: message,
    timestamp: now,
  })
  nsp.to(`session:${sessionId}`).emit('session.command', {
    event: 'session.command',
    session_id: sessionId,
    command: 'goal',
    ok: true,
    action,
    message,
    terminal: false,
  })
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit('session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: 'goal',
      ok: true,
      action,
      message,
      terminal: false,
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
