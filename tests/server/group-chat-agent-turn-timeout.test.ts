import { afterEach, describe, expect, it } from 'vitest'
import { groupChatAgentTurnTimeoutMs } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('group chat agent turn timeout (#2386)', () => {
  const original = process.env.HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS

  afterEach(() => {
    if (original === undefined) delete process.env.HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS
    else process.env.HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS = original
  })

  it('defaults to 120s when unset', () => {
    delete process.env.HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS
    expect(groupChatAgentTurnTimeoutMs()).toBe(120_000)
  })

  it('uses a custom env value', () => {
    process.env.HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS = '300000'
    expect(groupChatAgentTurnTimeoutMs()).toBe(300_000)
  })

  it('falls back to the default for unparseable, zero, or negative values', () => {
    for (const bad of ['abc', '0', '-5', '']) {
      process.env.HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS = bad
      expect(groupChatAgentTurnTimeoutMs()).toBe(120_000)
    }
  })

  it('floors fractional values', () => {
    process.env.HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS = '150.9'
    expect(groupChatAgentTurnTimeoutMs()).toBe(150)
  })
})
