/**
 * Usage calculation — token counting from DB messages,
 * snapshot-aware computation, client notification.
 */

import {
  getSessionDetail,
} from '../../../db/hermes/session-store'
import { getCompressionSnapshot } from '../../../db/hermes/compression-snapshot'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'
import { truncateToolResultForContext } from '../../../lib/tool-result-context'
import { logger } from '../../logger'
import type { SessionState } from './types'

type UsageTokenMessage = {
  role?: string
  content?: unknown
  tool_calls?: unknown
}

function contentToUsageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (typeof block?.text === 'string') return block.text
      if (typeof block?.type === 'string') return `[${block.type}]`
      return String(block || '')
    }).join('\n')
  }
  return String(content)
}

export function estimateUsageTokensFromMessages(messages: UsageTokenMessage[]): { inputTokens: number; outputTokens: number } {
  const inputTokens = messages
    .filter(m => m.role === 'user')
    .reduce((sum, m) => sum + countTokens(contentToUsageText(m.content)), 0)
  const outputTokens = messages
    .filter(m => m.role === 'assistant' || m.role === 'tool')
    .reduce((sum, m) => sum + countTokens(contentToUsageText(m.content)) + countTokens(String(m.tool_calls || '')), 0)
  return { inputTokens, outputTokens }
}

export async function calcAndUpdateUsage(
  sid: string,
  state: SessionState,
  emit: (event: string, payload: any) => void,
  options: { truncateToolResultsForContext?: boolean } = {},
): Promise<{
  inputTokens: number
  outputTokens: number
  contextInputTokens?: number
  contextOutputTokens?: number
}> {
  try {
    const detail = getSessionDetail(sid)
    const storedMessages = detail?.messages
      ?.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool') || []
    const snapshot = getCompressionSnapshot(sid)
    const estimateSnapshotUsage = (messages: typeof storedMessages) => {
      if (snapshot && messages.length && snapshot.lastMessageIndex >= 0 && snapshot.lastMessageIndex < messages.length) {
        const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
        const newUsage = estimateUsageTokensFromMessages(newMessages)
        return {
          inputTokens: countTokens(SUMMARY_PREFIX + snapshot.summary) + newUsage.inputTokens,
          outputTokens: newUsage.outputTokens,
        }
      }
      return estimateUsageTokensFromMessages(messages)
    }
    const usage = estimateSnapshotUsage(storedMessages)
    const contextUsage = options.truncateToolResultsForContext
      ? estimateSnapshotUsage(storedMessages.map(message => message.role === 'tool'
        ? { ...message, content: truncateToolResultForContext(message.content || '') }
        : message))
      : undefined
    state.inputTokens = usage.inputTokens
    state.outputTokens = usage.outputTokens
    emit('usage.updated', {
      event: 'usage.updated',
      session_id: sid,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    return {
      ...usage,
      ...(contextUsage
        ? {
            contextInputTokens: contextUsage.inputTokens,
            contextOutputTokens: contextUsage.outputTokens,
          }
        : {}),
    }
  } catch (err: any) {
    logger.warn(err, '[chat-run-socket] failed to calculate usage for session %s', sid)
    return { inputTokens: 0, outputTokens: 0 }
  }
}

export function updateContextTokenUsage(
  sid: string,
  state: SessionState,
  emit: (event: string, payload: any) => void,
  contextTokens: number | null | undefined,
  usage?: { inputTokens: number; outputTokens: number },
): number | undefined {
  if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens) || contextTokens < 0) {
    return state.contextTokens
  }
  const normalizedContextTokens = Math.floor(contextTokens)
  state.contextTokens = normalizedContextTokens
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens: normalizedContextTokens,
  })
  return normalizedContextTokens
}

export function getCachedBridgeContextOverhead(state: SessionState): number | undefined {
  const fixedContextTokens = state.bridgeContext?.fixedContextTokens
  if (typeof fixedContextTokens !== 'number' || !Number.isFinite(fixedContextTokens) || fixedContextTokens < 0) {
    return undefined
  }
  return Math.floor(fixedContextTokens)
}

export function contextTokensWithCachedOverhead(state: SessionState, messageTokens: number): number {
  const normalizedMessageTokens = Math.max(0, Math.floor(messageTokens))
  const fixedContextTokens = getCachedBridgeContextOverhead(state)
  return fixedContextTokens == null
    ? normalizedMessageTokens
    : fixedContextTokens + normalizedMessageTokens
}

export function updateMessageContextTokenUsage(
  sid: string,
  state: SessionState,
  emit: (event: string, payload: any) => void,
  messageTokens: number | null | undefined,
  usage?: { inputTokens: number; outputTokens: number },
): number | undefined {
  if (typeof messageTokens !== 'number' || !Number.isFinite(messageTokens) || messageTokens < 0) {
    return state.contextTokens
  }
  return updateContextTokenUsage(
    sid,
    state,
    emit,
    contextTokensWithCachedOverhead(state, messageTokens),
    usage,
  )
}
