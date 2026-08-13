import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'

import { countTextTokens } from '../../packages/ekko-agent/src/model/tokens'

describe('Ekko model token estimation', () => {
  it('keeps oversized estimation work bounded independently of input length', () => {
    const small = 'a'.repeat(8 * 1024 * 1024)
    const large = 'a'.repeat(128 * 1024 * 1024)
    const smallStart = performance.now()
    countTextTokens(small)
    const smallMs = performance.now() - smallStart
    const largeStart = performance.now()
    const largeTokens = countTextTokens(large)
    const largeMs = performance.now() - largeStart

    expect(largeTokens).toBe(large.length * 3)
    expect(largeMs).toBeLessThan(Math.max(100, smallMs * 4))
  })

  it('never underestimates fallback text relative to exact UTF-8 tokenization', async () => {
    const { getEncoding } = await import('js-tiktoken')
    const encoder = getEncoding('cl100k_base')
    for (const unit of ['a', '汉', '\u2E80', '\uD7AF', '\uFFEF', '😀']) {
      const text = `${unit} `.repeat(2_001)
      expect(countTextTokens(text)).toBeGreaterThanOrEqual(encoder.encode(text).length)
    }
  })
})