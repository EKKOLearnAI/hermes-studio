import { describe, expect, it } from 'vitest'
import {
  isGlm53Model,
  normalizeReasoningEffortForModel,
} from '../../packages/server/src/services/hermes/reasoning-effort'

describe('GLM-5.3 reasoning effort normalization', () => {
  it('recognizes plain and namespaced GLM-5.3 model ids', () => {
    expect(isGlm53Model('glm-5.3')).toBe(true)
    expect(isGlm53Model('z-ai/GLM-5.3')).toBe(true)
    expect(isGlm53Model('glm-5.2')).toBe(false)
  })

  it.each([
    ['none', 'low'],
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['xhigh', 'max'],
    ['max', 'max'],
    ['ultra', 'max'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeReasoningEffortForModel('glm-5.3', input)).toBe(expected)
  })

  it('does not alter other models and preserves an empty default override', () => {
    expect(normalizeReasoningEffortForModel('gpt-5.5', 'medium')).toBe('medium')
    expect(normalizeReasoningEffortForModel('glm-5.3', '')).toBe('')
  })
})
