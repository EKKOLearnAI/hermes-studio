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

  it('collects multiple closed blocks in order', () => {
    const r = parseThinking('<think>a</think>mid<thinking>b</thinking>end', { streaming: false })
    expect(r.segments).toEqual(['a', 'b'])
    expect(r.body).toBe('midend')
  })

  it('supports <thinking> and <reasoning> variants', () => {
    const r = parseThinking('<reasoning>r</reasoning>body', { streaming: false })
    expect(r.segments).toEqual(['r'])
    expect(r.body).toBe('body')
  })

  it('is case-insensitive on tag names', () => {
    const r = parseThinking('<Think>x</Think><REASONING>y</REASONING>z', { streaming: false })
    expect(r.segments).toEqual(['x', 'y'])
    expect(r.body).toBe('z')
  })

  it('returns hasThinking=false and body unchanged for plain text', () => {
    const r = parseThinking('hello world', { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe('hello world')
    expect(r.segments).toEqual([])
  })

  it('returns hasThinking=false for empty content', () => {
    const r = parseThinking('', { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe('')
  })

  it('treats trailing unclosed tag as pending when streaming', () => {
    const r = parseThinking('body<think>in-progress', { streaming: true })
    expect(r.pending).toBe('in-progress')
    expect(r.body).toBe('body')
    expect(r.segments).toEqual([])
    expect(r.hasThinking).toBe(true)
  })

  it('degrades trailing unclosed tag to body when NOT streaming (terminal state)', () => {
    const r = parseThinking('body<think>orphan', { streaming: false })
    expect(r.pending).toBeNull()
    expect(r.body).toBe('body<think>orphan')
    expect(r.segments).toEqual([])
    expect(r.hasThinking).toBe(false)
  })

  it('combines closed segments with trailing pending (streaming)', () => {
    const r = parseThinking('<think>done</think>mid<thinking>now', { streaming: true })
    expect(r.segments).toEqual(['done'])
    expect(r.pending).toBe('now')
    expect(r.body).toBe('mid')
  })

  it('does NOT recognize <think> inside fenced code block', () => {
    const src = 'before\n```\n<think>fake</think>\n```\nafter'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('does NOT recognize <think> inside tilde-fenced code block', () => {
    const src = '~~~\n<think>fake</think>\n~~~'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('does NOT recognize <think> inside inline code', () => {
    const src = 'the tag `<think>x</think>` is a literal'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('parses real <think> outside code blocks even when code blocks contain fake ones', () => {
    const src = '<think>real</think>text\n```\n<think>fake</think>\n```'
    const r = parseThinking(src, { streaming: false })
    expect(r.segments).toEqual(['real'])
    expect(r.body).toBe('text\n```\n<think>fake</think>\n```')
  })
})
