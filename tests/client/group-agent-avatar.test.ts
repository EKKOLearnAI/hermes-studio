import { describe, expect, it } from 'vitest'
import { defaultGroupAgentAvatar, groupAgentAvatar, parseStoredAvatar } from '@/utils/group-agent-avatar'

describe('group agent avatars', () => {
  it('parses generated and uploaded room-agent avatars', () => {
    expect(parseStoredAvatar(JSON.stringify({ type: 'generated', seed: 'agent-seed' }))).toEqual({
      type: 'generated',
      seed: 'agent-seed',
    })
    expect(parseStoredAvatar(JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,abc' }))).toEqual({
      type: 'image',
      dataUrl: 'data:image/png;base64,abc',
    })
  })

  it('falls back to the matching single-chat agent icon', () => {
    expect(defaultGroupAgentAvatar('hermes').dataUrl).toBe('/coding-agents/hermes.png')
    expect(defaultGroupAgentAvatar('ekko').dataUrl).toBe('/coding-agents/ekko-agent.png')
    expect(defaultGroupAgentAvatar('codex').dataUrl).toBe('/coding-agents/codex-openai.png')
    expect(defaultGroupAgentAvatar('claude').dataUrl).toBe('/coding-agents/claude-code.svg')
    expect(groupAgentAvatar({ agent: 'codex', avatar: '' }).dataUrl).toBe('/coding-agents/codex-openai.png')
  })
})
