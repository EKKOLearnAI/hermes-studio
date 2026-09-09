import { persistRunFailure } from '../../repositories/session-store'
import { logger } from '../../public/logging'
import type { SessionState } from './types'

export function persistSafeRunFailure(
  state: SessionState,
  sessionId: string,
  runId: string,
  error: unknown,
) {
  let failure
  try {
    failure = persistRunFailure(sessionId, runId, error)
  } catch (persistError) {
    logger.warn(persistError, '[chat-run-socket] failed to persist run failure for session %s', sessionId)
    failure = {
      id: `run-failure:${runId}`,
      runMarker: runId,
      code: 'unknown',
    }
  }
  if (!state.messages.some(message => message.role === 'run_failure' && message.runMarker === runId)) {
    state.messages.push({
      id: failure.id,
      session_id: sessionId,
      role: 'run_failure',
      content: JSON.stringify({
        code: failure.code,
        ...(failure.status ? { status: failure.status } : {}),
      }),
      runMarker: runId,
      timestamp: Date.now() / 1000,
    })
  }
  return failure
}
