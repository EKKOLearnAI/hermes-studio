/**
 * Live stream-speed metrics for the chat composer.
 *
 * Purely additive: tracks time-to-first-token and a rolling tokens/second
 * rate for the most recent streaming run. Sessions without a recorded start
 * are ignored, so existing behavior is never affected.
 *
 * The tokens/second figure is recomputed over a 2-second sliding window by a
 * sampler interval that only runs while a stream is active.
 */
import { reactive } from 'vue'

export const streamMetrics = reactive({
  /** Time to first content token (ms), null until measured. */
  ttftMs: null as number | null,
  /** Content deltas per second over the last 2s window, null when unknown. */
  tokensPerSec: null as number | null,
  /** True while at least one content delta has been seen for the active run. */
  active: false,
})

/** Session the current metrics belong to (for multi-session UI gating). */
let metricsSession: string | null = null
export function activeStreamSession(): string | null {
  return streamMetrics.active ? metricsSession : null
}

const WINDOW_MS = 2000

let currentSession: string | null = null
let startedAt: number | null = null
let firstDeltaAt: number | null = null
let deltaTimestamps: number[] = []
let samplerId: ReturnType<typeof setInterval> | null = null

function ensureSampler(): void {
  if (samplerId !== null) return
  samplerId = setInterval(() => {
    if (!streamMetrics.active) return
    const now = performance.now()
    const windowStart = now - WINDOW_MS
    // Drop stale samples beyond a few windows to bound memory.
    deltaTimestamps = deltaTimestamps.filter(t => t >= now - WINDOW_MS * 5)
    const recent = deltaTimestamps.filter(t => t >= windowStart)
    if (recent.length === 0 || startedAt === null) {
      streamMetrics.tokensPerSec = null
      return
    }
    // Count deltas inside the SAME window used for filtering, starting no
    // earlier than the run itself so short streams ramp up correctly.
    const spanMs = Math.max(500, now - Math.max(windowStart, startedAt))
    streamMetrics.tokensPerSec = Math.round((recent.length / spanMs) * 1000)
  }, WINDOW_MS)
}

/** Record the moment a run is issued for a session. */
export function noteStreamStart(sessionId: string): void {
  if (!sessionId) return
  currentSession = sessionId
  metricsSession = sessionId
  startedAt = performance.now()
  firstDeltaAt = null
  deltaTimestamps = []
  streamMetrics.ttftMs = null
  streamMetrics.tokensPerSec = null
  streamMetrics.active = false
  ensureSampler()
}

/** Record one content delta; the first one also captures TTFT. */
export function noteStreamDelta(sessionId: string): void {
  if (!sessionId || sessionId !== currentSession || startedAt === null) return
  const now = performance.now()
  if (firstDeltaAt === null) {
    firstDeltaAt = now
    streamMetrics.ttftMs = Math.max(0, Math.round(now - startedAt))
    streamMetrics.active = true
  }
  deltaTimestamps.push(now)
}

/** Stop tracking (run completed / failed / aborted). Chip hides immediately. */
export function endStreamMetrics(): void {
  streamMetrics.active = false
  if (samplerId !== null) {
    clearInterval(samplerId)
    samplerId = null
  }
}
