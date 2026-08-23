/**
 * Time-to-first-token (TTFT) tracker.
 *
 * Purely additive utility: records when a chat run starts for a session and
 * reports the elapsed time when the first `message.delta` arrives. Sessions
 * with no recorded start (e.g. resumed streams) simply return null and are
 * ignored, so existing behavior is never affected.
 */

const startTimes = new Map<string, number>()

/** Record the moment a run request is issued for a session. */
export function noteRunStart(sessionId: string): void {
  if (!sessionId) return
  startTimes.set(sessionId, performance.now())
}

/**
 * Consume the TTFT for a session on its first content delta.
 * Returns milliseconds, or null when there is no pending start record.
 */
export function consumeFirstDelta(sessionId: string): number | null {
  const startedAt = startTimes.get(sessionId)
  if (startedAt === undefined) return null
  startTimes.delete(sessionId)
  return Math.max(0, Math.round(performance.now() - startedAt))
}
