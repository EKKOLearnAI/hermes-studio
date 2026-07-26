import { describe, expect, it } from 'vitest'
import { buildMentionOptions } from '@/components/hermes/group-chat/mention-options'

describe('group chat mention options', () => {
  const agents = [
    { id: 'row-alice', agentId: 'participant-alice', name: 'Alice', profile: 'alice-profile', runtime: 'hermes' as const },
    { id: 'row-bob', agentId: 'participant-bob', name: 'Bob', profile: 'bob-profile', runtime: 'coding_agent' as const, codingAgentId: 'codex' as const },
    { id: 'row-all', agentId: 'participant-all', name: 'all', profile: 'literal-all-agent', runtime: 'hermes' as const },
  ]

  it('offers @all before agent mentions when the mention query is empty', () => {
    expect(buildMentionOptions(agents, '').map(option => option.key)).toEqual([
      'special:all',
      'agent:participant-alice',
      'agent:participant-bob',
    ])
  })

  it('keeps @all reserved when filtering by all and hides a literal all agent', () => {
    expect(buildMentionOptions(agents, 'all')).toEqual([
      {
        key: 'special:all',
        type: 'all',
        name: 'all',
        label: '@all',
        description: 'All agents',
      },
    ])
  })

  it('filters normal agent mentions without showing @all for unrelated queries', () => {
    expect(buildMentionOptions(agents, 'bo')).toEqual([
      expect.objectContaining({
        key: 'agent:participant-bob',
        participantId: 'participant-bob',
        name: 'Bob',
        description: 'Codex · bob-profile',
      }),
    ])
  })
})
