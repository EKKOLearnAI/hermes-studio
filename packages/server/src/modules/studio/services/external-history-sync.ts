import {
  discoverExternalCodingAgentHistory,
  externalSessionId,
  type ExternalHistoryRoots,
} from './external-history'
import { upsertExternalCodingAgentSession } from '../public/sessions'
import { logger } from '../public/logging'

export async function syncExternalCodingAgentHistory(options: {
  profile?: string | null
  roots?: ExternalHistoryRoots
} = {}): Promise<{ sessions: number }> {
  const profile = options.profile?.trim() || 'default'
  let externalSessions
  try {
    externalSessions = await discoverExternalCodingAgentHistory(options.roots)
  } catch (err) {
    logger.warn({ err, profile }, '[external-history] discovery failed')
    return { sessions: 0 }
  }
  let synced = 0

  for (const session of externalSessions) {
    try {
      const stored = upsertExternalCodingAgentSession({
        id: externalSessionId(session.agent, session.nativeSessionId, profile),
        profile,
        agent: session.agent,
        nativeSessionId: session.nativeSessionId,
        title: session.title,
        workspace: session.workspace,
        startedAt: session.startedAt,
        lastActive: session.lastActive,
        messages: session.messages,
      })
      if (stored) synced += 1
    } catch (err) {
      logger.warn({ err, profile, agent: session.agent, nativeSessionId: session.nativeSessionId }, '[external-history] session sync failed')
    }
  }

  return { sessions: synced }
}
