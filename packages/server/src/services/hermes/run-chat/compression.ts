/**
 * Context compression — build conversation history from DB,
 * apply snapshot-aware compression and LLM summarization.
 */

import {
  getSessionDetail,
} from '../../../db/hermes/session-store'
import { getCompressionSnapshot } from '../../../db/hermes/compression-snapshot'
import { ChatContextCompressor, SUMMARY_PREFIX } from '../../../lib/context-compressor'
import { getModelContextLength } from '../model-context'
import { logger } from '../../logger'
import { bridgeLogger } from '../../logger'
import { calcAndUpdateUsage, estimateUsageTokensFromMessages } from './usage'
import { isAssistantMessageSendable } from './message-format'
import type { ChatMessage } from '../../../lib/context-compressor'
import type { SessionState, BridgeCompressionResult } from './types'

const compressor = new ChatContextCompressor()

/**
 * Load conversation history from DB with full message structure (user/assistant/tool).
 */
export async function buildDbHistory(
  sessionId: string,
  options: { excludeLastUser?: boolean } = {},
): Promise<ChatMessage[]> {
  const detail = getSessionDetail(sessionId)
  if (!detail?.messages?.length) return []

  const validMessages = detail.messages.filter(m =>
    (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined,
  )

  const sourceMessages = options.excludeLastUser
    ? (() => {
      const lastUserMsgIndex = [...validMessages].reverse().findIndex(m => m.role === 'user')
      return lastUserMsgIndex >= 0
        ? validMessages.slice(0, validMessages.length - lastUserMsgIndex - 1)
        : validMessages
    })()
    : validMessages

  return sourceMessages.map((m, idx, arr) => {
    const msg: any = { role: m.role, content: m.content || '' }
    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
    if (m.tool_calls?.length) {
      const cleanedToolCalls = m.tool_calls
        .filter((tc: any) => tc.id && tc.id.length > 0)
        .map((tc: any) => ({ id: tc.id, type: tc.type, function: tc.function }))
      if (cleanedToolCalls.length > 0) msg.tool_calls = cleanedToolCalls
    }
    if (m.role === 'tool') {
      let callId = m.tool_call_id
      if (!callId || callId.length === 0) {
        const prevMsg = arr[idx - 1]
        if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
          const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
          if (tc?.id) callId = tc.id
        }
      }
      if (!callId || callId.length === 0) return null
      msg.tool_call_id = callId
    }
    if (m.tool_name) msg.name = m.tool_name
    if (m.role === 'assistant' && !isAssistantMessageSendable(msg)) {
      logger.warn('[chat-run-socket] skipped empty assistant message while building history for session %s', sessionId)
      return null
    }
    return msg
  }).filter((m): m is ChatMessage => m !== null)
}

export function estimateSnapshotAwareHistoryUsage(
  sessionId: string,
  history: ChatMessage[],
): { messageCount: number; tokenCount: number } {
  const snapshot = getCompressionSnapshot(sessionId)
  const messages = snapshot
    ? [
        { role: 'user', content: SUMMARY_PREFIX + snapshot.summary },
        ...history.slice(snapshot.lastMessageIndex + 1),
      ]
    : history
  const usage = estimateUsageTokensFromMessages(messages)
  return {
    messageCount: messages.length,
    tokenCount: usage.inputTokens + usage.outputTokens,
  }
}

