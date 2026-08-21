import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('approval lifecycle source contract - #2558', () => {
  it('preserves authoritative bridge resolution metadata through chat-run', () => {
    const source = readFileSync(
      'packages/server/src/services/hermes/run-chat/handle-bridge-run.ts',
      'utf8',
    )

    expect(source).toContain('resolved: ev.resolved === true')
    expect(source).toContain("ev.expired === true ? { expired: true }")
    expect(source).toContain("ev.stale === true ? { stale: true }")
    expect(source).toContain('String(ev.error || ev.reason)')
  })
})
