export type MobileHealthMetric = 'steps' | 'sleep' | 'heart_rate' | 'workouts'

export type MobileHealthRequest = {
  purpose: string
  metrics: MobileHealthMetric[]
  start_ms: number
  end_ms: number
  limit: number
}

export type MobileHealthResponse = (
  | { status: 'success'; result: { startMs: number; endMs: number; metrics: Partial<Record<MobileHealthMetric, unknown>> } }
  | { status: 'denied' }
  | { status: 'error'; error: { code: string } }
) & { device_id?: string }

const METRICS = new Set<MobileHealthMetric>(['steps', 'sleep', 'heart_rate', 'workouts'])
const ERRORS = new Set(['health_permission_denied', 'health_unavailable', 'health_invalid_request', 'health_timeout', 'health_failed'])
const MAX_RANGE_MS = 31 * 24 * 60 * 60_000
const MIN_TIME_MS = Date.UTC(2001, 0, 1)

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeMobileHealthRequest(value: Record<string, unknown>): MobileHealthRequest {
  const purpose = String(value.purpose || '').trim().slice(0, 240)
  if (!purpose) throw new Error('purpose is required')
  const rawMetrics = Array.isArray(value.metrics) ? value.metrics.map(metric => String(metric).trim().toLowerCase()) : []
  if (!rawMetrics.length || rawMetrics.some(metric => !METRICS.has(metric as MobileHealthMetric))) {
    throw new Error('metrics must contain only steps, sleep, heart_rate, or workouts')
  }
  const startMs = finite(value.start_ms)
  const endMs = finite(value.end_ms)
  if (startMs == null || endMs == null || startMs < MIN_TIME_MS || endMs <= startMs || endMs > Date.now() || endMs - startMs > MAX_RANGE_MS) {
    throw new Error('A valid health date range of at most 31 days is required')
  }
  const limit = Math.round(Number(value.limit))
  return {
    purpose,
    metrics: [...new Set(rawMetrics)] as MobileHealthMetric[],
    start_ms: startMs,
    end_ms: endMs,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 50,
  }
}

function interval(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null
  const startMs = finite(value.startMs)
  const endMs = finite(value.endMs)
  if (startMs == null || endMs == null || endMs <= startMs) return null
  const output: Record<string, unknown> = { startMs, endMs }
  for (const key of ['stage', 'activityType', 'durationSeconds']) {
    const number = finite(value[key])
    if (number != null && number >= 0) output[key] = number
  }
  if (Array.isArray(value.stages)) output.stages = value.stages.slice(0, 100).map(interval).filter(Boolean)
  return output
}

export function normalizeMobileHealthResponse(value: unknown, expected: MobileHealthRequest): MobileHealthResponse | null {
  if (!record(value)) return null
  const status = String(value.status || '')
  if (status === 'denied') return { status: 'denied' }
  if (status === 'error') {
    const code = record(value.error) ? String(value.error.code || '') : ''
    return { status: 'error', error: { code: ERRORS.has(code) ? code : 'health_failed' } }
  }
  if (status !== 'success' || !record(value.result) || !record(value.result.metrics)) return null
  if (value.result.startMs !== expected.start_ms || value.result.endMs !== expected.end_ms) return null
  const metrics: Partial<Record<MobileHealthMetric, unknown>> = {}
  for (const metric of expected.metrics) {
    const raw = value.result.metrics[metric]
    if (metric === 'steps') {
      const total = record(raw) ? finite(raw.total) : null
      if (total == null || total < 0) return null
      metrics.steps = { total: Math.round(total) }
    } else if (metric === 'heart_rate') {
      if (!record(raw)) return null
      const cleaned: Record<string, number> = {}
      for (const key of ['average', 'minimum', 'maximum']) {
        const number = finite(raw[key])
        if (number != null && number >= 0 && number <= 400) cleaned[key] = number
      }
      metrics.heart_rate = cleaned
    } else {
      if (!Array.isArray(raw)) return null
      metrics[metric] = raw.slice(0, expected.limit).map(interval).filter(Boolean)
    }
  }
  return { status: 'success', result: { startMs: expected.start_ms, endMs: expected.end_ms, metrics } }
}
