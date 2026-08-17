import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestGroupChatServer } from './group-chat-test-helpers'

describe('group chat handoff actionable-chain guard', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>

  beforeEach(async () => {
    harness = await createTestGroupChatServer()
    const storage = harness.groupServer.getStorage()
    storage.saveRoom('room-1', 'Room', 'ROOM1', {
      agentHandoffEnabled: true,
      agentHandoffMaxDepth: 4,
      agentHandoffUnlimited: false,
    })
    storage.addRoomAgent('room-1', 'agent-2', 'default', 'Target', '', 0)
    harness.db.prepare(`INSERT INTO gc_messages
      (id, roomId, senderId, senderName, content, timestamp, persistedAt, mentions, role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('source-1', 'room-1', 'agent-1', 'Source', '@Target', 1, 1,
        JSON.stringify([{ type: 'agent', participantId: 'agent-2' }]), 'assistant')
  })

  afterEach(() => harness?.cleanup())

  function addChain(id: string) {
    harness.groupServer.getStorage().recordHandoffStop(
      'room-1', id, 'source-1', 4, 'agent-2',
      { enabled: true, maxDepth: 4, unlimited: false },
    )
  }

  function assertRejected(id: string) {
    const storage = harness.groupServer.getStorage()
    const beforeAttempts = harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts').get()
    const beforeOutbox = harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_outbox').get()
    expect(storage.getStoppedHandoffChains('room-1').some((row: any) => row.chainId === id)).toBe(false)
    expect(storage.claimHandoffContinuation('room-1', id)).toBeNull()
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts').get()).toEqual(beforeAttempts)
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_outbox').get()).toEqual(beforeOutbox)
  }

  it.each([
    ['wrong-reason', "stopReason = 'continue_failed'"],
    ['wrong-status', "status = 'resumed'"],
    ['unlimited', 'unlimited = 1, maxDepth = NULL'],
    ['below-limit', 'currentDepth = 3'],
    ['sentinel', `currentDepth = ${Number.MAX_SAFE_INTEGER}`],
    ['fractional-current', 'currentDepth = 4.5'],
    ['fractional-max', 'maxDepth = 3.5'],
    ['zero-max', 'maxDepth = 0'],
    ['text-current', "currentDepth = 'four'"],
    ['text-max', "maxDepth = 'four'"],
    ['missing-source', "sourceMessageId = 'absent'"],
    ['missing-target', "targetAgentId = ''"],
    ['unknown-target', "targetAgentId = 'absent-agent'"],
  ])('rejects hidden malformed row %s', (id, mutation) => {
    addChain(id)
    harness.db.prepare(`UPDATE gc_handoff_chains SET ${mutation} WHERE chainId = ?`).run(id)
    assertRejected(id)
  })

  it.each([
    ['disabled', { agentHandoffEnabled: false, agentHandoffMaxDepth: 4, agentHandoffUnlimited: false }],
    ['currently-unlimited', { agentHandoffEnabled: true, agentHandoffMaxDepth: null, agentHandoffUnlimited: true }],
    ['changed-finite-limit', { agentHandoffEnabled: true, agentHandoffMaxDepth: 6, agentHandoffUnlimited: false }],
  ])('rejects a stale stop when the Room policy is %s', (_name, policy) => {
    addChain(`policy-${_name}`)
    harness.groupServer.getStorage().updateRoomConfig('room-1', policy)
    assertRejected(`policy-${_name}`)
  })

  it('allows a legitimate stop under the resolved default finite policy', () => {
    addChain('default-policy')
    harness.groupServer.getStorage().updateRoomConfig('room-1', {
      agentHandoffEnabled: true,
      agentHandoffMaxDepth: null,
      agentHandoffUnlimited: false,
    })
    const storage = harness.groupServer.getStorage()
    expect(storage.getRoomAgentHandoffPolicy('room-1')).toEqual({ enabled: true, maxDepth: 4, unlimited: false })
    expect(storage.getStoppedHandoffChains('room-1').map((row: any) => row.chainId)).toContain('default-policy')
    expect(storage.claimHandoffContinuation('room-1', 'default-policy')).toMatchObject({ status: 'claimed' })
  })

  it.each([
    ['null', 'NULL'],
    ['empty', "''"],
    ['spaces', "'   '"],
    ['tab', "char(9)"],
    ['line-feed', "char(10)"],
    ['carriage-return', "char(13)"],
    ['mixed-whitespace', "' ' || char(9) || char(10) || char(13)"],
    ['vertical-tab', "char(11)"],
    ['form-feed', "char(12)"],
    ['no-break-space', "char(160)"],
    ['ogham-space-mark', "char(5760)"],
    ['en-quad', "char(8192)"],
    ['em-quad', "char(8193)"],
    ['en-space', "char(8194)"],
    ['em-space', "char(8195)"],
    ['three-per-em-space', "char(8196)"],
    ['four-per-em-space', "char(8197)"],
    ['six-per-em-space', "char(8198)"],
    ['figure-space', "char(8199)"],
    ['punctuation-space', "char(8200)"],
    ['thin-space', "char(8201)"],
    ['hair-space', "char(8202)"],
    ['line-separator', "char(8232)"],
    ['paragraph-separator', "char(8233)"],
    ['narrow-no-break-space', "char(8239)"],
    ['medium-mathematical-space', "char(8287)"],
    ['ideographic-space', "char(12288)"],
    ['zero-width-no-break-space', "char(65279)"],
  ])('rejects a retryable failure whose chain lastError is %s', (_label, sqlValue) => {
    addChain(`dirty-error-${_label}`)
    const storage = harness.groupServer.getStorage()
    const claimed = storage.claimHandoffContinuation('room-1', `dirty-error-${_label}`)!
    expect(storage.failHandoffContinuation('room-1', `dirty-error-${_label}`, 'Agent disconnected')).toMatchObject({
      status: 'stopped',
      stopReason: 'continue_failed',
      attemptId: claimed.attemptId,
    })
    harness.db.prepare(`UPDATE gc_handoff_chains SET lastError = ${sqlValue} WHERE chainId = ?`)
      .run(`dirty-error-${_label}`)
    assertRejected(`dirty-error-${_label}`)
  })

  it('allows a legitimate max-depth row to be claimed once', () => {
    addChain('valid')
    const storage = harness.groupServer.getStorage()
    expect(storage.getStoppedHandoffChains('room-1').map((row: any) => row.chainId)).toContain('valid')
    expect(storage.claimHandoffContinuation('room-1', 'valid')).toMatchObject({ status: 'claimed' })
    expect(storage.claimHandoffContinuation('room-1', 'valid')).toBeNull()
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts WHERE chainId = ?').get('valid')).toEqual({ count: 1 })
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_outbox').get()).toEqual({ count: 1 })
  })
})
