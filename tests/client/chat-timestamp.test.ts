import { describe, expect, it } from 'vitest'
import { formatChatTimestamp, isSameLocalDay } from '@/utils/chat-timestamp'

describe('chat timestamp formatting', () => {
  it('shows only hour and minute for messages from today', () => {
    const now = new Date('2026-06-18T15:30:00')
    const messageTime = new Date('2026-06-18T09:05:00')

    expect(isSameLocalDay(messageTime, now)).toBe(true)
    expect(formatChatTimestamp(messageTime, { now, locale: 'en-US' })).toBe('09:05 AM')
  })

  it('adds month and day for previous-day messages in the same year', () => {
    const now = new Date('2026-06-18T15:30:00')
    const messageTime = new Date('2026-06-17T22:15:00')

    expect(formatChatTimestamp(messageTime, { now, locale: 'en-US' })).toBe('06/17, 10:15 PM')
  })

  it('adds year for messages from a different year', () => {
    const now = new Date('2026-06-18T15:30:00')
    const messageTime = new Date('2025-12-31T23:59:00')

    expect(formatChatTimestamp(messageTime, { now, locale: 'en-US' })).toBe('12/31/2025, 11:59 PM')
  })

  it('returns an empty string for invalid timestamps', () => {
    expect(formatChatTimestamp('not a date')).toBe('')
  })
})
