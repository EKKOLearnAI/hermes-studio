import { describe, expect, it } from 'vitest'
import { SKILL_DESCRIPTION_PREVIEW_LIMIT, skillDescriptionPreview } from '@/utils/hermes/skill-display'

describe('skill description preview helper', () => {
  it('normalizes repeated whitespace to single spaces and trims the result', () => {
    expect(skillDescriptionPreview('  Alpha\n\nBeta\t\tGamma   Delta  ')).toBe('Alpha Beta Gamma Delta')
  })

  it('returns normalized text unchanged at the default boundary', () => {
    const exactBoundary = 'a'.repeat(SKILL_DESCRIPTION_PREVIEW_LIMIT)
    expect(skillDescriptionPreview(exactBoundary)).toBe(exactBoundary)
  })

  it('truncates ASCII text within the provided character limit and appends an ellipsis', () => {
    expect(skillDescriptionPreview('alpha beta', 7)).toBe('alpha…')
  })

  it('truncates CJK and emoji text by Unicode code point without splitting surrogate pairs', () => {
    expect(skillDescriptionPreview('你好🙂世界和平', 4)).toBe('你好🙂…')
  })

  it('returns an empty string for empty, null, undefined, or whitespace-only input', () => {
    expect(skillDescriptionPreview('')).toBe('')
    expect(skillDescriptionPreview('   \n\t  ')).toBe('')
    expect(skillDescriptionPreview(null)).toBe('')
    expect(skillDescriptionPreview(undefined)).toBe('')
  })

  it('handles degenerate and non-finite limits safely', () => {
    expect(skillDescriptionPreview('hello', 1)).toBe('…')
    expect(skillDescriptionPreview('hello', 0)).toBe('')
    expect(skillDescriptionPreview('hello', -2)).toBe('')
    expect(skillDescriptionPreview('hello', Number.NaN)).toBe('')
    expect(skillDescriptionPreview('hello', Number.POSITIVE_INFINITY)).toBe('')
  })

  it('floors fractional character limits before truncation', () => {
    expect(skillDescriptionPreview('alpha beta', 2.9)).toBe('a…')
    expect(skillDescriptionPreview('alpha beta', 0.9)).toBe('')
  })
})
