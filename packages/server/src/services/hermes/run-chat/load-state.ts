import { getCompressionSnapshot } from '../../../db/hermes/compression-snapshot'
import {
  getSession,
  getSessionDetailPaginated,
} from '../../../db/hermes/session-store'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'
import { logger } from '../../logger'
import { buildDbHistory, buildSnapshotAwareHistory } from './compression'
import { handleMessage } from './message-format'
import { estimateUsageTokensFromMessages } from './usage'
import type { ChatRunSource, SessionState } from './types'

export function resolveRunSource(source?: string, sessionId?: string): ChatRunSource {
  if (source === 'coding_agent' || source === 'global_agent' || source === 'cli') return source
  if (sessionId) {
    const stored = getSession(sessionId)?.source
    if (stored === 'coding_agent' || stored === 'global_agent' || stored === 'cli') return stored
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