export async function buildCompressedHistory(
  sessionId: string,
  profile: string,
  upstream: string,
  apiKey: string | undefined,
  emit: (event: string, payload: any) => void,
  sessionMap: Map<string, SessionState>,
): Promise<ChatMessage[]> {
  try {
    let history = await buildDbHistory(sessionId, { excludeLastUser: true })
    if (history.length === 0) return []

    const contextLength = getModelContextLength(profile)
    const triggerTokens = Math.floor(contextLength / 2)
    const cState = getOrCreateSession(sessionMap, sessionId)
    const assembledTokens = await calcAndUpdateUsage(sessionId, cState, emit)
    const totalTokens = assembledTokens.inputTokens + assembledTokens.outputTokens
    const snapshot = getCompressionSnapshot(sessionId)

    if (snapshot) {
      const newMessages = history.slice(snapshot.lastMessageIndex + 1)
      logger.info('[context-compress] session=%s: snapshot at %d, %d new messages, assembled ~%d tokens (threshold %d)',
        sessionId, snapshot.lastMessageIndex, newMessages.length, totalTokens, triggerTokens)
      if (totalTokens <= triggerTokens && newMessages.length <= 150) {
        history = [
          { role: 'user', content: SUMMARY_PREFIX + '\n\n' + snapshot.summary },
          ...newMessages,
        ] as ChatMessage[]
      } else {
        history = await compressHistory(history, newMessages, sessionId, upstream, apiKey, cState, totalTokens, emit, sessionMap)
      }
    } else if (history.length > 4) {
      if (totalTokens <= triggerTokens && history.length <= 150) {
        logger.info('[context-compress] session=%s: %d messages, ~%d tokens — under threshold, skip', sessionId, history.length, totalTokens)
      } else {
        history = await compressHistory(history, null, sessionId, upstream, apiKey, cState, totalTokens, emit, sessionMap)
      }
    }

    return history
  } catch (err) {
    logger.warn(err, '[chat-run-socket] failed to build compressed history for session %s', sessionId)
    return []
  }
}

export async function compressHistory(
  history: ChatMessage[],
  newMessagesOnly: ChatMessage[] | null,
  sessionId: string,
  upstream: string,
  apiKey: string | undefined,
  cState: SessionState,
  totalTokens: number,
  emit: (event: string, payload: any) => void,
  sessionMap: Map<string, SessionState>,
): Promise<ChatMessage[]> {
  const msgCount = newMessagesOnly ? newMessagesOnly.length : history.length
  pushState(sessionMap, sessionId, 'compression.started', {
    event: 'compression.started', message_count: msgCount, token_count: totalTokens,
  })
  emit('compression.started', {
    event: 'compression.started', message_count: msgCount, token_count: totalTokens,
  })

  try {
    const result = await compressor.compress(history, upstream, apiKey, sessionId)
    const afterTokens = await calcAndUpdateUsage(sessionId, cState, emit)
    const compressedMeta = {
      event: 'compression.completed' as const,
      compressed: result.meta.compressed,
      llmCompressed: result.meta.llmCompressed,
      totalMessages: result.meta.totalMessages,
      resultMessages: result.messages.length,
      beforeTokens: totalTokens,
      afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
      summaryTokens: result.meta.summaryTokenEstimate,
      verbatimCount: result.meta.verbatimCount,
      compressedStartIndex: result.meta.compressedStartIndex,
    }
    replaceState(sessionMap, sessionId, 'compression.completed', compressedMeta)
    logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)',
      sessionId, result.messages.length, afterTokens.inputTokens + afterTokens.outputTokens, totalTokens)
    emit('compression.completed', compressedMeta)

    const compressed = result.messages.map(m => {
      const msg: any = { role: m.role, content: m.content, tool_call_id: m.tool_call_id, name: m.name }
      if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
      if (m.tool_calls?.length) {
        const cleanedToolCalls = m.tool_calls
          .filter((tc: any) => tc.id && tc.id.length > 0)
          .map((tc: any) => ({ id: tc.id, type: tc.type, function: tc.function }))
        if (cleanedToolCalls.length > 0) msg.tool_calls = cleanedToolCalls
      }
      return msg
    })
    await calcAndUpdateUsage(sessionId, cState, emit)
    return compressed
  } catch (err: any) {
    const failedMeta = {
      event: 'compression.completed' as const,
      compressed: false,
      totalMessages: msgCount,
      resultMessages: msgCount,
      beforeTokens: totalTokens,
      afterTokens: totalTokens,
      summaryTokens: 0,
      verbatimCount: msgCount,
      compressedStartIndex: -1,
      error: err.message,
    }
    replaceState(sessionMap, sessionId, 'compression.completed', failedMeta)
    logger.warn(err, '[chat-run-socket] compression failed for session %s, using assembled context', sessionId)
    emit('compression.completed', failedMeta)
    return history
  }
}

