import { describe, expect, it, vi } from 'vitest'
import { countTokens } from '../../packages/server/src/lib/context-compressor'
import {
  contextTokensWithCachedOverhead,
  estimateUsageTokensFromMessages,
  updateMessageContextTokenUsage,
} from '../../packages/server/src/services/hermes/run-chat/usage'

describe('run-chat usage token estimates', () => {
  it('counts message content instead of serialized message payloads', () => {
    const messages = [
      { role: 'user', content: 'hello from user' },
      { role: 'assistant', content: 'hello from assistant' },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(countTokens('hello from user'))
    expect(usage.outputTokens).toBe(countTokens('hello from assistant'))
    expect(usage.inputTokens + usage.outputTokens).toBeLessThan(countTokens(JSON.stringify(messages)))
  })

  it('keeps assistant tool call tokens on the output side', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'calling tool',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(countTokens('calling tool') + countTokens(String(messages[0].tool_calls || '')))
  })

  it('adds cached bridge fixed context when updating full context usage', () => {
    const emit = vi.fn()
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [],
      bridgeContext: { fixedContextTokens: 20_000 },
    } as any

    const contextTokens = updateMessageContextTokenUsage(
      'session-1',
      state,
      emit,
      1_569,
      { inputTokens: 1_200, outputTokens: 369 },
    )

    expect(contextTokens).toBe(21_569)
    expect(state.contextTokens).toBe(21_569)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      session_id: 'session-1',
      inputTokens: 1_200,
      outputTokens: 369,
      contextTokens: 21_569,
    }))
  })

  it('falls back to message tokens when bridge fixed context is missing', () => {
    const emit = vi.fn()
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [],
    } as any

    expect(contextTokensWithCachedOverhead(state, 1_569)).toBe(1_569)

    const contextTokens = updateMessageContextTokenUsage(
      'session-1',
      state,
      emit,
      1_569,
      { inputTokens: 1_200, outputTokens: 369 },
    )

    expect(contextTokens).toBe(1_569)
    expect(state.contextTokens).toBe(1_569)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      contextTokens: 1_569,
    }))
  })
})
