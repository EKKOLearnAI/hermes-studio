/**
 * Response stream event handling — maps upstream /v1/responses events
 * to client-facing events and updates in-memory session state.
 */

import { addMessage } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import { summarizeToolArguments, responseFunctionCallToToolCall } from './response-utils'
import type { SessionState, ResponseRunState } from './types'

export function applyResponseStreamEvent(
  state: SessionState,
  sessionId: string,
  runMarker: string | undefined,
  eventType: string,
  parsed: any,
): { event: string; payload: any; runId?: string } | null {
  const run = getResponseRunState(state, runMarker)
  const now = () => Math.floor(Date.now() / 1000)

  if (eventType === 'response.created') {
    const response = parsed.response || parsed
    run.responseId = response.id || run.responseId
    return {
      event: 'run.started',
      runId: run.responseId,
      payload: {
        event: 'run.started',
        run_id: run.responseId,
        response_id: run.responseId,
        status: response.status || 'in_progress',
        queue_length: state.queue.length || 0,
      },
    }
  }

  if (eventType === 'response.output_text.delta') {
    const deltaText = parsed.delta || parsed.text || ''
    if (!deltaText) return null

    const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
    if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
      last.content += deltaText
    } else {
      state.messages.push({
        id: state.messages.length + 1,
        session_id: sessionId,
        runMarker,
        role: 'assistant',
        content: deltaText,
        timestamp: now(),
      })
    }
    return {
      event: 'message.delta',
      payload: {
        event: 'message.delta',
        run_id: run.responseId,
        response_id: run.responseId,
        delta: deltaText,
      },
    }
  }

  if (eventType === 'response.output_text.done') {
    const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
    if (last?.role === 'assistant' && last.finish_reason == null) {
      last.finish_reason = 'stop'
    }
    return null
  }

  if (eventType === 'response.output_item.added') {
    const item = parsed.item || parsed.output_item || parsed
    if (item.type !== 'function_call') return null
    const callId = item.call_id || item.id
    if (!callId) return null
    const toolCall = responseFunctionCallToToolCall(item)
    run.toolCalls.set(callId, { ...toolCall, startedAt: Date.now() })
    return {
      event: 'tool.started',
      payload: {
        event: 'tool.started',
        run_id: run.responseId,
        response_id: run.responseId,
        tool_call_id: callId,
        tool: toolCall.function.name,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        preview: summarizeToolArguments(toolCall.function.arguments),
      },
    }
  }

  if (eventType === 'response.output_item.done') {
    const item = parsed.item || parsed.output_item || parsed
    if (item.type === 'function_call') {
      const callId = item.call_id || item.id
      if (!callId) return null
      const toolCall = responseFunctionCallToToolCall(item)
      const existing = run.toolCalls.get(callId)
      run.toolCalls.set(callId, { ...toolCall, startedAt: existing?.startedAt || Date.now() })

      const key = `assistant:${callId}`
      if (!run.insertedKeys.has(key)) {
        run.insertedKeys.add(key)
        state.messages.push({
          id: state.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
          finish_reason: 'tool_calls',
          timestamp: now(),
        })
      }
      return null
    }

    if (item.type === 'function_call_output') {
      const callId = item.call_id || item.id
      if (!callId) return null
      const key = `tool:${callId}`
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      const toolCallEntry = run.toolCalls.get(callId)
      const toolName = toolCallEntry?.function?.name || null
      const startedAt = toolCallEntry?.startedAt
      const duration = startedAt ? Math.round((Date.now() - startedAt) / 10) / 100 : undefined
      const hasError = typeof item.output === 'string' && item.output.startsWith('Error')
      if (!run.insertedKeys.has(key)) {
        run.insertedKeys.add(key)
        state.messages.push({
          id: state.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'tool',
          content: output,
          tool_call_id: callId,
          tool_name: toolName,
          timestamp: now(),
        })
      }
      return {
        event: 'tool.completed',
        payload: {
          event: 'tool.completed',
          run_id: run.responseId,
          response_id: run.responseId,
          tool_call_id: callId,
          tool: toolName,
          name: toolName,
          output,
          duration,
          error: hasError || undefined,
        },
      }
    }
  }

  if (eventType === 'response.completed') {
    const response = parsed.response || parsed
    run.responseId = response.id || run.responseId
    const output = Array.isArray(response.output) ? response.output : []
    for (const item of output) {
      if (item.type === 'function_call') {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.added', { item })
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
      } else if (item.type === 'function_call_output') {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
      }
    }
  }

  return null
}

export function getResponseRunState(state: SessionState, runMarker?: string): ResponseRunState {
  if (!state.responseRun || state.responseRun.runMarker !== runMarker) {
    state.responseRun = {
      runMarker,
      insertedKeys: new Set<string>(),
      toolCalls: new Map<string, any>(),
    }
  }
  return state.responseRun
}

/** Flush all non-user messages for this run to DB in order. */
export function flushResponseRunToDb(state: SessionState, sessionId: string) {
  const run = state.responseRun
  if (!run?.runMarker) return
  let flushed = 0
  for (const msg of state.messages) {
    if (msg.runMarker !== run.runMarker) continue
    if (msg.role === 'user') continue
    addMessage({
      session_id: sessionId,
      role: msg.role,
      content: msg.content || '',
      tool_call_id: msg.tool_call_id ?? null,
      tool_calls: msg.tool_calls ?? null,
      tool_name: msg.tool_name ?? null,
      finish_reason: msg.finish_reason ?? null,
      timestamp: msg.timestamp,
    })
    flushed++
  }
  logger.info('[chat-run-socket] flushResponseRunToDb: flushed %d messages for session %s', flushed, sessionId)
}
