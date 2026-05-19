import { describe, expect, it } from 'vitest'
import { countTokens } from '../../packages/server/src/lib/context-compressor'
import { estimateUsageTokensFromMessages } from '../../packages/server/src/services/hermes/run-chat/usage'

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
})