export async function forceCompressBridgeHistory(
  sessionId: string,
  profile: string,
  _messages: ChatMessage[],
  getUpstream: (profile: string) => string,
  getApiKey: (profile: string) => string | undefined,
): Promise<BridgeCompressionResult> {
  const history = await buildDbHistory(sessionId, { excludeLastUser: true })

  if (history.length === 0) {
    return {
      messages: [],
      beforeMessages: 0,
      resultMessages: 0,
      beforeTokens: 0,
      afterTokens: 0,
      compressed: false,
      llmCompressed: false,
      summaryTokens: 0,
      verbatimCount: 0,
      compressedStartIndex: -1,
    }
  }

  const upstream = getUpstream(profile).replace(/\/$/, '')
  const apiKey = getApiKey(profile) || undefined
  const beforeUsage = estimateSnapshotAwareHistoryUsage(sessionId, history)
  const totalTokens = beforeUsage.tokenCount
  bridgeLogger.info({
    sessionId,
    profile,
    historyMessages: history.length,
    snapshotAwareMessages: beforeUsage.messageCount,
    bridgeProvidedMessages: Array.isArray(_messages) ? _messages.length : 0,
    tokenEstimate: totalTokens,
    snapshotAware: true,
  }, '[chat-run-socket] bridge forced compression started')

  const result = await compressor.compress(history, upstream, apiKey, sessionId, profile)
  const compressedMessages = result.messages.map(m => {
    const msg: any = { role: m.role, content: m.content }
    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
    if (m.tool_calls?.length) {
      const cleanedToolCalls = m.tool_calls
        .filter((tc: any) => tc.id && tc.id.length > 0)
        .map((tc: any) => ({ id: tc.id, type: tc.type, function: tc.function }))
      if (cleanedToolCalls.length > 0) msg.tool_calls = cleanedToolCalls
    }
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
    if (m.name) msg.name = m.name
    return msg
  })
  const afterUsage = estimateUsageTokensFromMessages(compressedMessages)
  const afterTokens = afterUsage.inputTokens + afterUsage.outputTokens
  bridgeLogger.info({
    sessionId,
    profile,
    beforeMessages: history.length,
    resultMessages: result.messages.length,
    beforeTokens: totalTokens,
    afterTokens,
    compressed: result.meta.compressed,
    llmCompressed: result.meta.llmCompressed,
    verbatimCount: result.meta.verbatimCount,
    compressedStartIndex: result.meta.compressedStartIndex,
    compressedHistory: result.messages.map((m) => ({
      role: m.role,
      content: m.content,
      reasoning_content: m.reasoning_content,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
      name: m.name,
    })),
  }, '[chat-run-socket] bridge forced compression completed')

  return {
    messages: compressedMessages,
    beforeMessages: history.length,
    resultMessages: compressedMessages.length,
    beforeTokens: totalTokens,
    afterTokens,
    compressed: result.meta.compressed,
    llmCompressed: result.meta.llmCompressed,
    summaryTokens: result.meta.summaryTokenEstimate,
    verbatimCount: result.meta.verbatimCount,
    compressedStartIndex: result.meta.compressedStartIndex,
  }
}

// --- Shared state helpers (used by compression) ---

export function getOrCreateSession(sessionMap: Map<string, SessionState>, sessionId: string): SessionState {
  let state = sessionMap.get(sessionId)
  if (!state) {
    state = { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(sessionId, state)
  }
  return state
}

export function pushState(sessionMap: Map<string, SessionState>, sessionId: string, event: string, data: any) {
  const state = getOrCreateSession(sessionMap, sessionId)
  state.events.push({ event, data })
}

export function replaceState(sessionMap: Map<string, SessionState>, sessionId: string, event: string, data: any) {
  const state = sessionMap.get(sessionId)
  if (state) {
    const idx = state.events.findIndex(s => s.event === event)
    if (idx >= 0) {
      state.events[idx] = { event, data }
      return
    }
  }
  pushState(sessionMap, sessionId, event, data)
}
