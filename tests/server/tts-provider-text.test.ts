import { describe, expect, it } from 'vitest'
import { cleanTtsText, clampTtsText } from '../../packages/server/src/services/hermes/tts-providers/text'

describe('tts provider text helpers', () => {
  it('removes thinking blocks, code blocks, html, and collapses spaces', () => {
    expect(cleanTtsText('<thinking>secret</thinking>Hello `code` <b>world</b>\n```ts\nx()\n```')).toBe('Hello world')
  })

  it('preserves comparison expressions', () => {
    expect(cleanTtsText('2 < 3 and 5 > 4')).toBe('2 < 3 and 5 > 4')
  })

  it('removes think blocks', () => {
    expect(cleanTtsText('Hello <think>secret</think> world')).toBe('Hello world')
  })

  it('removes unclosed fenced code blocks', () => {
    expect(cleanTtsText('Hello ```ts\nconst x = 1')).toBe('Hello')
  })

  it('returns an empty string for empty input', () => {
    expect(cleanTtsText('')).toBe('')
  })

  it('truncates long text with ellipsis', () => {
    expect(clampTtsText('abcdef', 5)).toBe('ab...')
  })

  it('returns only an ellipsis when max chars is 3', () => {
    expect(clampTtsText('abcdef', 3)).toBe('...')
  })
})
