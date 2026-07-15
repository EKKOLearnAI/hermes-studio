// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  CODING_AGENT_API_MODES,
  inferCodingAgentApiMode,
  normalizeCodingAgentApiMode,
} from '@/api/coding-agents'

describe('coding agent api modes', () => {
  it('only exposes scoped coding-agent protocols supported by launch flows', () => {
    expect(CODING_AGENT_API_MODES).toEqual([
      'chat_completions',
      'codex_responses',
      'anthropic_messages',
    ])
  })

  it('keeps supported provider api modes and downgrades unsupported ones', () => {
    expect(normalizeCodingAgentApiMode('anthropic_messages', 'codex_responses')).toBe('anthropic_messages')
    expect(normalizeCodingAgentApiMode('bedrock_converse', 'chat_completions')).toBe('chat_completions')
    expect(normalizeCodingAgentApiMode('codex_app_server', 'codex_responses')).toBe('codex_responses')
  })

  it('infers a safe fallback protocol from provider identity and base URL', () => {
    expect(inferCodingAgentApiMode('anthropic', 'https://api.anthropic.com')).toBe('anthropic_messages')
    expect(inferCodingAgentApiMode('deepseek', 'https://api.deepseek.com')).toBe('chat_completions')
    expect(inferCodingAgentApiMode('xiaomi', 'https://api.xiaomimimo.com/v1')).toBe('chat_completions')
    expect(inferCodingAgentApiMode('openrouter', 'https://openrouter.ai/api/v1')).toBe('chat_completions')
  })
})
