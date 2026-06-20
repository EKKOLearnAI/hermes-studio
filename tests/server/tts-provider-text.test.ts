import { describe, expect, it } from 'vitest'
import { cleanTtsText, clampTtsText } from '../../packages/server/src/services/hermes/tts-providers/text'

describe('tts provider text helpers', () => {
  it('removes thinking blocks, code blocks, html, and collapses spaces', () => {
    expect(cleanTtsText('<thinking>secret</thinking>Hello `code` <b>world</b>\n```ts\nx()\n```')).toBe('Hello world')
  })

  it('preserves comparison expressions', () => {
    expect(cleanTtsText('2 < 3 and 5 > 4')).toBe('2 < 3 and 5 > 4')
  })

  it('replaces self-closing html tags with spacing', () => {
    expect(cleanTtsText('Hello<br/>world')).toBe('Hello world')
  })

  it('removes tags with quoted attributes containing angle brackets', () => {
    expect(cleanTtsText('Hello <img alt="a > b" src="x"/> world')).toBe('Hello world')
  })

  it('removes html comments', () => {
    expect(cleanTtsText('Hello <!--secret--> world')).toBe('Hello world')
  })

  it('removes html declarations', () => {
    expect(cleanTtsText('Hello <!DOCTYPE html> world')).toBe('Hello world')
  })

  it('removes custom self-closing tags', () => {
    expect(cleanTtsText('A <custom-tag/> B')).toBe('A B')
  })

  it('removes think blocks', () => {
    expect(cleanTtsText('Hello <think>secret</think> world')).toBe('Hello world')
  })

  it('keeps words separated when think blocks are adjacent to text', () => {
    expect(cleanTtsText('Hello<think>secret</think>world')).toBe('Hello world')
  })

  it('keeps words separated when fenced code blocks are adjacent to text', () => {
    expect(cleanTtsText('Hello```ts\nx()\n```world')).toBe('Hello world')
  })

  it('keeps words separated when inline code is adjacent to text', () => {
    expect(cleanTtsText('foo`code`bar')).toBe('foo bar')
  })

  it('removes unclosed fenced code blocks', () => {
    expect(cleanTtsText('Hello ```ts\nconst x = 1')).toBe('Hello')
  })

  it('removes markdown fenced code blocks while keeping surrounding prose', () => {
    expect(cleanTtsText('先说明\n```ts\nconst value = 1\n```\n再继续')).toBe('先说明 再继续')
  })

  it('keeps markdown table text for TTS', () => {
    expect(cleanTtsText('结果如下：\n| 名称 | 值 |\n| --- | --- |\n| foo | 1 |\n| bar | 2 |\n请确认。')).toBe('结果如下： | 名称 | 值 | | --- | --- | | foo | 1 | | bar | 2 | 请确认。')
  })

  it('removes emoji and decorative symbols before sending text to TTS', () => {
    expect(cleanTtsText('你好 😊🚀，开始 #1️⃣ -> ✅ done ★')).toBe('你好 ，开始 # -> done')
  })

  it('keeps normal speech punctuation and comparison expressions', () => {
    expect(cleanTtsText('价格是 $12.5，2 < 3；A+B= C。')).toBe('价格是 $12.5，2 < 3；A+B= C。')
  })

  it('removes zero-width joiner emoji sequences', () => {
    expect(cleanTtsText('开发者 👨‍💻 正在处理')).toBe('开发者 正在处理')
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
