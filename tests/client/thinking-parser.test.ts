import { describe, it, expect } from 'vitest'
import { parseThinking } from '@/utils/thinking-parser'

describe('parseThinking', () => {
  it('splits a single closed <think> block from body', () => {
    const r = parseThinking('<think>inner</think>body', { streaming: false })
    expect(r.segments).toEqual(['inner'])
    expect(r.body).toBe('body')
    expect(r.pending).toBeNull()
    expect(r.hasThinking).toBe(true)
  })
})
