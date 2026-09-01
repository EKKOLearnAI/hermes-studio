import { describe, expect, it } from 'vitest'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'

describe('single chat Agent avatars', () => {
  it.each([
    ['Hermes', { agent: 'hermes' }, '/coding-agents/hermes.png'],
    ['Ekko', { agent: 'ekko-agent' }, '/coding-agents/ekko-agent.png'],
    ['Ekko', { agent: 'ekko_agent' }, '/coding-agents/ekko-agent.png'],
    ['Claude', { agent: 'claude' }, '/coding-agents/claude-code.svg'],
    ['Claude', { codingAgentId: 'claude-code' }, '/coding-agents/claude-code.svg'],
    ['Codex', { codingAgentId: 'codex' }, '/coding-agents/codex-openai.png'],
    ['Pi', { codingAgentId: 'pi' }, '/coding-agents/pi.svg'],
    ['Grok', { codingAgentId: 'grok' }, '/coding-agents/grok.svg'],
  ])('maps session identity to the $label avatar', (label, session, src) => {
    expect(chatSessionAgentAvatar(session)).toEqual({ label, src })
  })

  it('keeps legacy Coding Agent sessions without identity on the Claude avatar', () => {
    expect(chatSessionAgentAvatar({ source: 'coding_agent' })).toEqual({
      label: 'Claude',
      src: '/coding-agents/claude-code.svg',
    })
  })
})
