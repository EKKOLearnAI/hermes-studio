import { describe, expect, it } from 'vitest'
import {
  isAllAgentsMentioned,
  isAgentMentioned,
  isReservedMentionName,
  resolveMentionTargets,
  stripMentionRoutingTokens,
} from '../../packages/server/src/services/hermes/group-chat/mention-routing'

type TestAgent = { name: string; id?: string; agentId?: string; profile?: string }

const agents: TestAgent[] = [
  { name: 'Alice', id: 'socket-alice', agentId: 'agent-alice' },
  { name: 'Bob', id: 'socket-bob', agentId: 'agent-bob' },
  { name: 'Regex.Bot', id: 'socket-regex', agentId: 'agent-regex' },
]

describe('group chat mention routing', () => {
  it('reserves @all so it cannot be confused with a literal agent name', () => {
    expect(isReservedMentionName('all')).toBe(true)
    expect(isReservedMentionName(' ALL ')).toBe(true)
    expect(isReservedMentionName('Alice')).toBe(false)
  })

  it('recognizes @all as a standalone mention with safe boundaries', () => {
    expect(isAllAgentsMentioned('@all please compare notes')).toBe(true)
    expect(isAllAgentsMentioned('please compare notes @ALL')).toBe(true)
    expect(isAllAgentsMentioned('@all, compare notes')).toBe(true)
    expect(isAllAgentsMentioned('email user@all.example')).toBe(false)
    expect(isAllAgentsMentioned('@alligator should not notify everyone')).toBe(false)
    expect(isAllAgentsMentioned('prefix@all should not notify everyone')).toBe(false)
  })

  it('keeps exact agent mentions boundary-aware and regex-safe', () => {
    expect(isAgentMentioned('@Regex.Bot please review', 'Regex.Bot')).toBe(true)
    expect(isAgentMentioned('@RegexxBot should not match', 'Regex.Bot')).toBe(false)
    expect(isAgentMentioned('@Alice, please review', 'Alice')).toBe(true)
    expect(isAgentMentioned('mailto@Alice.example', 'Alice')).toBe(false)
  })

  it('routes @all to every room agent except the sender identity', () => {
    expect(resolveMentionTargets(agents, '@all summarize the options', 'socket-alice').map(a => a.name)).toEqual(['Bob', 'Regex.Bot'])
  })

  it('keeps same-name human senders routable because sender exclusion uses identity, not display name', () => {
    const sameNameAgents: TestAgent[] = [
      { name: 'test', id: 'socket-agent-test', agentId: 'agent-test' },
      { name: 'tt', id: 'socket-agent-tt', agentId: 'agent-tt' },
    ]

    expect(resolveMentionTargets(sameNameAgents, '@all can you talk to me?', 'human-test-user').map(a => a.name)).toEqual(['test', 'tt'])
    expect(resolveMentionTargets(sameNameAgents, '@test why no response?', 'human-test-user').map(a => a.name)).toEqual(['test'])
  })

  it('still excludes an agent from routing to itself when the sender identity matches that agent', () => {
    const sameNameAgents: TestAgent[] = [
      { name: 'test', id: 'socket-agent-test', agentId: 'agent-test' },
      { name: 'tt', id: 'socket-agent-tt', agentId: 'agent-tt' },
    ]

    expect(resolveMentionTargets(sameNameAgents, '@all compare plans', 'socket-agent-test').map(a => a.name)).toEqual(['tt'])
    expect(resolveMentionTargets(sameNameAgents, '@all compare plans', 'agent-test').map(a => a.name)).toEqual(['tt'])
    expect(resolveMentionTargets(sameNameAgents, '@test check yourself', 'socket-agent-test').map(a => a.name)).toEqual([])
  })

  it('routes explicit mentions without treating partial @all text as broadcast', () => {
    expect(resolveMentionTargets(agents, '@Bob and @Regex.Bot compare plans', 'socket-alice').map(a => a.name)).toEqual(['Bob', 'Regex.Bot'])
    expect(resolveMentionTargets(agents, '@alligator and @Bob compare plans', 'socket-alice').map(a => a.name)).toEqual(['Bob'])
  })

  it('dedupes mixed @all and explicit mentions', () => {
    expect(resolveMentionTargets(agents, '@all @Bob compare plans', 'socket-alice').map(a => a.name)).toEqual(['Bob', 'Regex.Bot'])
  })

  it('strips the broadcast token and this agent mention before routing to the model', () => {
    expect(stripMentionRoutingTokens('@all @Bob please review', 'Bob')).toBe('please review')
    expect(stripMentionRoutingTokens('@ALL, @Regex.Bot: please review', 'Regex.Bot')).toBe('please review')
    expect(stripMentionRoutingTokens('@all please review', 'all')).toBe('please review')
  })
})
