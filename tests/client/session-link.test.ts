import { describe, expect, it } from 'vitest'
import {
  buildSessionHashHref,
  buildSessionProtocolLink,
  escapeMarkdownLinkLabel,
  extractSessionIdFromReference,
  extractSessionReference,
} from '@/utils/session-link'

describe('session link helpers', () => {
  it('extracts safe session ids from protocol and markdown references', () => {
    expect(extractSessionIdFromReference('session://cli%3Adebug_01-2')).toBe('cli:debug_01-2')
    expect(extractSessionIdFromReference('[Debug session](session://cli%3Adebug_01-2)')).toBe('cli:debug_01-2')
    expect(extractSessionReference('session://cli%3Adebug_01-2?profile=cpcode')).toEqual({
      sessionId: 'cli:debug_01-2',
      profile: 'cpcode',
    })
  })

  it('rejects unsafe or invalid session references', () => {
    expect(extractSessionIdFromReference('session://bad%2Fid')).toBeNull()
    expect(extractSessionIdFromReference('session://bad%ZZid')).toBeNull()
    expect(extractSessionIdFromReference('https://example.com/session-1')).toBeNull()
  })

  it('builds safe markdown and hash links', () => {
    expect(buildSessionHashHref('cli:debug_01-2')).toBe('#/hermes/session/cli%3Adebug_01-2')
    expect(buildSessionHashHref('cli:debug_01-2', 'cpcode')).toBe('#/hermes/session/cli%3Adebug_01-2?profile=cpcode')
    expect(escapeMarkdownLinkLabel('Debug [draft]\nnext')).toBe('Debug \\[draft\\] next')
    expect(buildSessionProtocolLink('cli:debug_01-2', 'Debug [draft]\nnext', 'cpcode')).toBe(
      '[Debug \\[draft\\] next](session://cli%3Adebug_01-2?profile=cpcode)',
    )
  })
})
