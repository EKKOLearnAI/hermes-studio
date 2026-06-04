import { describe, expect, it } from 'vitest'
import { cleanTtsText, clampTtsText } from '../../packages/server/src/services/hermes/tts-providers/text'

describe('tts provider text helpers', () => {
  it('removes thinking blocks, code blocks, html, and collapses spaces', () => {
    expect(cleanTtsText('<thinking>secret</thinking>Hello `code` <b>world</b>\n```ts\nx()\n```')).toBe('Hello world')
  })

  it('truncates long text with ellipsis', () => {
    expect(clampTtsText('abcdef', 5)).toBe('ab...')
  })
})
