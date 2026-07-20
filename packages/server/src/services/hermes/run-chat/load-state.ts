import {
  getSession,
  getSessionDetailPaginated,
} from '../../../db/hermes/session-store'
import { getRecordedUsageTotals, getUsage } from '../../../db/hermes/usage-store'
import { logger } from '../../logger'
import { handleMessage } from './message-format'
import { estimateUsageTokensFromMessages } from './usage'
import type { ChatRunSource, SessionState } from './types'

export function resolveRunSource(source?: string, sessionId?: string): ChatRunSource {
  if (source === 'coding_agent' || source === 'global_agent' || source === 'workflow' || source === 'cli') return source
  if (sessionId) {
    const stored = getSession(sessionId)?.source
    if (stored === 'coding_agent' || stored === 'global_agent' || stored === 'workflow' || stored === 'cli') return stored
  }
  return 'cli'
}

export async function loadSessionStateFromDb(sid: string, _sessionMap: Map<string, SessionState>): Promise<SessionState> {
  try {
    const displayStartedAt = Date.now()
    const actualDetail = getSessionDetailPaginated(sid)

    const messages = actualDetail?.messages ? handleMessage(actualDetail.messages, sid) : []
    const displayElapsedMs = Date.now() - displayStartedAt
    const displayPayload = {
      sessionId: sid,
      rows: actualDetail?.messages.length || 0,
      total: actualDetail?.total || 0,
      elapsedMs: displayElapsedMs,
    }
    logger.info(displayPayload, '[chat-run-socket] display page loaded')
    if (displayElapsedMs > 1_000) logger.warn(displayPayload, '[chat-run-socket] slow display page load')

    let inputTokens: number
    let outputTokens: number
    let contextTokens: number | undefined
    const session = actualDetail?.session || getSession(sid)
    const usageSource = session?.source === 'coding_agent' || ['codex', 'claude', 'claude-code', 'claude_code'].includes(session?.agent || '')
      ? 'coding_agent'
      : session?.agent === 'ekko_agent' || session?.agent === 'ekko-agent'
        ? 'ekko_agent'
        : 'hermes'
    const totals = getRecordedUsageTotals(sid, usageSource)
    const pageUsage = estimateUsageTokensFromMessages(messages)
    const latestUsage = getUsage(sid)
    const hasPersistedUsage = !!latestUsage || totals.inputTokens > 0 || totals.outputTokens > 0
    inputTokens = hasPersistedUsage ? totals.inputTokens : pageUsage.inputTokens
    outputTokens = hasPersistedUsage ? totals.outputTokens : pageUsage.outputTokens
    if (latestUsage) {
      contextTokens = Number(latestUsage.input_tokens || 0) + Number(latestUsage.output_tokens || 0)
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
