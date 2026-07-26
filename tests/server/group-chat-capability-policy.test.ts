import { describe, expect, it } from 'vitest'

import {
  SUPPORTED_GROUP_CHAT_CAPABILITIES,
  groupChatCapabilityFlags,
  normalizeGroupChatCapabilities,
} from '../../packages/server/src/services/hermes/group-chat/identity/capability-policy'

describe('group chat capability policy', () => {
  it('uses a finite supported capability registry', () => {
    expect(SUPPORTED_GROUP_CHAT_CAPABILITIES).toEqual([
      'room.read',
      'room.write',
      'room.type',
      'room.manage',
      'agent.invoke',
      'approval.respond',
    ])
  })

  it('reports exactly the capabilities it enforces', () => {
    const decision = groupChatCapabilityFlags([
      'room.read',
      'room.type',
      'approval.respond',
      'room.read',
    ])

    expect(decision.capabilities).toEqual([
      'room.read',
      'room.type',
      'approval.respond',
    ])
    expect(decision.canRead).toBe(true)
    expect(decision.canWrite).toBe(false)
    expect(decision.canType).toBe(true)
    expect(decision.canManage).toBe(false)
    expect(decision.canInvokeAgents).toBe(false)
    expect(decision.canApprove).toBe(true)
    expect(decision.isReadOnly).toBe(false)
  })

  it('ignores unsupported grants and fails closed', () => {
    const normalized = normalizeGroupChatCapabilities([
      'room.read',
      'channel.read',
      'private-fact.read',
      'artifact.write',
      'room.read',
    ])
    const decision = groupChatCapabilityFlags([
      'channel.read',
      'private-fact.read',
      'room.read',
    ])

    expect(normalized).toEqual(['room.read'])
    expect(decision.capabilities).toEqual(['room.read'])
    expect(decision.canRead).toBe(true)
    expect(decision.canWrite).toBe(false)
    expect(decision.canType).toBe(false)
    expect(decision.canManage).toBe(false)
    expect(decision.canInvokeAgents).toBe(false)
    expect(decision.canApprove).toBe(false)
    expect(decision.isReadOnly).toBe(true)
  })
})
