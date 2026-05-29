import { describe, expect, it } from 'vitest'
import { countTokens } from '../../packages/server/src/lib/context-compressor'
import {
  estimateGroupHistoryMessageTokens,
  groupBridgeReasoningDeltaFromEvent,
  groupContextTokensWithFixedOverhead,
} from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('group chat fixed context cache helpers', () => {
  it('adds cached fixed context to group chat message tokens', () => {
    const history = [
      { role: 'user', content: '[Alice]: hello' },
      { role: 'assistant', content: '[Bot]: hi there' },
    ]

    const messageTokens = estimateGroupHistoryMessageTokens(history)

    expect(messageTokens).toBe(countTokens('[Alice]: hello') + countTokens('[Bot]: hi there'))
    expect(groupContextTokensWithFixedOverhead(20_000, history)).toBe(20_000 + messageTokens)
  })

  it('signals fallback when fixed context is unavailable', () => {
    expect(groupContextTokensWithFixedOverhead(undefined, [{ content: 'hello' }])).toBeUndefined()
    expect(groupContextTokensWithFixedOverhead(null, [{ content: 'hello' }])).toBeUndefined()
  })

  it('keeps spinner thinking events out of persisted group-chat reasoning', () => {
    expect(groupBridgeReasoningDeltaFromEvent({
      event: 'thinking.delta',
      text: '(◕‿◕✿) pondering...',
    })).toBeNull()
    expect(groupBridgeReasoningDeltaFromEvent({
      event: 'reasoning.delta',
      text: 'real reasoning',
    })).toBe('real reasoning')
    expect(groupBridgeReasoningDeltaFromEvent({
      event: 'reasoning.delta',
      text: '',
    })).toBeNull()
  })
})
