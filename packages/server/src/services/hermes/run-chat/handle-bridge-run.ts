/**
 * CLI Bridge run handler — handles runs that use the agent bridge
 * to communicate with Hermes CLI agent.
 */

import type { Server, Socket } from 'socket.io'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession, createSession, addMessage, updateSessionStats } from '../../../db/hermes/session-store'
import { updateUsage } from '../../../db/hermes/usage-store'
import { logger, bridgeLogger } from '../../logger'
import { AgentBridgeClient, type AgentBridgeMessage, type AgentBridgeOutput } from '../agent-bridge'
import { contentBlocksToString, convertContentBlocksForAgent, extractTextForPreview, isContentBlockArray } from './content-blocks'
import { buildCompressedHistory } from './compression'
import { pushState, replaceState } from './compression'
import { calcAndUpdateUsage, estimateUsageTokensFromMessages } from './usage'
import {
  flushBridgePendingToDb,
  ensureOpenBridgeAssistantMessage,
  syncBridgeReasoningToMessage,
  recordBridgeToolStarted,
  recordBridgeToolCompleted,
} from './bridge-message'
import { forceCompressBridgeHistory } from './compression'
import { summarizeToolArguments } from './response-utils'
import { buildDbHistory } from './compression'
import { convertHistoryFormat } from './message-format'
import type { ContentBlock, SessionState } from './types'
import type { ChatMessage } from '../../../lib/context-compressor'

const BRIDGE_USAGE_FLUSH_DELAY_MS = 200

