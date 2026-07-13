export interface TimedHealthValue {
  at: number
  value: number
}

export interface WeightedHealthConfidence {
  confidence: number
  weight: number
}

export function roundHealthNumber(value: number, precision = 4): number | null {
  if (!Number.isFinite(value) || !Number.isSafeInteger(precision) || precision < 0 || precision > 8) return null
  const factor = 10 ** precision
  const rounded = Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

export function calculateVelocity(samples: readonly TimedHealthValue[], minimumSpanMs: number, maximumAbsolutePerDay?: number): {
  perDay: number
  sampleCount: number
  spanMs: number
} | null {
  if (!Number.isFinite(minimumSpanMs) || minimumSpanMs < 0
    || (maximumAbsolutePerDay !== undefined && (!Number.isFinite(maximumAbsolutePerDay) || maximumAbsolutePerDay <= 0)) || samples.length < 2
    || samples.some(sample => !Number.isFinite(sample.at) || !Number.isFinite(sample.value))) return null
  const ordered = [...samples].sort((left, right) => left.at - right.at || left.value - right.value)
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const spanMs = last.at - first.at
  if (spanMs <= 0 || spanMs < minimumSpanMs) return null
  const perDay = roundHealthNumber((last.value - first.value) / (spanMs / 86_400_000), 4)
  return perDay === null || (maximumAbsolutePerDay !== undefined && Math.abs(perDay) > maximumAbsolutePerDay)
    ? null : { perDay, sampleCount: ordered.length, spanMs }
}

export function rollingSum(samples: readonly TimedHealthValue[], cutoffMs: number, windowMs: number): number | null {
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(windowMs) || windowMs < 0 || samples.some(sample => !Number.isFinite(sample.at) || !Number.isFinite(sample.value))) return null
  const lower = cutoffMs - windowMs
  const selected = samples.filter(sample => sample.at >= lower && sample.at <= cutoffMs)
  if (selected.length === 0) return null
  return roundHealthNumber(selected.reduce((sum, sample) => sum + sample.value, 0), 4)
}

export function weightedConfidence(items: readonly WeightedHealthConfidence[]): number | null {
  if (items.length === 0 || items.some(item => !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
    || !Number.isFinite(item.weight) || item.weight < 0)) return null
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight <= 0) return null
  return roundHealthNumber(items.reduce((sum, item) => sum + item.confidence * item.weight, 0) / totalWeight, 4)
}
