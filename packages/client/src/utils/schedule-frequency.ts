export type ScheduleFrequency =
  | 'every-minute'
  | 'every-5-minutes'
  | 'every-30-minutes'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'custom'

export interface ScheduleFrequencyFields {
  frequency: ScheduleFrequency
  hour: number
  minute: number
  weekday: number
  monthDay: number
}

export const DEFAULT_SCHEDULE_FREQUENCY_FIELDS: ScheduleFrequencyFields = {
  frequency: 'daily',
  hour: 9,
  minute: 0,
  weekday: 1,
  monthDay: 1,
}

export const SCHEDULE_HOUR_OPTIONS = Array.from({ length: 24 }, (_, value) => ({
  label: String(value).padStart(2, '0'),
  value,
}))

export const SCHEDULE_MINUTE_OPTIONS = Array.from({ length: 60 }, (_, value) => ({
  label: String(value).padStart(2, '0'),
  value,
}))

export const SCHEDULE_MONTH_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => ({
  label: String(index + 1),
  value: index + 1,
}))

export function scheduleWeekdayOptions(locale: string): Array<{ label: string; value: number }> {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' })
  const firstSunday = Date.UTC(2023, 0, 1)
  return Array.from({ length: 7 }, (_, value) => ({
    label: formatter.format(new Date(firstSunday + value * 86_400_000)),
    value,
  }))
}

const SCHEDULE_ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}

function integerField(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}

export function buildScheduleExpression(fields: ScheduleFrequencyFields): string {
  switch (fields.frequency) {
    case 'every-minute': return '* * * * *'
    case 'every-5-minutes': return '*/5 * * * *'
    case 'every-30-minutes': return '*/30 * * * *'
    case 'hourly': return `${fields.minute} * * * *`
    case 'daily': return `${fields.minute} ${fields.hour} * * *`
    case 'weekly': return `${fields.minute} ${fields.hour} * * ${fields.weekday}`
    case 'monthly': return `${fields.minute} ${fields.hour} ${fields.monthDay} * *`
    case 'custom': return ''
  }
}

export function parseScheduleExpression(schedule: string): ScheduleFrequencyFields {
  const defaults = { ...DEFAULT_SCHEDULE_FREQUENCY_FIELDS }
  const normalized = SCHEDULE_ALIASES[schedule.trim().toLowerCase()] || schedule.trim()
  const fields = normalized.split(/\s+/)
  if (fields.length !== 5) return { ...defaults, frequency: 'custom' }

  const [minuteField, hourField, monthDayField, monthField, weekdayField] = fields
  if (hourField === '*' && monthDayField === '*' && monthField === '*' && weekdayField === '*') {
    if (minuteField === '*') return { ...defaults, frequency: 'every-minute' }
    if (minuteField === '*/5') return { ...defaults, frequency: 'every-5-minutes' }
    if (minuteField === '*/30') return { ...defaults, frequency: 'every-30-minutes' }
    const minute = integerField(minuteField, 0, 59)
    if (minute !== null) return { ...defaults, frequency: 'hourly', minute }
  }

  const minute = integerField(minuteField, 0, 59)
  const hour = integerField(hourField, 0, 23)
  if (minute === null || hour === null || monthField !== '*') return { ...defaults, frequency: 'custom' }

  if (monthDayField === '*' && weekdayField === '*') {
    return { ...defaults, frequency: 'daily', hour, minute }
  }
  if (monthDayField === '*') {
    const weekday = integerField(weekdayField, 0, 6)
    if (weekday !== null) return { ...defaults, frequency: 'weekly', hour, minute, weekday }
  }
  if (weekdayField === '*') {
    const monthDay = integerField(monthDayField, 1, 31)
    if (monthDay !== null) return { ...defaults, frequency: 'monthly', hour, minute, monthDay }
  }

  return { ...defaults, frequency: 'custom' }
}
