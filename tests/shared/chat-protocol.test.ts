import { describe, expect, it } from 'vitest'

import { normalizeToolName, sanitizeChatProtocolText } from '../../packages/shared/src/chat-protocol'

describe('chat protocol sanitizer', () => {
  it('strips screenshot-style tool protocol leakage from display text', () => {
    const leaked = '{"command":"git status --short && printf \\"\\n— branch —\\n\\" && git branch --show-current && printf \\"\\n— recent commits —\\n\\" && git log --oneline -5","timeout":60,"workdir":"/mnt/e/agents/hermes/source"}to=functions.terminal 大发彩票网 在天天中购彩票 {"command":"git status --short","timeout":60,"workdir":"/mnt/e/agents/hermes/source"}没事，先别继续散改。'

    const sanitized = sanitizeChatProtocolText(leaked)

    expect(sanitized.stripped).toBe(true)
    expect(sanitized.text).toContain('大发彩票网 在天天中购彩票')
    expect(sanitized.text).toContain('没事，先别继续散改。')
    expect(sanitized.text).not.toContain('git status')
    expect(sanitized.text).not.toContain('/mnt/e/agents/hermes/source')
    expect(sanitized.text).not.toContain('to=functions.terminal')
  })

  it('keeps fenced JSON examples visible', () => {
    const text = 'Example:\n```json\n{"command":"git status","workdir":"/tmp"}\n```\nDone.'
    const sanitized = sanitizeChatProtocolText(text)

    expect(sanitized.stripped).toBe(false)
    expect(sanitized.text).toContain('{"command":"git status","workdir":"/tmp"}')
  })

  it('normalizes function namespace tool names once', () => {
    expect(normalizeToolName('functions.terminal')).toBe('terminal')
    expect(normalizeToolName('terminal')).toBe('terminal')
  })
})
