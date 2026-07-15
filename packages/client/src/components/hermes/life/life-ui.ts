import type { LifeMoneyDto } from '@/api/hermes/life-orchestration'

export function lifeMoney(value: LifeMoneyDto | null): string {
  if (!value) return '—'
  return `${value.currency} ${(value.amountMinor / 100).toFixed(2)}`
}
export function lifeTime(value: string, locale: string): string {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(locale) : value
}
export function shortDigest(value: string | null): string {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : '—'
}
