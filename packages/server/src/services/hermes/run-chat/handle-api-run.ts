/**
 * API Server run handler — handles runs that stream from upstream /v1/responses.
 */

import type { Server, Socket } from 'socket.io'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import {
  getSession,
  createSession,
  addMessage,
  updateSessionStats,
  getSessionDetailPaginated,
} from '../../../db/hermes/session-store'
import { updateUsage } from '../../../db/hermes/usage-store'
import { logger } from '../../logger'
import { contentBlocksToString, extractTextForPreview, isContentBlockArray, convertContentBlocks } from './content-blocks'
import { convertHistoryFormat } from './message-format'
import { readSseFrames } from './sse-utils'
import { extractResponseText } from './response-utils'
import { applyResponseStreamEvent, flushResponseRunToDb } from './response-stream'
import { buildCompressedHistory, buildDbHistory, buildSnapshotAwareHistory, getOrCreateSession } from './compression'
import { calcAndUpdateUsage, estimateUsageTokensFromMessages } from './usage'
import { handleMessage } from './message-format'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'
import { getCompressionSnapshot } from '../../../db/hermes/compression-snapshot'
import type { ContentBlock, SessionState, ChatRunSource } from './types'

export function resolveRunSource(source?: string, sessionId?: string): ChatRunSource {
  if (source === 'api_server' || source === 'cli' || source === 'coding_agent') return source
  if (sessionId) {
    const stored = getSession(sessionId)?.source
    if (stored === 'api_server' || stored === 'cli' || stored === 'coding_agent') return stored
  }
  return 'cli'
}

export async function loadSessionStateFromDb(sid: string, _sessionMap: Map<string, SessionState>): Promise<SessionState> {
  try {
    const actualDetail = getSessionDetailPaginated(sid)

    const messages = actualDetail?.messages ? handleMessage(actualDetail.messages, sid) : []

    let inputTokens: number
    let outputTokens: number
    let contextTokens: number | undefined
    const snapshot = getCompressionSnapshot(sid)
    if (snapshot && snapshot.lastMessageIndex >= 0 && snapshot.lastMessageIndex < messages.length) {
      const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
      const newUsage = estimateUsageTokensFromMessages(newMessages)
      inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
        newUsage.inputTokens
      outputTokens = newUsage.outputTokens
    } else {
      const usage = estimateUsageTokensFromMessages(messages)
      inputTokens = usage.inputTokens
      outputTokens = usage.outputTokens
    }
    try {
      const session = getSession(sid)
      const dbHistory = await buildDbHistory(sid, { excludeLastUser: false })
      const snapshotHistory = await buildSnapshotAwareHistory(
        sid,
        session?.profile || 'default',
        dbHistory,
        { model: session?.model, provider: session?.provider },
      )
      const contextUsage = estimateUsageTokensFromMessages(snapshotHistory)
      contextTokens = contextUsage.inputTokens + contextUsage.outputTokens
    } catch (err) {
      logger.warn(err, '[chat-run-socket] failed to calculate snapshot-aware context tokens for session %s', sid)
    }

    logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
    return {
      messages,
      messageTotal: actualDetail?.total || messages.length,
      messageLoadedCount: actualDetail?.messages.length || messages.length,
      messagePageLimit: actualDetail?.limit,
      hasMoreBefore: actualDetail?.hasMore || false,
      isWorking: false,
      events: [],
      inputTokens,
      outputTokens,
      contextTokens,
      queue: [],
    }
  } catch (err) {
    logger.warn(err, '[chat-run-socket] failed to load session %s from DB', sid)
    return { messages: [], isWorking: false, events: [], queue: [] }
  }
}

