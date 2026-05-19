/**
 * Usage calculation — token counting from DB messages,
 * snapshot-aware computation, client notification.
 */

import {
  getSessionDetail,
} from '../../../db/hermes/session-store'
import { getCompressionSnapshot } from '../../../db/hermes/compression-snapshot'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'
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
): Promise<{ inputTokens: number; outputTokens: number }> {
  try {
    const detail = getSessionDetail(sid)
    const msgs = detail?.messages
      ?.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool') || []

    const snapshot = getCompressionSnapshot(sid)
    let inputTokens: number
    let outputTokens: number
    if (snapshot && msgs.length) {
      const newMessages = msgs.slice(snapshot.lastMessageIndex + 1)
      const newUsage = estimateUsageTokensFromMessages(newMessages)
      inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
        newUsage.inputTokens
      outputTokens = newUsage.outputTokens
    } else {
      const usage = estimateUsageTokensFromMessages(msgs)
      inputTokens = usage.inputTokens
      outputTokens = usage.outputTokens
    }
    state.inputTokens = inputTokens
    state.outputTokens = outputTokens
    emit('usage.updated', {
      event: 'usage.updated',
      session_id: sid,
      inputTokens,
      outputTokens,
    })
    return { inputTokens, outputTokens }
  } catch (err: any) {
    logger.warn(err, '[chat-run-socket] failed to calculate usage for session %s', sid)
    return { inputTokens: 0, outputTokens: 0 }
  }
}
