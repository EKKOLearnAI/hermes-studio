/**
 * omp run handler — drives a chat run through a per-session `omp --mode rpc`
 * process and maps omp's AgentSessionEvent stream onto the existing /chat-run
 * Socket.IO events and SQLite persistence, the same contract handleBridgeRun
 * uses for the Hermes agent. omp owns its own system prompt, tools, and
 * in-process conversation context, so this handler does not inject Hermes
 * instructions or build compressed history — it forwards the user message and
 * relays the resulting stream.
 */

import type { Namespace, Socket } from 'socket.io'
import {
  addMessage,
  createSession,
  getSession,
  updateSession,
  updateSessionStats,
} from '../../../db/hermes/session-store'
import { updateUsage } from '../../../db/hermes/usage-store'
import { logger } from '../../logger'
import { contentBlocksToString, extractTextForPreview } from './content-blocks'
import { pushState } from './compression'
import { calcAndUpdateUsage } from './usage'
import { flushBridgePendingToDb, recordBridgeToolCompleted, recordBridgeToolStarted } from './bridge-message'
import { summarizeToolArguments } from './response-utils'
import { ensureHermesRunWorkspace } from './workspace'
import { ompSessionManager, OMP_EXIT_FRAME_TYPE, type OmpFrame } from './omp-session-manager'
import { isRecord, ompAssistantReasoning, ompAssistantText, ompToolResultImagePaths, ompToolResultText, ompUsageTokens } from './omp-transforms'
import type { ContentBlock, SessionState } from './types'

export interface OmpRunData {
  input: string | ContentBlock[]
  display_input?: string | ContentBlock[] | null
  display_role?: 'user' | 'command'
  storage_message?: string
  session_id?: string
  model?: string
  provider?: string
  workspace?: string | null
  source?: string
  queue_id?: string
  peerExcludeSocketId?: string
  onEvent?: (event: string, payload: Record<string, unknown>) => void
}

type EmitFn = (event: string, payload: Record<string, unknown>) => void
type DequeueFn = (socket: Socket, sessionId: string, fallbackProfile?: string) => void
type LoadStateFn = (sid: string, sessionMap: Map<string, SessionState>) => Promise<SessionState>

