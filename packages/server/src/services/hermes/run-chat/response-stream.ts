/**
 * Response stream event handling — maps upstream /v1/responses events
 * to client-facing events and updates in-memory session state.
 */

import { addMessage } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import { summarizeToolArguments, responseFunctionCallToToolCall } from './response-utils'
import type { SessionState, ResponseRunState } from './types'

function textFromResponseMessageItem(item: any): string {
  const content = Array.isArray(item?.content) ? item.content : []
  return content
    .map((part: any) => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('')
}

function reasoningTextFromEvent(parsed: any): string {
  if (typeof parsed?.delta === 'string') return parsed.delta
  if (typeof parsed?.text === 'string') return parsed.text
  if (typeof parsed?.summary === 'string') return parsed.summary
  if (typeof parsed?.reasoning === 'string') return parsed.reasoning
  if (Array.isArray(parsed?.summary)) {
    return parsed.summary
      .map((part: any) => typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : '')
      .filter(Boolean)
      .join('')
  }
  return ''
}

function isReasoningResponseItem(item: any): boolean {
  const type = String(item?.type || '')
  return type === 'reasoning' || type === 'reasoning_text' || type === 'reasoning_summary'
}

function appendedTextDelta(existing: string, next: string): string {
  if (!existing || !next) return next
  if (next.startsWith(existing)) return next.slice(existing.length)
  const max = Math.min(existing.length, next.length)
  for (let length = max; length >= 16; length--) {
    if (existing.endsWith(next.slice(0, length))) return next.slice(length)
  }
  return next
}

function appendReasoningToMessage(run: ResponseRunState, message: any, text: string): void {
  if (!text || message?.role !== 'assistant') return
  const delta = appendedTextDelta(message.reasoning || message.reasoning_content || '', text)
  if (!delta) return
  message.reasoning = `${message.reasoning || ''}${delta}`
  message.reasoning_content = `${message.reasoning_content || ''}${delta}`
  run.reasoningMessageId = message.id
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output ?? '')
  } catch {
    return String(output ?? '')
  }
}

function errorFromValue(value: unknown): string | true | undefined {
  if (value === true) return true
  if (typeof value === 'string') return value || true
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.message === 'string' && record.message) return record.message
  if (typeof record.error === 'string' && record.error) return record.error
  try {
    return JSON.stringify(record)
  } catch {
    return true
  }
}