export async function handleApiRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: { input: string | ContentBlock[]; session_id?: string; model?: string; provider?: string; instructions?: string; workspace?: string | null; source?: string; queue_id?: string; peerExcludeSocketId?: string },
  profile: string,
  sessionMap: Map<string, SessionState>,
  skipUserMessage = false,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
) {
  const { input, session_id, model, provider, instructions } = data

  // Build full instructions with system prompt + workspace context
  let fullInstructions = instructions
    ? `${getSystemPrompt()}\n${instructions}`
    : getSystemPrompt()
  if (session_id) {
    const sessionRow = getSession(session_id)
    const workspace = sessionRow?.workspace || String(data.workspace || '').trim()
    if (workspace) {
      const workspaceCtx = `[Current working directory: ${workspace}]`
      fullInstructions = `\n${workspaceCtx}\n${fullInstructions}`
    }
  }

  const upstream = ''
  const apiKey = undefined

  const runMarker = session_id
    ? `resp_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    : undefined

  const now = Math.floor(Date.now() / 1000)
  if (session_id) {
    let state = sessionMap.get(session_id)
    if (!state) {
      state = getSession(session_id)
        ? await loadSessionStateFromDb(session_id, sessionMap)
        : { messages: [], isWorking: false, events: [], queue: [] }
      sessionMap.set(session_id, state)
    }
    state.isWorking = true
    state.events = []
    state.profile = profile
    state.source = 'api_server'
    state.activeRunMarker = runMarker

    let peerUserMessage: { id?: number; role: 'user'; content: string; timestamp: number } | null = null
    if (!skipUserMessage) {
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
        createSession({ id: session_id, profile, source: 'api_server', model, provider, title: preview, workspace: data.workspace || undefined })
      }

      const messageId = addMessage({
        session_id,
        role: 'user',
        content: inputStr,
        timestamp: now,
      })
      peerUserMessage = { id: data.queue_id ? undefined : messageId, role: 'user', content: inputStr, timestamp: now }
    } else {
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
        createSession({ id: session_id, profile, source: 'api_server', model, provider, title: preview, workspace: data.workspace || undefined })
      }
      const messageId = addMessage({
        session_id,
        role: 'user',
        content: inputStr,
        timestamp: now,
      })
      peerUserMessage = { id: data.queue_id ? undefined : messageId, role: 'user', content: inputStr, timestamp: now }
    }

    socket.join(`session:${session_id}`)
    if (peerUserMessage) {
      const target = data.peerExcludeSocketId
        ? nsp.to(`session:${session_id}`).except(data.peerExcludeSocketId)
        : socket.to(`session:${session_id}`)
      target.emit('run.peer_user_message', {
        event: 'run.peer_user_message',
        session_id,
        message: {
          ...peerUserMessage,
          id: data.queue_id || peerUserMessage.id,
        },
      })
    }
  }

  const emit = (event: string, payload: any) => {
    const tagged = session_id ? { ...payload, session_id } : payload
    if (session_id) {
      nsp.to(`session:${session_id}`).emit(event, tagged)
    } else if (socket.connected) {
      socket.emit(event, tagged)
    }
  }
  try {
    const body: Record<string, any> = { input }
    if (model) body.model = model
    body.instructions = fullInstructions
    if (session_id) {
      const sessionRow = getSession(session_id)
      const compressed = await buildCompressedHistory(session_id, profile, upstream, apiKey, emit, sessionMap, {
        model: sessionRow?.model || model,
        provider: sessionRow?.provider || provider,
      })
      if (compressed.length > 0) {
        body.conversation_history = compressed
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    if (isContentBlockArray(input)) {
      const parts = await convertContentBlocks(input)
      body.input = [{ role: 'user', content: parts }]
    }

    if (body.conversation_history && Array.isArray(body.conversation_history)) {
      body.conversation_history = convertHistoryFormat(body.conversation_history)
    }
    body.stream = true
    body.store = false

    const abortController = new AbortController()
    if (session_id) {
      const state = getOrCreateSession(sessionMap, session_id)
      state.isWorking = true
      state.runId = undefined
      state.abortController = abortController
    }

    const res = await fetch(`${upstream}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const queueLen = session_id ? sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await markApiCompleted(nsp, socket, session_id, sessionMap, { event: 'run.failed' })
      emit('run.failed', { event: 'run.failed', error: `Upstream ${res.status}: ${text}`, queue_remaining: queueLen })
      if (session_id && queueLen > 0) dequeueNextQueuedRun(socket, session_id)
      return
    }
    if (!res.body) {
      const queueLen = session_id ? sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await markApiCompleted(nsp, socket, session_id, sessionMap, { event: 'run.failed' })
      emit('run.failed', { event: 'run.failed', error: 'Upstream response stream missing', queue_remaining: queueLen })
      if (session_id && queueLen > 0) dequeueNextQueuedRun(socket, session_id)
      return
    }

    let responseId: string | undefined
    for await (const frame of readSseFrames(res.body)) {
      let parsed: any
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        continue
      }
      const upstreamEvent = parsed.type || frame.event || parsed.event
      logger.info('[chat-run-socket] upstream response event: %s', upstreamEvent)

      if (session_id) {
        const state = sessionMap.get(session_id)
        if (state) {
          const mapped = applyResponseStreamEvent(state, session_id, runMarker, upstreamEvent, parsed)
          if (mapped) {
            if (mapped.runId) {
              responseId = mapped.runId
              state.runId = responseId
            }
            emit(mapped.event, mapped.payload)
          }
        }
      }

      if (upstreamEvent === 'response.completed' || upstreamEvent === 'response.failed') {
        if (session_id && sessionMap.get(session_id)?.activeRunMarker !== runMarker) {
          logger.info({
            sessionId: session_id,
            runId: responseId,
            event: upstreamEvent,
          }, '[chat-run-socket] suppressing stale API terminal event')
          return
        }
        if (session_id && sessionMap.get(session_id)?.isAborting) {
          logger.info({
            sessionId: session_id,
            runId: responseId,
            event: upstreamEvent,
          }, '[chat-run-socket][abort] suppressing upstream terminal event during abort')
          return
        }
        const queueLen = session_id ? sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        const nextQueuedRun = session_id && queueLen > 0
          ? sessionMap.get(session_id)?.queue?.[0]
          : undefined
        if (session_id) await markApiCompleted(nsp, socket, session_id, sessionMap, {
          event: upstreamEvent === 'response.completed' ? 'run.completed' : 'run.failed',
          run_id: responseId,
          keepWorking: Boolean(nextQueuedRun),
          nextSource: nextQueuedRun?.source,
        })
        const finalOutput = parsed.response || parsed
        const finalText = extractResponseText(finalOutput)
        if (upstreamEvent === 'response.completed' && session_id) {
          const usage = finalOutput.usage || {}
          updateUsage(session_id, {
            inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
            outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
            cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
            reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
            model: finalOutput.model || '',
            profile: sessionMap.get(session_id)?.profile,
          })
        }
        const eventName = upstreamEvent === 'response.completed' ? 'run.completed' : 'run.failed'
        emit(eventName, {
          event: eventName,
          run_id: responseId || finalOutput.id,
          response_id: responseId || finalOutput.id,
          output: finalText,
          usage: finalOutput.usage,
          error: finalOutput.error || parsed.error,
          queue_remaining: queueLen,
        })
        if (session_id && queueLen > 0) dequeueNextQueuedRun(socket, session_id)
        return
      }
    }
    const queueLen = session_id ? sessionMap.get(session_id)?.queue?.length ?? 0 : 0
    if (session_id && sessionMap.get(session_id)?.activeRunMarker !== runMarker) {
      logger.info({
        sessionId: session_id,
        runId: responseId,
      }, '[chat-run-socket] suppressing stale API stream end')
      return
    }
    if (session_id) await markApiCompleted(nsp, socket, session_id, sessionMap, { event: 'run.failed', run_id: responseId })
    emit('run.failed', {
      event: 'run.failed',
      run_id: responseId,
      response_id: responseId,
      error: 'Response stream ended without a terminal event',
      queue_remaining: queueLen,
    })
    if (session_id && queueLen > 0) dequeueNextQueuedRun(socket, session_id)
  } catch (err: any) {
    const queueLen = session_id ? sessionMap.get(session_id)?.queue?.length ?? 0 : 0
    if (session_id) {
      const state = sessionMap.get(session_id)
      if (state?.activeRunMarker !== runMarker || err?.name === 'AbortError') {
        logger.info({
          sessionId: session_id,
          runMarker,
          error: err?.message || String(err),
        }, '[chat-run-socket] suppressing stale/aborted API stream error')
        return
      }
      void markApiCompleted(nsp, socket, session_id, sessionMap, { event: 'run.failed' }).then(() => {
        emit('run.failed', { event: 'run.failed', error: err.message, queue_remaining: queueLen })
        if (queueLen > 0) dequeueNextQueuedRun(socket, session_id)
      })
    } else {
      emit('run.failed', { event: 'run.failed', error: err.message })
    }
  }
}

async function markApiCompleted(
  nsp: ReturnType<Server['of']>,
  _socket: Socket,
  sessionId: string,
  sessionMap: Map<string, SessionState>,
  info: { event: string; run_id?: string; keepWorking?: boolean; nextSource?: ChatRunSource },
) {
  const state = sessionMap.get(sessionId)
  if (state) {
    if (state.isAborting) {
      logger.info({
        sessionId,
        runId: state.runId,
      }, '[chat-run-socket][abort] terminal upstream event observed; abort handler will finish cleanup')
      return
    }
    state.isWorking = Boolean(info.keepWorking)
    state.abortController = undefined
    state.runId = undefined
    state.events = []
    flushResponseRunToDb(state, sessionId)
    state.responseRun = undefined
    state.activeRunMarker = undefined
    if (info.keepWorking) {
      state.source = info.nextSource
    } else {
      state.profile = undefined
    }
    updateSessionStats(sessionId)
    const emit = (event: string, payload: any) => {
      nsp.to(`session:${sessionId}`).emit(event, { ...payload, session_id: sessionId })
    }
    await calcAndUpdateUsage(sessionId, state, emit)
  }
}