export async function handleBridgeRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: { input: string | ContentBlock[]; session_id?: string; model?: string; instructions?: string; source?: string },
  profile: string,
  sessionMap: Map<string, SessionState>,
  gatewayManager: any,
  bridge: AgentBridgeClient,
  _skipUserMessage = false,
  loadSessionStateFromDbFn: (sid: string, sessionMap: Map<string, SessionState>) => Promise<SessionState>,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
) {
  const { input, session_id, model, instructions } = data
  if (!session_id) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for cli source' })
    return
  }

  let fullInstructions = instructions
    ? `${getSystemPrompt()}\n${instructions}`
    : getSystemPrompt()
  const sessionRow = getSession(session_id)
  if (sessionRow?.workspace) {
    const workspaceCtx = `[Current working directory: ${sessionRow.workspace}]`
    fullInstructions = `\n${workspaceCtx}\n${fullInstructions}`
  }

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
  state.profile = profile
  state.source = 'cli'
  state.activeRunMarker = runMarker
  state.runId = undefined
  state.abortController = undefined
  state.bridgeOutput = ''
  state.bridgePendingAssistantContent = ''
  state.bridgePendingReasoningContent = ''
  state.bridgeToolCounter = 0
  state.bridgePendingTools = []
  state.responseRun = undefined

  const inputStr = contentBlocksToString(input)
  state.messages.push({
    id: state.messages.length + 1,
    session_id,
    runMarker,
    role: 'user',
    content: inputStr,
    timestamp: now,
  })

  if (!getSession(session_id)) {
    const previewText = extractTextForPreview(input)
    const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
    createSession({ id: session_id, profile, source: 'cli', model, title: preview })
  }
  addMessage({
    session_id,
    role: 'user',
    content: inputStr,
    timestamp: now,
  })

  socket.join(`session:${session_id}`)
  const emit = (event: string, payload: any) => {
    const tagged = { ...payload, session_id }
    nsp.to(`session:${session_id}`).emit(event, tagged)
    if (!nsp.adapter.rooms.get(`session:${session_id}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  const history = await buildCompressedHistory(
    session_id, profile,
    gatewayManager.getUpstream(profile).replace(/\/$/, ''),
    gatewayManager.getApiKey(profile) || undefined,
    emit,
    sessionMap,
  )
  const bridgeHistory = history.length > 0 ? convertHistoryFormat(history) : history

  try {
    const bridgeInput = isContentBlockArray(input)
      ? await convertContentBlocksForAgent(input)
      : input
    const bridgeStorageInput = isContentBlockArray(input)
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
      bridgeStorageInput !== undefined ? { storage_message: bridgeStorageInput } : {},
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
      await applyBridgeChunkAsync(nsp, socket, state, session_id, runMarker, chunk, emit, profile, sessionMap, gatewayManager, bridge, dequeueNextQueuedRun)
      if (chunk.done) break
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
    flushBridgePendingToDb(state, session_id)
    updateSessionStats(session_id)
    const message = err instanceof Error ? err.message : String(err)
    emit('run.failed', { event: 'run.failed', error: message, queue_remaining: queueLen })
    const errUsage = await calcAndUpdateUsage(session_id, state, emit)
    updateUsage(session_id, {
      inputTokens: errUsage.inputTokens,
      outputTokens: errUsage.outputTokens,
      profile: state.profile,
    })
    if (queueLen > 0) dequeueNextQueuedRun(socket, session_id)
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
  gatewayManager: any,
  bridge: AgentBridgeClient,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
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

  for (const ev of chunk.events || []) {
    const evType = ev.event as string | undefined
    if (evType === 'tool.started') {
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
    } else if (evType === 'bridge.compression.requested') {
      const bridgeHistory = await buildDbHistory(sessionId, { excludeLastUser: true })
      const bridgeUsage = estimateUsageTokensFromMessages(bridgeHistory)
      const tokenCount = bridgeHistory.length > 0
        ? bridgeUsage.inputTokens + bridgeUsage.outputTokens
        : ev.approx_tokens
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
            (p: string) => gatewayManager.getUpstream(p),
            (p: string) => gatewayManager.getApiKey(p),
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
      const payload = {
        event: 'compression.completed',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        compressed: compressionResult?.compressed ?? ev.compressed !== false,
        llmCompressed: compressionResult?.llmCompressed,
        totalMessages: compressionResult?.beforeMessages ?? ev.message_count,
        resultMessages: compressionResult?.resultMessages ?? ev.result_messages,
        beforeTokens: compressionResult?.beforeTokens ?? ev.approx_tokens,
        afterTokens: compressionResult?.afterTokens,
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
      await calcAndUpdateUsage(sessionId, state, emit)
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
      emit('agent.event', {
        event: 'agent.event',
        run_id: chunk.run_id,
        ...ev,
      })
    }
  }

  if (chunk.delta) {
    state.bridgeOutput = (state.bridgeOutput || '') + chunk.delta
    state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + chunk.delta
    const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
    if (last?.role === 'assistant' && last.finish_reason == null) {
      last.content += chunk.delta
      syncBridgeReasoningToMessage(last, state.bridgePendingReasoningContent)
    } else {
      state.messages.push({
        id: state.messages.length + 1,
        session_id: sessionId,
        runMarker,
        role: 'assistant',
        content: chunk.delta,
        reasoning: state.bridgePendingReasoningContent || null,
        reasoning_content: state.bridgePendingReasoningContent || null,
        timestamp: Math.floor(Date.now() / 1000),
      })
    }
    emit('message.delta', {
      event: 'message.delta',
      run_id: chunk.run_id,
      delta: chunk.delta,
      output: state.bridgeOutput,
    })
  }

  if (!chunk.done) return
  if (!state.isWorking) return
  if (state.isAborting) {
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      status: chunk.status,
    }, '[chat-run-socket][abort] suppressing CLI bridge terminal chunk during abort')
    return
  }

  flushBridgePendingToDb(state, sessionId)
  updateSessionStats(sessionId)
  await delay(BRIDGE_USAGE_FLUSH_DELAY_MS)
  const usage = await calcAndUpdateUsage(sessionId, state, emit)
  updateUsage(sessionId, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    profile: state.profile,
  })
  const nextQueuedRun = state.queue.length > 0 ? state.queue[0] : undefined
  state.isWorking = Boolean(nextQueuedRun)
  state.isAborting = false
  if (nextQueuedRun) {
    state.profile = nextQueuedRun.profile || profile
    state.source = nextQueuedRun.source
  } else {
    state.profile = undefined
  }
  state.runId = undefined
  state.activeRunMarker = undefined
  state.events = []
  const eventName = chunk.status === 'error' ? 'run.failed' : 'run.completed'
  const payload = {
    event: eventName,
    run_id: chunk.run_id,
    output: chunk.output || state.bridgeOutput || '',
    result: chunk.result,
    error: chunk.error,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    queue_remaining: state.queue.length,
  }
  emit(eventName, payload)
  if (state.queue.length > 0) {
    dequeueNextQueuedRun(socket, sessionId)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