function toolOutputError(item: any): string | true | undefined {
  const directError = errorFromValue(item?.error)
  if (directError) return directError

  const status = typeof item?.status === 'string' ? item.status.toLowerCase() : ''
  if (status === 'failed' || status === 'error' || status === 'errored') return true

  const output = item?.output
  if (typeof output === 'string') return output.startsWith('Error') ? true : undefined
  if (!output || typeof output !== 'object') return undefined

  const record = output as Record<string, unknown>
  const outputError = errorFromValue(record.error)
  if (outputError) return outputError
  if (record.is_error === true || record.ok === false) return true
  const outputStatus = typeof record.status === 'string' ? record.status.toLowerCase() : ''
  if (outputStatus === 'failed' || outputStatus === 'error' || outputStatus === 'errored') return true
  return undefined
}

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
      if (run.pendingReasoning) {
        appendReasoningToMessage(run, last, run.pendingReasoning)
        run.pendingReasoning = undefined
      }
      last.content += deltaText
    } else {
      const message = {
        id: state.messages.length + 1,
        session_id: sessionId,
        runMarker,
        role: 'assistant',
        content: deltaText,
        timestamp: now(),
        reasoning: run.pendingReasoning || null,
        reasoning_content: run.pendingReasoning || null,
      }
      state.messages.push(message)
      if (run.pendingReasoning) {
        run.reasoningMessageId = message.id
        run.pendingReasoning = undefined
      }
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

  if (
    eventType === 'response.reasoning.delta' ||
    eventType === 'response.reasoning_text.delta' ||
    eventType === 'response.reasoning_summary_text.delta'
  ) {
    const deltaText = reasoningTextFromEvent(parsed)
    if (!deltaText) return null

    const existingTarget = run.reasoningMessageId != null
      ? state.messages.find(m => m.id === run.reasoningMessageId)
      : null
    const fallbackTarget = [...state.messages].reverse().find(m =>
      m.runMarker === runMarker &&
      m.role === 'assistant' &&
      !m.tool_calls?.length,
    )
    const target = existingTarget?.role === 'assistant' ? existingTarget : fallbackTarget
    if (target) {
      appendReasoningToMessage(run, target, deltaText)
    } else {
      const delta = appendedTextDelta(run.pendingReasoning || '', deltaText)
      if (!delta) return null
      run.pendingReasoning = `${run.pendingReasoning || ''}${delta}`
    }
    return null
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

  if (eventType === 'response.function_call_arguments.delta') {
    const callId = parsed.call_id || parsed.item_id || parsed.id
    if (!callId) return null
    const existing = run.toolCalls.get(callId)
    if (!existing) return null
    const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
    if (!delta) return null
    const rawPreviousArgs = typeof existing.function?.arguments === 'string' ? existing.function.arguments : ''
    const previousArgs = rawPreviousArgs === '{}' && /^[\[{]/.test(delta.trim()) ? '' : rawPreviousArgs
    const nextToolCall = {
      ...existing,
      function: {
        ...existing.function,
        arguments: `${previousArgs}${delta}`,
      },
    }
    run.toolCalls.set(callId, nextToolCall)
    return {
      event: 'tool.started',
      payload: {
        event: 'tool.started',
        run_id: run.responseId,
        response_id: run.responseId,
        tool_call_id: callId,
        tool: nextToolCall.function.name,
        name: nextToolCall.function.name,
        arguments: nextToolCall.function.arguments,
        preview: summarizeToolArguments(nextToolCall.function.arguments),
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
      const output = stringifyToolOutput(item.output)
      const toolCallEntry = run.toolCalls.get(callId)
      const toolName = toolCallEntry?.function?.name || null
      const startedAt = toolCallEntry?.startedAt
      const duration = startedAt ? Math.round((Date.now() - startedAt) / 10) / 100 : undefined
      const error = toolOutputError(item)
      const eventName = error ? 'tool.failed' : 'tool.completed'
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
          finish_reason: error ? 'error' : null,
          timestamp: now(),
        })
      }
      return {
        event: eventName,
        payload: {
          event: eventName,
          run_id: run.responseId,
          response_id: run.responseId,
          tool_call_id: callId,
          tool: toolName,
          name: toolName,
          output,
          duration,
          error: error || undefined,
        },
      }
    }
  }

  if (eventType === 'response.completed') {
    const response = parsed.response || parsed
    run.responseId = response.id || run.responseId
    const output = Array.isArray(response.output) ? response.output : []
    for (const item of output) {
      if (item.type === 'message') {
        const finalText = textFromResponseMessageItem(item)
        if (!finalText) continue
        const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
        if (last?.role === 'assistant' && !last.tool_calls?.length) {
          if (run.pendingReasoning) {
            appendReasoningToMessage(run, last, run.pendingReasoning)
            run.pendingReasoning = undefined
          }
          if (!last.content) last.content = finalText
          last.finish_reason = last.finish_reason || 'stop'
        } else {
          const message = {
            id: state.messages.length + 1,
            session_id: sessionId,
            runMarker,
            role: 'assistant',
            content: finalText,
            finish_reason: 'stop',
            timestamp: now(),
            reasoning: run.pendingReasoning || null,
            reasoning_content: run.pendingReasoning || null,
          }
          state.messages.push(message)
          if (run.pendingReasoning) {
            run.reasoningMessageId = message.id
            run.pendingReasoning = undefined
          }
        }
      } else if (item.type === 'function_call') {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.added', { item })
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
      } else if (item.type === 'function_call_output') {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
      } else if (isReasoningResponseItem(item)) {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.reasoning.delta', item)
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
      reasoning: msg.reasoning ?? null,
      reasoning_content: msg.reasoning_content ?? null,
      timestamp: msg.timestamp,
    })
    flushed++
  }
  logger.info('[chat-run-socket] flushResponseRunToDb: flushed %d messages for session %s', flushed, sessionId)
}
