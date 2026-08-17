import { describe, expect, it } from 'vitest'
import { handoffErrorTranslationKey, isPresentableHandoffChain } from '@/components/hermes/group-chat/handoff-presentation'
import type { RoomAgentHandoffChain } from '@/api/hermes/group-chat'

function chain(overrides: Partial<RoomAgentHandoffChain> = {}): RoomAgentHandoffChain {
  return {
    chainId: 'chain-1', roomId: 'room-1', sourceMessageId: 'source-1',
    currentDepth: 4, maxDepth: 4, unlimited: false, targetAgentId: 'agent-2',
    status: 'stopped', stopReason: 'max_depth', continueUsed: false,
    createdAt: 1, updatedAt: 1, lastError: null, ...overrides,
  }
}

describe('handoff stop presentation predicate', () => {
  it('maps backend continuation errors to localized UI keys without returning raw copy', () => {
    expect(handoffErrorTranslationKey('Continuation target admission was rejected')).toBe('groupChat.agentHandoffErrorAdmissionRejected')
    expect(handoffErrorTranslationKey('Remote target invocation outcome is unknown after restart')).toBe('groupChat.agentHandoffOutcomeUnknownDescription')
    expect(handoffErrorTranslationKey('Remote handoff outcome is unknown; automatic retry is disabled')).toBe('groupChat.agentHandoffOutcomeUnknownDescription')
    expect(handoffErrorTranslationKey('Handoff source message is no longer available')).toBe('groupChat.agentHandoffErrorGeneric')
    expect(handoffErrorTranslationKey('')).toBeNull()
    expect(handoffErrorTranslationKey('Handoff source message is no longer available')).not.toContain('Handoff source message')
  })

  it('accepts only actionable finite max-depth stops', () => {
    expect(isPresentableHandoffChain(chain())).toBe(true)
  })

  it('accepts a provenance-backed retryable continuation failure', () => {
    expect(isPresentableHandoffChain(chain({
      stopReason: 'continue_failed',
      attemptId: 'failed-attempt-1',
      lastError: 'Agent disconnected',
    }))).toBe(true)
  })

  it('presents a durable outcome-unknown chain without making it retryable', () => {
    expect(isPresentableHandoffChain(chain({
      status: 'outcome_unknown',
      stopReason: 'outcome_unknown',
      continueUsed: true,
      attemptId: 'unknown-attempt-1',
      lastError: 'Remote target invocation outcome is unknown after restart',
    }))).toBe(true)
  })

  it.each([
    ['sentinel', { currentDepth: Number.MAX_SAFE_INTEGER }],
    ['unlimited', { unlimited: true, maxDepth: null }],
    ['missing target', { targetAgentId: '' }],
    ['missing source', { sourceMessageId: '' }],
    ['failed reason without attempt provenance', { stopReason: 'continue_failed', attemptId: null }],
    ['failed reason without an error', { stopReason: 'continue_failed', attemptId: 'failed-attempt-1', lastError: null }],
    ['failed reason with an empty error', { stopReason: 'continue_failed', attemptId: 'failed-attempt-1', lastError: '' }],
    ['failed reason with a whitespace error', { stopReason: 'continue_failed', attemptId: 'failed-attempt-1', lastError: ' \t ' }],
    ['failed reason with Unicode whitespace', { stopReason: 'continue_failed', attemptId: 'failed-attempt-1', lastError: '\u00a0\u2003\u2028\ufeff' }],
    ['wrong status', { status: 'resumed' }],
    ['below limit', { currentDepth: 3 }],
  ] as const)('rejects %s records', (_label, overrides) => {
    expect(isPresentableHandoffChain(chain(overrides as Partial<RoomAgentHandoffChain>))).toBe(false)
  })
})
