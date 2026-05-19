/**
 * Bridge message management — flush pending content to DB,
 * track tool calls, manage assistant message lifecycle.
 */

import { addMessage } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import type { SessionMessage, SessionState } from './types'

export function flushBridgePendingToDb(state: SessionState, sessionId: string, runMarker?: string) {
  const content = state.bridgePendingAssistantContent || ''
  const reasoning = state.bridgePendingReasoningContent || ''
  if (!content.trim()) return
  if (runMarker) {
    const last = findOpenBridgeAssistantMessage(state, runMarker)
    if (last) syncBridgeReasoningToMessage(last, reasoning)
  }
  addMessage({
    session_id: sessionId,
    role: 'assistant',
    content,
    reasoning: reasoning || null,
    reasoning_content: reasoning || null,
    timestamp: Math.floor(Date.now() / 1000),
  })
  state.bridgePendingAssistantContent = ''
  state.bridgePendingReasoningContent = ''
  if (runMarker) {
    const last = findOpenBridgeAssistantMessage(state, runMarker)
    if (last && last.finish_reason == null) last.finish_reason = 'stop'
  }
}

export function findOpenBridgeAssistantMessage(state: SessionState, runMarker: string): SessionMessage | undefined {
  return [...state.messages]
    .reverse()
    .find(m => m.runMarker === runMarker && m.role === 'assistant' && m.finish_reason == null)
}

export function ensureOpenBridgeAssistantMessage(
  state: SessionState,
  sessionId: string,
  runMarker: string,
): SessionMessage {
  const existing = findOpenBridgeAssistantMessage(state, runMarker)
  if (existing) return existing
  const message: SessionMessage = {
    id: state.messages.length + 1,
    session_id: sessionId,
    runMarker,
    role: 'assistant',
    content: '',
    timestamp: Math.floor(Date.now() / 1000),
  }
  state.messages.push(message)
  return message
}

export function syncBridgeReasoningToMessage(message: SessionMessage, reasoning?: string) {
  if (!reasoning) return
  message.reasoning = reasoning
  message.reasoning_content = reasoning
}

export function recordBridgeToolStarted(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  rawToolCallId: unknown,
): { id: string; name: string; arguments: string } {
  const id = bridgeToolCallId(state, rawToolCallId, toolName)
  const argsString = args ? JSON.stringify(args) : '{}'
  const reasoning = state.bridgePendingReasoningContent || ''
  const toolCall = {
    id,
    type: 'function',
    function: {
      name: toolName,
      arguments: argsString,
    },
  }
  const timestamp = Math.floor(Date.now() / 1000)

  state.bridgePendingTools = state.bridgePendingTools || []
  state.bridgePendingTools.push({
    id,
    name: toolName,
    arguments: argsString,
    startedAt: Date.now(),
  })

  const openMessage = findOpenBridgeAssistantMessage(state, runMarker)
  if (openMessage && !openMessage.content && !openMessage.tool_calls?.length) {
    openMessage.tool_calls = [toolCall]
    openMessage.finish_reason = 'tool_calls'
    openMessage.reasoning = reasoning || openMessage.reasoning || null
    openMessage.reasoning_content = reasoning || openMessage.reasoning_content || null
    openMessage.timestamp = timestamp
  } else {
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      role: 'assistant',
      content: '',
      tool_calls: [toolCall],
      finish_reason: 'tool_calls',
      reasoning: reasoning || null,
      reasoning_content: reasoning || null,
      timestamp,
    })
  }
  addMessage({
    session_id: sessionId,
    role: 'assistant',
    content: '',
    tool_calls: [toolCall],
    finish_reason: 'tool_calls',
    reasoning: reasoning || null,
    reasoning_content: reasoning || null,
    timestamp,
  })
  state.bridgePendingReasoningContent = ''

  return { id, name: toolName, arguments: argsString }
}

export function recordBridgeToolCompleted(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  toolName: string,
  ev: Record<string, unknown>,
): { id: string; output: string; duration?: number } {
  state.bridgePendingTools = state.bridgePendingTools || []
  const rawId = ev.tool_call_id
  let idx = rawId
    ? state.bridgePendingTools.findIndex(tool => tool.id === String(rawId))
    : -1
  if (idx < 0 && toolName) {
    idx = state.bridgePendingTools.findIndex(tool => tool.name === toolName)
  }
  if (idx < 0) {
    idx = state.bridgePendingTools.length - 1
  }
  const pending = idx >= 0 ? state.bridgePendingTools.splice(idx, 1)[0] : undefined
  const id = pending?.id || bridgeToolCallId(state, rawId, toolName)
  const output = bridgeToolOutput(ev)
  const timestamp = Math.floor(Date.now() / 1000)
  logger.info(
    '[chat-run-socket][bridge] recording CLI tool result session=%s tool=%s tool_call_id=%s raw_tool_call_id=%s output_len=%d has_result=%s has_output=%s has_result_preview=%s has_preview=%s event_keys=%s',
    sessionId,
    toolName,
    id,
    String(rawId || ''),
    output.length,
    String(ev.result != null),
    String(ev.output != null),
    String(ev.result_preview != null),
    String(ev.preview != null),
    Object.keys(ev).join(','),
  )

  state.messages.push({
    id: state.messages.length + 1,
    session_id: sessionId,
    runMarker,
    role: 'tool',
    content: output,
    tool_call_id: id,
    tool_name: toolName || pending?.name || null,
    timestamp,
  })
  addMessage({
    session_id: sessionId,
    role: 'tool',
    content: output,
    tool_call_id: id,
    tool_name: toolName || pending?.name || null,
    timestamp,
  })

  const duration = pending?.startedAt
    ? Math.round((Date.now() - pending.startedAt) / 10) / 100
    : undefined

  return { id, output, duration }
}

export function bridgeToolCallId(state: SessionState, rawToolCallId: unknown, toolName: string): string {
  const raw = String(rawToolCallId || '').trim()
  if (raw) return raw
  state.bridgeToolCounter = (state.bridgeToolCounter || 0) + 1
  const safeName = (toolName || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `cli_${safeName}_${state.bridgeToolCounter}`
}

export function bridgeToolOutput(ev: Record<string, unknown>): string {
  const value = ev.result ?? ev.output ?? ev.result_preview ?? ev.preview ?? ''
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}
