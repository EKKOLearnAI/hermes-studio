import { describe, expect, it } from 'vitest'
import { cronMatches, nextRunAfter, parseCron, parseSchedule } from '../../packages/server/src/services/hermes/cron/schedule'

describe('cron schedule parser', () => {
  it('rejects expressions without 5 fields', () => {
    expect(() => parseSchedule('0 9 * *')).toThrow()
    expect(() => parseSchedule('0 9 * * * *')).toThrow()
    expect(() => parseSchedule('')).toThrow()
  })

  it('rejects out-of-range field values', () => {
    expect(() => parseSchedule('99 9 * * *')).toThrow()
    expect(() => parseSchedule('0 9 32 * *')).toThrow()
    expect(() => parseSchedule('0 9 * 13 *')).toThrow()
  })

  it('accepts the UI quick presets', () => {
    for (const expr of ['* * * * *', '*/5 * * * *', '0 * * * *', '0 0 * * *', '0 9 * * *', '0 9 * * 1', '0 9 1 * *']) {
      expect(() => parseSchedule(expr)).not.toThrow()
    }
  })
})

describe('nextRunAfter', () => {
  it('every-minute returns the next whole minute', () => {
    const from = new Date(2026, 5, 26, 10, 30, 45)
    const next = nextRunAfter(parseSchedule('* * * * *'), from)
    expect(next).not.toBeNull()
    expect(next!.getTime()).toBe(new Date(2026, 5, 26, 10, 31, 0).getTime())
  })

  it('*/5 steps to the next multiple of five minutes', () => {
    const from = new Date(2026, 5, 26, 10, 31, 0)
    const next = nextRunAfter(parseSchedule('*/5 * * * *'), from)
    expect(next!.getMinutes()).toBe(35)
    expect(next!.getHours()).toBe(10)
  })

  it('daily 09:00 rolls to the next day when already past', () => {
    const from = new Date(2026, 5, 26, 10, 0, 0)
    const next = nextRunAfter(parseSchedule('0 9 * * *'), from)
    expect(next!.getHours()).toBe(9)
    expect(next!.getMinutes()).toBe(0)
    expect(next!.getDate()).toBe(27)
  })
})

describe('cronMatches day-of-month / day-of-week semantics', () => {
  // Build deterministic anchor dates without hardcoding weekday assumptions.
  function firstOfMonth(): Date {
    return new Date(2026, 6, 1, 0, 0, 0)
  }
  function mondayNotFirst(): Date {
    const d = new Date(2026, 6, 2, 0, 0, 0)
    while (d.getDay() !== 1 || d.getDate() === 1) d.setDate(d.getDate() + 1)
    return d
  }
  function neitherFirstNorMonday(): Date {
    const d = new Date(2026, 6, 2, 0, 0, 0)
    while (d.getDate() === 1 || d.getDay() === 1) d.setDate(d.getDate() + 1)
    return d
  }

  it('matches when EITHER dom or dow is satisfied (both restricted)', () => {
    const fields = parseCron('0 0 1 * 1') // 1st of month OR Monday
    expect(cronMatches(fields, firstOfMonth())).toBe(true)
    expect(cronMatches(fields, mondayNotFirst())).toBe(true)
    expect(cronMatches(fields, neitherFirstNorMonday())).toBe(false)
  })

  it('matches only the given dom when dow is unrestricted', () => {
    const fields = parseCron('0 0 15 * *')
    expect(cronMatches(fields, new Date(2026, 6, 15, 0, 0, 0))).toBe(true)
    expect(cronMatches(fields, new Date(2026, 6, 16, 0, 0, 0))).toBe(false)
  })

  it('normalizes day-of-week 7 to Sunday', () => {
    const fields = parseCron('0 0 * * 7')
    const sunday = new Date(2026, 6, 2, 0, 0, 0)
    while (sunday.getDay() !== 0) sunday.setDate(sunday.getDate() + 1)
    expect(cronMatches(fields, sunday)).toBe(true)
  })
})
