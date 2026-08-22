import { describe, expect, it } from 'vitest'
import { buildScheduleExpression, parseScheduleExpression } from '@/utils/schedule-frequency'

describe('schedule frequency helpers', () => {
  it.each([
    ['every-minute', '* * * * *'],
    ['every-5-minutes', '*/5 * * * *'],
    ['every-30-minutes', '*/30 * * * *'],
  ] as const)('builds the %s quick schedule', (frequency, expected) => {
    expect(buildScheduleExpression({ frequency, hour: 9, minute: 0, weekday: 1, monthDay: 1 })).toBe(expected)
  })

  it('builds configurable hourly, daily, weekly, and monthly schedules', () => {
    expect(buildScheduleExpression({ frequency: 'hourly', hour: 9, minute: 15, weekday: 1, monthDay: 1 })).toBe('15 * * * *')
    expect(buildScheduleExpression({ frequency: 'daily', hour: 8, minute: 30, weekday: 1, monthDay: 1 })).toBe('30 8 * * *')
    expect(buildScheduleExpression({ frequency: 'weekly', hour: 10, minute: 5, weekday: 3, monthDay: 1 })).toBe('5 10 * * 3')
    expect(buildScheduleExpression({ frequency: 'monthly', hour: 18, minute: 45, weekday: 1, monthDay: 20 })).toBe('45 18 20 * *')
  })

  it('parses generated expressions and known aliases back into visual fields', () => {
    expect(parseScheduleExpression('*/30 * * * *').frequency).toBe('every-30-minutes')
    expect(parseScheduleExpression('30 8 * * 3')).toMatchObject({ frequency: 'weekly', hour: 8, minute: 30, weekday: 3 })
    expect(parseScheduleExpression('@monthly')).toMatchObject({ frequency: 'monthly', hour: 0, minute: 0, monthDay: 1 })
  })

  it('keeps unsupported expressions in the advanced custom mode', () => {
    expect(parseScheduleExpression('0 9 * 1-6 1-5').frequency).toBe('custom')
    expect(parseScheduleExpression('every 90m').frequency).toBe('custom')
  })
})
