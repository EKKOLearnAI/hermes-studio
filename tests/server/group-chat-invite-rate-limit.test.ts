import { describe, expect, it } from 'vitest'

import {
  GroupChatInviteAttemptLimiter,
  groupChatInviteAttemptSubjectKey,
} from '../../packages/server/src/services/hermes/group-chat/invite-attempt-limiter'

describe('group chat invite attempt limiter', () => {
  it('locks after the configured failures and expires without timers', () => {
    let now = 1_000
    const limiter = new GroupChatInviteAttemptLimiter({
      maxFailures: 2,
      windowMs: 1_000,
      lockMs: 2_000,
      now: () => now,
    })

    expect(limiter.isAllowed('subject')).toBe(true)
    limiter.recordFailure('subject')
    expect(limiter.isAllowed('subject')).toBe(true)
    limiter.recordFailure('subject')
    expect(limiter.isAllowed('subject')).toBe(false)

    now += 2_001
    expect(limiter.isAllowed('subject')).toBe(true)
    limiter.recordFailure('subject')
    expect(limiter.isAllowed('subject')).toBe(true)
    expect((limiter as any).clear).toBeUndefined()
  })

  it('preserves active penalties when the bounded map reaches capacity', () => {
    let now = 1_000
    const limiter = new GroupChatInviteAttemptLimiter({
      maxFailures: 1,
      windowMs: 1_000,
      lockMs: 2_000,
      maxEntries: 2,
      now: () => now,
    })

    limiter.recordFailure('subject-a')
    limiter.recordFailure('subject-b')
    if (limiter.isAllowed('subject-c')) limiter.recordFailure('subject-c')

    expect(limiter.isAllowed('subject-a')).toBe(false)
    expect(limiter.isAllowed('subject-b')).toBe(false)
    expect(limiter.isAllowed('subject-c')).toBe(false)

    now += 2_001
    expect(limiter.isAllowed('subject-c')).toBe(true)
  })

  it('uses opaque, stable, subject-specific keys without including network or account values', () => {
    const authKey = groupChatInviteAttemptSubjectKey(42, '192.0.2.1')
    const sameAuthKey = groupChatInviteAttemptSubjectKey(42, '198.51.100.9')
    const networkKey = groupChatInviteAttemptSubjectKey(null, '192.0.2.1')
    const localKey = groupChatInviteAttemptSubjectKey(null, '192.0.2.1', 'local:subject-a')
    const sameLocalKey = groupChatInviteAttemptSubjectKey(null, '198.51.100.9', 'local:subject-a')
    const otherLocalKey = groupChatInviteAttemptSubjectKey(null, '192.0.2.1', 'local:subject-b')
    const authWinsOverLocalKey = groupChatInviteAttemptSubjectKey(42, '203.0.113.9', 'local:subject-a')

    expect(authKey).toMatch(/^[0-9a-f]{32}$/)
    expect(authKey).toBe(sameAuthKey)
    expect(authKey).toBe(authWinsOverLocalKey)
    expect(authKey).not.toBe(networkKey)
    expect(localKey).toBe(sameLocalKey)
    expect(localKey).not.toBe(otherLocalKey)
    expect(localKey).not.toBe(networkKey)
    expect(authKey).not.toContain('42')
    expect(networkKey).not.toContain('192.0.2.1')
  })
})
