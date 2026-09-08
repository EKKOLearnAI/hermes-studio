import { describe, expect, it } from 'vitest'
import {
  formatPendingInteractionTime,
  pendingInteractionRemainingMs,
} from '../../packages/client/src/utils/pending-interaction'

describe('pending interaction countdown', () => {
  it('formats minute and hour countdowns with stable digits', () => {
    expect(formatPendingInteractionTime(0)).toBe('00:00')
    expect(formatPendingInteractionTime(60_001)).toBe('01:01')
    expect(formatPendingInteractionTime(3_661_000)).toBe('01:01:01')
  })

  it('uses a monotonic deadline and clamps the display at zero', () => {
    expect(pendingInteractionRemainingMs(1_500, 1_000)).toBe(500)
    expect(pendingInteractionRemainingMs(1_500, 2_000)).toBe(0)
  })
})
