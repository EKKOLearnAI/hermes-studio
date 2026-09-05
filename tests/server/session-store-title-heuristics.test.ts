import { describe, expect, it } from 'vitest'
import { isMarkdownArtifactTitle, normalizeSessionTitleText } from '../../packages/server/src/modules/studio/repositories/session-store'

describe('isMarkdownArtifactTitle', () => {
  it('flags bare markdown decoration as an artifact', () => {
    expect(isMarkdownArtifactTitle('```')).toBe(true)
    expect(isMarkdownArtifactTitle('```json')).toBe(true)
    expect(isMarkdownArtifactTitle('##')).toBe(true)
    expect(isMarkdownArtifactTitle('—')).toBe(true)
    expect(isMarkdownArtifactTitle('')).toBe(true)
  })

  it('flags truncated raw JSON from a non-compliant provider as an artifact', () => {
    expect(isMarkdownArtifactTitle('{"title')).toBe(true)
    expect(isMarkdownArtifactTitle('{"title" #2')).toBe(true)
  })

  it('keeps real titles', () => {
    expect(isMarkdownArtifactTitle('领夹麦选购咨询')).toBe(false)
    expect(isMarkdownArtifactTitle('Fix login button on mobile')).toBe(false)
    expect(isMarkdownArtifactTitle('#1 in queue')).toBe(false)
  })

  it('normalizes whitespace and newlines', () => {
    expect(normalizeSessionTitleText('  a\n b  ')).toBe('a b')
  })
})