function makeOmpRunId(): string {
  return `omp_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function handleOmpRun(
  nsp: Namespace,
  socket: Socket,
  data: OmpRunData,
  profile: string,
  sessionMap: Map<string, SessionState>,
  loadSessionStateFromDbFn: LoadStateFn,
  dequeueNextQueuedRun: DequeueFn,
  skipUserMessage = false,
): Promise<void> {
  const session_id = data.session_id
  if (!session_id) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for omp source' })
    return
  }

  const sessionRow = getSession(session_id)
  const workspace = await ensureHermesRunWorkspace(profile, sessionRow?.workspace || data.workspace)
  if (sessionRow && !sessionRow.workspace && workspace) updateSession(session_id, { workspace })
  const model = data.model || sessionRow?.model || ''
  const provider = data.provider || sessionRow?.provider || ''
  if (sessionRow) {
    const updates: { model?: string; provider?: string } = {}
    if (model && sessionRow.model !== model) updates.model = model
    if (provider && sessionRow.provider !== provider) updates.provider = provider
    if (Object.keys(updates).length > 0) updateSession(session_id, updates)
  }

  const runMarker = makeOmpRunId()
  const runId = runMarker
  const now = Math.floor(Date.now() / 1000)

  let state = sessionMap.get(session_id)
  if (!state) {
    state = getSession(session_id)
      ? await loadSessionStateFromDbFn(session_id, sessionMap)
      : { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(session_id, state)
  }
  const runState = state

  runState.isWorking = true
  runState.isAborting = false
  runState.events = []
  runState.profile = profile
  runState.source = 'omp'
  runState.activeRunMarker = runMarker
  runState.runId = runId
  runState.bridgeOutput = ''
  runState.bridgePendingAssistantContent = ''
  runState.bridgePendingReasoningContent = ''
  runState.bridgeToolCounter = 0
  runState.bridgePendingTools = []

  // Persist the user message (mirrors handleBridgeRun's storage shape).
  const displayInput = data.display_input === undefined ? data.input : data.display_input
  const inputStr = displayInput == null ? '' : contentBlocksToString(displayInput)
  const actualInputStr = contentBlocksToString(data.input)
  const storageInputStr = data.storage_message !== undefined ? data.storage_message : inputStr
  const shouldStoreInputInsteadOfDisplay = data.storage_message !== undefined && data.storage_message !== inputStr
  const shouldPersistUserMessage = !skipUserMessage && displayInput !== null
  const displayRole = data.display_role === 'command' ? 'command' : 'user'
  const storageRole = shouldStoreInputInsteadOfDisplay ? 'user' : displayRole
  const displayRoleForStorage = shouldStoreInputInsteadOfDisplay ? displayRole : null
  const displayContentForStorage = shouldStoreInputInsteadOfDisplay ? inputStr : null
  let messageId: number | string | undefined

  const ensureSessionRow = () => {
    if (getSession(session_id)) return
    const previewSource = displayInput === null ? data.input : displayInput || data.input
    const preview = extractTextForPreview(previewSource).replace(/[\r\n]/g, ' ').substring(0, 100)
    createSession({ id: session_id, profile, source: 'omp', agent: 'omp', model, provider, title: preview, workspace })
  }

  if (shouldPersistUserMessage) {
    runState.messages.push({
      id: runState.messages.length + 1,
      session_id,
      runMarker,
      role: storageRole,
      content: storageInputStr,
      display_role: displayRoleForStorage,
      display_content: displayContentForStorage,
      timestamp: now,
    })
    ensureSessionRow()
    messageId = addMessage({
      session_id,
      role: storageRole,
      content: storageInputStr,
      display_role: displayRoleForStorage,
      display_content: displayContentForStorage,
      timestamp: now,
    })
  } else {
    ensureSessionRow()
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
        role: displayRoleForStorage || storageRole,
        content: displayContentForStorage || storageInputStr,
        timestamp: now,
      },
    })
  }

  const emit: EmitFn = (event, payload) => {
    const tagged = { ...payload, session_id }
    data.onEvent?.(event, tagged)
    nsp.to(`session:${session_id}`).emit(event, tagged)
    if (!data.onEvent && !nsp.adapter.rooms.get(`session:${session_id}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  try {
    await ompSessionManager.ensureSession(session_id, {
      cwd: workspace || undefined,
      model: model || undefined,
      provider: provider || undefined,
    })
  } catch (err) {
    runState.isWorking = false
    runState.runId = undefined
    runState.activeRunMarker = undefined
    runState.profile = undefined
    const error = err instanceof Error ? err.message : String(err)
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      error: `Failed to start omp: ${error}`,
      queue_remaining: runState.queue.length,
    })
    if (runState.queue.length > 0) dequeueNextQueuedRun(socket, session_id, profile)
    return
  }

  pushState(sessionMap, session_id, 'run.started', { event: 'run.started', run_id: runId, queue_length: runState.queue.length || 0 })
  emit('run.started', { event: 'run.started', run_id: runId, queue_length: runState.queue.length || 0 })

  let resolveDone!: () => void
  const done = new Promise<void>(resolve => {
    resolveDone = resolve
  })
  let finished = false
  let reasoningAnnounced = false
  let lastContextTokens = 0
  // Accumulate omp's reported per-call usage so the session_usage row (and the
  // usage dashboard) reflect real model tokens, not message-text estimates.
  let runUsageInput = 0
  let runUsageOutput = 0
  let runUsageCacheRead = 0
  let runUsageCacheWrite = 0

  const abortController = new AbortController()
  runState.abortController = abortController

  const flushAssistant = () => {
    flushBridgePendingToDb(runState, session_id, runMarker)
  }

  const finalize = async (error?: string) => {
    if (finished) return
    finished = true
    ompSessionManager.clearHandler(session_id)
    flushAssistant()
    updateSessionStats(session_id)
    const usage = await calcAndUpdateUsage(session_id, runState, emit)
    const contextTokens = lastContextTokens || usage.inputTokens + usage.outputTokens
    runState.contextTokens = contextTokens
    const recordedInput = runUsageInput || usage.inputTokens
    const recordedOutput = runUsageOutput || usage.outputTokens
    updateUsage(session_id, {
      inputTokens: recordedInput,
      outputTokens: recordedOutput,
      cacheReadTokens: runUsageCacheRead,
      cacheWriteTokens: runUsageCacheWrite,
      model,
      profile: runState.profile,
    })
    emit('usage.updated', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, contextTokens })

    const hadQueued = runState.queue.length > 0
    runState.isWorking = hadQueued
    runState.isAborting = false
    runState.profile = hadQueued ? runState.queue[0]?.profile || profile : undefined
    runState.source = hadQueued ? runState.queue[0]?.source : runState.source
    runState.runId = undefined
    runState.activeRunMarker = undefined
    runState.abortController = undefined
    runState.events = []

    const eventName = error ? 'run.failed' : 'run.completed'
    emit(eventName, {
      event: eventName,
      run_id: runId,
      output: runState.bridgeOutput || '',
      error: error || undefined,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      contextTokens,
      queue_remaining: runState.queue.length,
    })

    if (runState.queue.length > 0) dequeueNextQueuedRun(socket, session_id, profile)
    resolveDone()
  }

  abortController.signal.addEventListener('abort', () => {
    if (finished) return
    finished = true
    ompSessionManager.abort(session_id)
    ompSessionManager.clearHandler(session_id)
    resolveDone()
  }, { once: true })

  const handleFrame = (frame: OmpFrame) => {
    const type = typeof frame.type === 'string' ? frame.type : ''
    switch (type) {
      case 'message_update': {
        const ev = frame.assistantMessageEvent
        if (!isRecord(ev) || typeof ev.delta !== 'string') return
        if (ev.type === 'text_delta') {
          runState.bridgePendingAssistantContent = (runState.bridgePendingAssistantContent || '') + ev.delta
          runState.bridgeOutput = (runState.bridgeOutput || '') + ev.delta
          emit('message.delta', { run_id: runId, delta: ev.delta, output: runState.bridgeOutput })
        } else if (ev.type === 'thinking_delta') {
          runState.bridgePendingReasoningContent = (runState.bridgePendingReasoningContent || '') + ev.delta
          if (!reasoningAnnounced) {
            reasoningAnnounced = true
            emit('reasoning.available', { run_id: runId })
          }
          emit('reasoning.delta', { run_id: runId, text: ev.delta })
        }
        return
      }
      case 'message_end': {
        const msg = frame.message
        if (!isRecord(msg) || msg.role !== 'assistant') return
        const fullText = ompAssistantText(msg)
        const fullReasoning = ompAssistantReasoning(msg)
        if (fullText.length > (runState.bridgePendingAssistantContent || '').length) {
          runState.bridgePendingAssistantContent = fullText
        }
        if (fullReasoning.length > (runState.bridgePendingReasoningContent || '').length) {
          runState.bridgePendingReasoningContent = fullReasoning
        }
        const tokens = ompUsageTokens(msg.usage)
        if (tokens.totalTokens) lastContextTokens = tokens.totalTokens
        runUsageInput += tokens.inputTokens
        runUsageOutput += tokens.outputTokens
        if (isRecord(msg.usage)) {
          if (typeof msg.usage.cacheRead === 'number') runUsageCacheRead += msg.usage.cacheRead
          if (typeof msg.usage.cacheWrite === 'number') runUsageCacheWrite += msg.usage.cacheWrite
        }
        flushAssistant()
        reasoningAnnounced = false
        if (msg.stopReason === 'error') {
          void finalize(typeof msg.errorMessage === 'string' ? msg.errorMessage : 'omp run failed')
        }
        return
      }
      case 'tool_execution_start': {
        flushAssistant()
        const toolName = typeof frame.toolName === 'string' ? frame.toolName : 'tool'
        const args = isRecord(frame.args) ? frame.args : undefined
        const tool = recordBridgeToolStarted(runState, session_id, runMarker, toolName, args, frame.toolCallId)
        emit('tool.started', {
          run_id: runId,
          tool_call_id: tool.id,
          tool: tool.name,
          name: tool.name,
          arguments: tool.arguments,
          preview: summarizeToolArguments(tool.arguments),
        })
        return
      }
      case 'tool_execution_end': {
        const toolName = typeof frame.toolName === 'string' ? frame.toolName : 'tool'
        const output = ompToolResultText(frame.result)
        const completed = recordBridgeToolCompleted(runState, session_id, runMarker, toolName, {
          tool_call_id: frame.toolCallId,
          result: output,
        })
        emit('tool.completed', {
          run_id: runId,
          tool_call_id: completed.id,
          tool: toolName,
          name: toolName,
          output: completed.output,
          duration: completed.duration,
          error: frame.isError === true ? output : undefined,
        })
        // Surface tool-produced image files (e.g. generate_image) as markdown
        // images in the assistant stream. MarkdownRenderer rewrites the local
        // path to the download endpoint, so the picture renders inline live and
        // on reload without bloating the DB with base64.
        for (const imagePath of ompToolResultImagePaths(frame.result)) {
          const markdown = `\n\n![generated image](${imagePath})\n`
          runState.bridgePendingAssistantContent = (runState.bridgePendingAssistantContent || '') + markdown
          runState.bridgeOutput = (runState.bridgeOutput || '') + markdown
          emit('message.delta', { run_id: runId, delta: markdown, output: runState.bridgeOutput })
        }
        return
      }
      case 'notice': {
        if (frame.level === 'error' && typeof frame.message === 'string') void finalize(frame.message)
        return
      }
      case 'response': {
        if (frame.command === 'prompt' && frame.success === false) {
          void finalize(typeof frame.error === 'string' ? frame.error : 'omp rejected the prompt')
        }
        return
      }
      case 'prompt_result': {
        if (frame.agentInvoked === false) void finalize()
        return
      }
      case 'agent_end': {
        void finalize()
        return
      }
      case OMP_EXIT_FRAME_TYPE: {
        void finalize(typeof frame.reason === 'string' ? frame.reason : 'omp process exited')
        return
      }
    }
  }

  ompSessionManager.setHandler(session_id, frame => {
    try {
      handleFrame(frame)
    } catch (err) {
      logger.warn(err, '[omp-run] error handling frame for session %s', session_id)
    }
  })

  if (!ompSessionManager.prompt(session_id, actualInputStr, runId)) {
    await finalize('omp process is not available')
    await done
    return
  }

  await done
}
