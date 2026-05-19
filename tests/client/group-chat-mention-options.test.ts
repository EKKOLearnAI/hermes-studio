import { describe, expect, it } from 'vitest'
import { buildMentionOptions } from '@/components/hermes/group-chat/mention-options'

describe('group chat mention options', () => {
  const agents = [
    { name: 'Alice', profile: 'alice-profile' },
    { name: 'Bob', profile: 'bob-profile' },
    { name: 'all', profile: 'literal-all-agent' },
  ]

  it('offers @all before agent mentions when the mention query is empty', () => {
    expect(buildMentionOptions(agents, '').map(option => option.key)).toEqual([
      'special:all',
      'agent:Alice',
      'agent:Bob',
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
    expect(buildMentionOptions(agents, 'bo').map(option => option.key)).toEqual(['agent:Bob'])
  })
})
